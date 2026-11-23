import { z } from 'zod';
import type { NavNode } from './nav';
import { driveTowards, handleStuck, resetAiState } from './ai';
import { forwardSpeed } from './vehicle';
import { districtAt } from './citygen';
import { pickTrafficVariant } from './roster';
import type { Vehicle, World } from './world';

export const TrafficConfigSchema = z.object({
  /** Moving traffic kept alive around the player. */
  count: z.number().int().nonnegative(),
  variants: z.array(z.string()).min(1),
  /** Cruising speed on streets and on avenues (m/s); each driver varies it a little. */
  cruiseSpeed: z.number().positive(),
  avenueSpeed: z.number().positive().default(16),
  cornerSpeed: z.number().positive(),
  cornerSlowDist: z.number().nonnegative(),
  minGap: z.number().positive(),
  timeHeadway: z.number().positive(),
  lookAheadBase: z.number().positive(),
  lookAheadPerSpeed: z.number().nonnegative(),
  detectRange: z.number().positive(),
  laneHalfWidth: z.number().positive(),
  /** Traffic appears between these distances from the player and vanishes beyond despawnDist. */
  respawnMinDist: z.number().nonnegative(),
  spawnMaxDist: z.number().positive().default(190),
  despawnDist: z.number().positive().default(250),
  stuckSec: z.number().positive(),
  /** Abandoned (stolen then left) cars out of range for this long are recycled. */
  abandonedDespawnSec: z.number().positive(),
  /** Most wrecks left in the world at once; the oldest beyond this is cleared even if nearby. */
  maxWrecks: z.number().int().nonnegative(),
  aiHz: z.number().positive(),
  /** Traffic lights at junctions: seconds of green and amber per axis, and all-red between. */
  lights: z.object({ green: z.number().positive(), amber: z.number().nonnegative(), allRed: z.number().nonnegative() }).default({ green: 9, amber: 2.5, allRed: 1.5 }),
  /** At a red light the front bumper stops this far short of the junction box (behind the zebra crossing). */
  stopLine: z.number().nonnegative().default(4.6),
  /** Parked cars are streamed in within this distance of the player, out beyond parkedOutDist. */
  parkedInDist: z.number().positive().default(120),
  parkedOutDist: z.number().positive().default(170),
  parkedMax: z.number().int().nonnegative().default(26),
});
export type TrafficConfig = z.infer<typeof TrafficConfigSchema>;

export type LightState = 'green' | 'amber' | 'red';

/** The signal facing traffic on an axis at a junction. Every junction runs its own offset cycle. */
export function trafficLight(node: NavNode, alongX: boolean, time: number, cfg: TrafficConfig['lights']): LightState {
  const half = cfg.green + cfg.amber + cfg.allRed;
  const cycle = half * 2;
  const t = (((time + ((node.id * 7.31) % cycle)) % cycle) + cycle) % cycle;
  const local = alongX ? t : (t + half) % cycle;
  if (local < cfg.green) return 'green';
  if (local < cfg.green + cfg.amber) return 'amber';
  return 'red';
}

/**
 * Civilian traffic on the road graph: cars keep to the right-hand lane, pick a
 * turn at each junction, stop at red lights, follow the car in front and get
 * out of the way of trouble. Only the streets around the player are populated:
 * cars appear out of view and disappear far behind. Kerbside parked cars are
 * streamed in and out the same way. Decisions tick at aiHz, staggered by id.
 */
export class TrafficSystem {
  /** Active traffic cap (quality tiers lower it). */
  cap: number;
  private respawnCooldown = 0;
  private parkTimer = 0;
  /** Vehicle id parked at each parking spot, or -1. */
  private readonly spotCar: Int32Array;
  /** Spot whose car was driven away: left empty until the player is far off. */
  private readonly spotGone: Uint8Array;
  private readonly driveEdges: number[];

  constructor(
    private readonly world: World,
    public config: TrafficConfig,
  ) {
    this.cap = config.count;
    const n = world.content.map.parking.length;
    this.spotCar = new Int32Array(n).fill(-1);
    this.spotGone = new Uint8Array(n);
    this.driveEdges = world.roads.edges.filter((e) => e.kind !== 'alley').map((e) => e.id);
  }

  /** Fill the streets around the player at the start. */
  populate(): void {
    this.streamParked(true);
    for (let i = 0; i < this.cap * 3 && this.activeCount() < this.cap; i++) this.spawnNear(25, this.config.spawnMaxDist, false);
  }

