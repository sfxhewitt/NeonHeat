import { z } from 'zod';
import { LaneLoop } from './nav';
import { driveTowards, handleStuck, resetAiState } from './ai';
import { forwardSpeed } from './vehicle';
import type { Vehicle, World } from './world';

export const TrafficConfigSchema = z.object({
  count: z.number().int().nonnegative(),
  variants: z.array(z.string()).min(1),
  cruiseSpeed: z.number().positive(),
  cornerSpeed: z.number().positive(),
  cornerSlowDist: z.number().nonnegative(),
  minGap: z.number().positive(),
  timeHeadway: z.number().positive(),
  lookAheadBase: z.number().positive(),
  lookAheadPerSpeed: z.number().nonnegative(),
  detectRange: z.number().positive(),
  laneHalfWidth: z.number().positive(),
  respawnMinDist: z.number().nonnegative(),
  stuckSec: z.number().positive(),
  /** Abandoned (stolen then left) cars out of range for this long are recycled. */
  abandonedDespawnSec: z.number().positive(),
  aiHz: z.number().positive(),
});
export type TrafficConfig = z.infer<typeof TrafficConfigSchema>;

/**
 * Civilian traffic: pooled cars following lane loops with car-following
 * (keep a gap, brake for obstacles). Decisions tick at aiHz, staggered by id.
 */
export class TrafficSystem {
  readonly loops: LaneLoop[];
  /** Active traffic cap (quality tiers lower it). */
  cap: number;
  private respawnCooldown = 0;
  private readonly tmp = { x: 0, z: 0 };

  constructor(
    private readonly world: World,
    public config: TrafficConfig,
  ) {
    const map = world.content.map;
    this.loops = map.traffic.loops.map((l) => new LaneLoop(l.id, l.points, map.roads.laneOffset));
    this.cap = config.count;
  }

  /** Spread the initial traffic evenly around the loops. */
  populate(): void {
    const n = this.cap;
    for (let i = 0; i < n; i++) {
      const loop = i % this.loops.length;
      const L = this.loops[loop]!;
      const s = ((Math.floor(i / this.loops.length) + this.world.rng.next()) / Math.ceil(n / this.loops.length)) * L.length;
      this.spawnAt(loop, s, false);
    }
  }

  private spawnAt(loopIdx: number, s: number, checkPlayer: boolean): Vehicle | null {
    const w = this.world;
    const L = this.loops[loopIdx]!;
    const p = this.tmp;
    L.pointAt(s, p);
    if (checkPlayer && Math.hypot(p.x - w.player.x, p.z - w.player.z) < this.config.respawnMinDist) return null;
    for (const v of w.vehicles) if (v.active && Math.hypot(v.x - p.x, v.z - p.z) < 9) return null;
    const ahead = { x: 0, z: 0 };
    L.pointAt(s + 2, ahead);
    const yaw = Math.atan2(ahead.x - p.x, ahead.z - p.z);
    const variant = w.rng.pick(this.config.variants);
    const v = w.spawnVehicle(variant, p.x, p.z, yaw, 'traffic');
    if (!v) return null;
    resetAiState(v.ai);
    v.ai.mode = 'drive';
    v.ai.loop = loopIdx;
    v.ai.s = s;
    // Start rolling so traffic does not all pull away at once.
    v.vx = Math.sin(yaw) * this.config.cruiseSpeed * 0.6;
    v.vz = Math.cos(yaw) * this.config.cruiseSpeed * 0.6;
    return v;
  }

  activeCount(): number {
    let n = 0;
    for (const v of this.world.vehicles) if (v.active && v.role === 'traffic') n++;
    return n;
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
    // Keep the population topped up, away from the player.
    this.respawnCooldown -= dt;
    if (this.respawnCooldown <= 0 && this.activeCount() < this.cap) {
      this.respawnCooldown = 0.5;
      const loop = w.rng.int(0, this.loops.length - 1);
      this.spawnAt(loop, w.rng.next() * this.loops[loop]!.length, true);
    }
    // Recycle traffic that is wrecked and far away, and cars the player stole and left behind.
    for (const v of w.vehicles) {
      if (!v.active) continue;
      const far = w.distToPlayer(v.x, v.z) > cfg.respawnMinDist;
      if (v.role === 'traffic' && v.destroyed && w.time - v.destroyedTime > 8 && far) {
        w.despawnVehicle(v);
      } else if (v.role === 'parked' && !v.persistent) {
        v.abandonedTime = far ? v.abandonedTime + dt : 0;
        if (v.abandonedTime > cfg.abandonedDespawnSec) w.despawnVehicle(v);
      }
    }
  }

  private decide(v: Vehicle): void {
    const w = this.world;
    const cfg = this.config;
    const a = v.ai;
    const L = this.loops[a.loop]!;
    a.s = L.project(v.x, v.z);
    const vf = forwardSpeed(v);
    const look = cfg.lookAheadBase + Math.max(0, vf) * cfg.lookAheadPerSpeed;
    L.pointAt(a.s + look, this.tmp);
    a.targetX = this.tmp.x;
    a.targetZ = this.tmp.z;
    let speed = cfg.cruiseSpeed;
    const corner = L.distanceToNextCorner(a.s);
    if (corner < cfg.cornerSlowDist) speed = Math.min(speed, cfg.cornerSpeed + (cfg.cruiseSpeed - cfg.cornerSpeed) * (corner / cfg.cornerSlowDist));
    // Car-following: nearest obstacle ahead in our lane.
    const gap = w.gapAhead(v, cfg.detectRange, cfg.laneHalfWidth);
    if (gap < Infinity) speed = Math.min(speed, Math.max(0, (gap - cfg.minGap) / cfg.timeHeadway));
    a.targetSpeed = speed;
  }
}