  activeCount(): number {
    let n = 0;
    for (const v of this.world.vehicles) if (v.active && v.role === 'traffic') n++;
    return n;
  }

  /** Spawn one car on a random lane between rMin and rMax from the player. */
  private spawnNear(rMin: number, rMax: number, outOfView: boolean): Vehicle | null {
    const w = this.world;
    const g = w.roads;
    const px = w.player.x;
    const pz = w.player.z;
    for (let tries = 0; tries < 60; tries++) {
      const e = g.edges[w.rng.pick(this.driveEdges)]!;
      const forward = w.rng.next() < 0.5;
      const a = g.nodes[forward ? e.a : e.b]!;
      const b = g.nodes[forward ? e.b : e.a]!;
      const t = w.rng.range(0.25, 0.75);
      const dx = (b.x - a.x) / e.length;
      const dz = (b.z - a.z) / e.length;
      const off = e.width / 4;
      const x = a.x + (b.x - a.x) * t - dz * off;
      const z = a.z + (b.z - a.z) * t + dx * off;
      const d = Math.hypot(x - px, z - pz);
      if (d < rMin || d > rMax) continue;
      // Out of view: the camera looks down on about 60 m around the player, further ahead.
      if (outOfView && d < 140 && Math.abs(x - px) < 75 && z - pz > -95 && z - pz < 55) continue;
      let blocked = false;
      for (const v of w.vehicles) if (v.active && Math.hypot(v.x - x, v.z - z) < 12) blocked = true;
      if (blocked) continue;
      const yaw = Math.atan2(dx, dz);
      const v = w.spawnVehicle(this.pickVariant(x, z), x, z, yaw, 'traffic');
      if (!v) return null;
      resetAiState(v.ai);
      v.ai.mode = 'drive';
      v.ai.navFrom = a.id;
      v.ai.navTo = b.id;
      v.ai.navNext = -1;
      const base = e.kind === 'avenue' || e.kind === 'bridge' ? this.config.avenueSpeed : this.config.cruiseSpeed;
      v.ai.cruise = base * w.rng.range(0.82, 1.15);
      v.vx = dx * v.ai.cruise * 0.7;
      v.vz = dz * v.ai.cruise * 0.7;
      v.body?.setLinvel({ x: v.vx, y: 0, z: v.vz }, true);
      return v;
    }
    return null;
  }

  /** A civilian variant weighted by the roster's traffic weights and the district's hint; else the config list. */
  private pickVariant(x: number, z: number): string {
    const w = this.world;
    const map = w.content.map;
    const d = districtAt(map, x, z);
    const id = pickTrafficVariant(w.content.vehicles, w.rng, d >= 0 ? map.districts[d]!.trafficHint || undefined : undefined);
    return id ?? w.rng.pick(this.config.variants);
  }

  /** Pre-physics: choose controls for each traffic car. */
  step(dt: number): void {
    const w = this.world;
    const cfg = this.config;
    const period = Math.max(1, Math.round(60 / cfg.aiHz));
    for (const v of w.vehicles) {
      if (!v.active || v.role !== 'traffic') continue;
      const a = v.ai;
      if (v.destroyed) continue;
      if (a.mode === 'stunned') {
        a.timer -= dt;
        v.controls.throttle = 0;
        v.controls.brake = 1;
        if (a.timer <= 0) a.mode = 'drive';
        continue;
      }
      if ((w.tick + v.id) % period === 0) this.decide(v);
      if (handleStuck(v, dt, cfg.stuckSec, 1.2)) continue;
      driveTowards(v, a.targetX, a.targetZ, a.targetSpeed, v.controls);
    }
    // Keep the streets around the player busy.
    this.respawnCooldown -= dt;
    if (this.respawnCooldown <= 0 && this.activeCount() < this.cap) {
      this.respawnCooldown = 0.25;
      this.spawnNear(cfg.respawnMinDist, cfg.spawnMaxDist, true);
    }
    this.parkTimer -= dt;
    if (this.parkTimer <= 0) {
      this.parkTimer = 0.5;
      this.streamParked(false);
    }
    // Recycle traffic left far behind, wrecks out of sight, and cars the player stole and left.
    for (const v of w.vehicles) {
      if (!v.active || v.persistent) continue;
      const d = w.distToPlayer(v.x, v.z);
      const far = d > cfg.respawnMinDist;
      if (v.role === 'traffic' && (d > cfg.despawnDist || (v.destroyed && w.time - v.destroyedTime > 8 && far))) {
        w.despawnVehicle(v);
      } else if (v.role === 'parked' && !this.isSpotCar(v)) {
        v.abandonedTime = far ? v.abandonedTime + dt : 0;
        if (v.abandonedTime > cfg.abandonedDespawnSec || d > cfg.despawnDist * 1.6) w.despawnVehicle(v);
      }
    }
    // Bound the wreck count (police wrecks pile up if a fight stays in one place).
    let wrecks = 0;
    let oldest: Vehicle | null = null;
    for (const v of w.vehicles) {
      if (!v.active || !v.destroyed || v.persistent || v === w.player.vehicle) continue;
      wrecks++;
      if (!oldest || v.destroyedTime < oldest.destroyedTime) oldest = v;
    }
    if (wrecks > cfg.maxWrecks && oldest && w.time - oldest.destroyedTime > 3) w.despawnVehicle(oldest);
  }

  private isSpotCar(v: Vehicle): boolean {
    for (let i = 0; i < this.spotCar.length; i++) if (this.spotCar[i] === v.id) return true;
    return false;
  }

  /** Bring parked cars into the streets near the player and take far ones away. */
  private streamParked(initial: boolean): void {
    const w = this.world;
    const cfg = this.config;
    const spots = w.content.map.parking;
    let parked = 0;
    for (let i = 0; i < spots.length; i++) {
      const id = this.spotCar[i]!;
      if (id < 0) continue;
      const v = w.vehicles[id]!;
      const s = spots[i]!;
      // Still standing in its spot, as it was left?
      const inPlace = v.active && v.role === 'parked' && Math.hypot(v.x - s.x, v.z - s.z) < 2.5 && !v.destroyed && v.hp >= v.params.maxHealth * 0.99;
      if (!v.active || !inPlace) {
        // Taken, wrecked or shoved: the car is on its own now; the spot stays empty for a while.
        this.spotCar[i] = -1;
        this.spotGone[i] = 1;
        continue;
      }
      if (w.distToPlayer(s.x, s.z) > cfg.parkedOutDist) {
        w.despawnVehicle(v);
        this.spotCar[i] = -1;
      } else parked++;
    }
    for (let i = 0; i < spots.length && parked < cfg.parkedMax; i++) {
      const s = spots[i]!;
      const d = w.distToPlayer(s.x, s.z);
      if (this.spotGone[i]) {
        if (d > cfg.parkedOutDist * 1.8) this.spotGone[i] = 0;
        continue;
      }
      if (this.spotCar[i]! >= 0 || d > cfg.parkedInDist) continue;
      // Do not pop a car in right under the player's nose (except at the start).
      if (!initial && d < 70) continue;
      let clear = true;
      for (const v of w.vehicles) if (v.active && Math.hypot(v.x - s.x, v.z - s.z) < 5) clear = false;
      if (!clear) continue;
      const v = w.spawnVehicle(s.variant, s.x, s.z, s.yaw, 'parked');
      if (!v) break;
      this.spotCar[i] = v.id;
      parked++;
    }
  }

  private decide(v: Vehicle): void {
    const w = this.world;
    const cfg = this.config;
    const g = w.roads;
    const a = v.ai;
    if (a.navFrom < 0 || a.navTo < 0) {
      // Lost (e.g. shoved off its road): rejoin at the nearest node.
      const n = g.nearest(v.x, v.z);
      a.navFrom = n.id;
      a.navTo = n.links.find((l) => g.edgeBetween(n.id, l)?.kind !== 'alley') ?? n.links[0] ?? n.id;
      a.navNext = -1;
    }
    const A = g.nodes[a.navFrom]!;
    const B = g.nodes[a.navTo]!;
    const e = g.edgeBetween(A.id, B.id);
    const len = Math.max(0.01, Math.hypot(B.x - A.x, B.z - A.z));
    const dx = (B.x - A.x) / len;
    const dz = (B.z - A.z) / len;
    // A siren coming up behind: move over to the kerb and slow right down.
    const pull = w.services.pullOver(v);
    const shift = pull ? w.services.config.pullOver.shift : 0;
    const off = (e?.width ?? 13) / 4 + shift;
    const vf = Math.max(0, forwardSpeed(v));
    const look = cfg.lookAheadBase + vf * cfg.lookAheadPerSpeed;
    // Distance left to the junction centre, and the half-width of the junction box there.
    const toB = (B.x - v.x) * dx + (B.z - v.z) * dz;
    let box = 0;
    for (const id of B.edges) box = Math.max(box, g.edges[id]!.width / 2);
    if (B.links.length <= 1) box = 0;
    // Choose where to go after B.
    if (a.navNext < 0) {
      const options = B.links.filter((l) => l !== A.id && g.edgeBetween(B.id, l)?.kind !== 'alley');
      const turf = w.gangs.chooseTurn(v, options);
      a.navNext = turf >= 0 ? turf : options.length ? w.rng.pick(options) : A.id;
    }
    const N = g.nodes[a.navNext]!;
    const nlen = Math.max(0.01, Math.hypot(N.x - B.x, N.z - B.z));
    const ndx = (N.x - B.x) / nlen;
    const ndz = (N.z - B.z) / nlen;
    const ne = g.edgeBetween(B.id, N.id);
    const noff = (ne?.width ?? 13) / 4 + shift;
    const turning = Math.abs(ndx * dx + ndz * dz) < 0.7;
    const uturn = ndx * dx + ndz * dz < -0.7;
    let speed = a.cruise > 0 ? a.cruise : cfg.cruiseSpeed;
    if (toB > box + look * 0.6) {
      // Along the lane.
      // Aim at a point on the lane line ahead of where the car is now.
      const s = Math.min(toB - box, look);
      const t = (v.x - A.x) * dx + (v.z - A.z) * dz + s;
      a.targetX = A.x + dx * t - dz * off;
      a.targetZ = A.z + dz * t + dx * off;
      if (turning || uturn) {
        const dist = toB - box;
        if (dist < cfg.cornerSlowDist) speed = Math.min(speed, cfg.cornerSpeed + (speed - cfg.cornerSpeed) * (dist / cfg.cornerSlowDist));
      }
    } else {
      // Through the junction into the next lane.
      const tx = B.x + ndx * (box + 4) - ndz * noff;
      const tz = B.z + ndz * (box + 4) + ndx * noff;
      a.targetX = tx;
      a.targetZ = tz;
      if (turning || uturn) speed = Math.min(speed, cfg.cornerSpeed);
      // Past the junction centre in the new direction: the next edge is now ours.
      if ((v.x - B.x) * ndx + (v.z - B.z) * ndz > Math.min(box, 4) || (uturn && (v.x - B.x) * ndx + (v.z - B.z) * ndz > -1)) {
        a.navFrom = B.id;
        a.navTo = N.id;
        a.navNext = -1;
        if (ne) {
          const base = ne.kind === 'avenue' || ne.kind === 'bridge' ? cfg.avenueSpeed : cfg.cruiseSpeed;
          a.cruise = base * w.rng.range(0.85, 1.12);
        }
      }
    }
    // Lights: stop at the line unless already committed.
    if (B.junction && toB > box) {
      const light = trafficLight(B, e?.alongX ?? true, w.time, cfg.lights);
      const toLine = toB - box - cfg.stopLine - v.params.length / 2 + 1;
      if (light === 'red' || (light === 'amber' && toLine > vf * 0.9)) {
        if (toLine < 40) speed = Math.min(speed, Math.max(0, toLine - 1) / 1.6);
      }
    }
    // Car-following: nearest obstacle ahead in our lane.
    const gap = w.gapAhead(v, cfg.detectRange, cfg.laneHalfWidth);
    if (gap < Infinity) speed = Math.min(speed, Math.max(0, (gap - cfg.minGap) / cfg.timeHeadway));
    // Turning: the nose sweeps across the crossing, so also look along the way we are steering.
    const tdx = a.targetX - v.x;
    const tdz = a.targetZ - v.z;
    const tl = Math.hypot(tdx, tdz);
    if (tl > 0.5) {
      const ux = tdx / tl;
      const uz = tdz / tl;
      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      for (const p of w.peds.peds) {
        if (!p.active || p.state === 'down') continue;
        const dx = p.x - v.x;
        const dz = p.z - v.z;
        // Someone right at the front corners: do not move off into them.
        if (dx * fx + dz * fz > 0 && Math.hypot(dx, dz) < v.params.length / 2 + 2.5) {
          speed = 0;
          continue;
        }
        const ahead = dx * ux + dz * uz;
        if (ahead <= -0.5 || ahead > 14) continue;
        if (Math.abs(dx * uz - dz * ux) > v.params.width / 2 + 1.6) continue;
        speed = Math.min(speed, Math.max(0, (ahead - v.params.length / 2 - 2) / cfg.timeHeadway));
      }
    }
    if (pull) speed = Math.min(speed, w.services.config.pullOver.speed);
    a.targetSpeed = speed;
  }
}
