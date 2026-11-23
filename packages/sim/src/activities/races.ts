import type { World, Vehicle } from '../world';
import { Rng } from '../rng';
import { mainNetwork } from '../road-main';
import type { ActivitiesConfig, RaceDef } from './config';
import type { FlagSite } from './placement';
import type { ActivityProgress } from './progress';

export interface RaceRoute {
  /** Checkpoints of one lap (or the sprint), the last being the finish line. */
  xs: number[];
  zs: number[];
  /** Road nodes the opponents drive through, in order (one lap). */
  nodesX: number[];
  nodesZ: number[];
  length: number;
}

export interface Racer {
  vehicleId: number;
  /** Index into the full checkpoint list (all laps) of the next checkpoint. */
  next: number;
  finished: boolean;
  finishSec: number;
}

export interface RaceRun {
  def: RaceDef;
  flag: FlagSite;
  route: RaceRoute;
  phase: 'countdown' | 'run';
  /** Countdown seconds left, then race time. */
  countdown: number;
  elapsed: number;
  player: Racer;
  opponents: Racer[];
  /** Checkpoints over all laps. */
  total: number;
  place: number;
  finishedOpponents: number;
  away: number;
}

const strHash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * Street races from start flags: stop at a flag in a car and the activity
 * button lines you up on the grid with two or three AI racers. A countdown, then
 * checkpoints round a route generated through the road graph (a sprint, or laps
 * of a circuit). Place, lap and time on the HUD; prizes by place; best times and
 * wins saved.
 */
export class RaceSystem {
  run: RaceRun | null = null;
  private readonly routes = new Map<string, RaceRoute>();

  constructor(
    private readonly world: World,
    private readonly config: ActivitiesConfig['races'],
    readonly flags: readonly FlagSite[],
    private readonly seed: number,
    private readonly progress: () => ActivityProgress,
  ) {}

  defOf(id: string): RaceDef | undefined {
    return this.config.defs.find((d) => d.id === id);
  }

  /** The flag the player's car is stopped at, if any. */
  flagHere(): FlagSite | null {
    const w = this.world;
    const v = w.player.vehicle;
    if (!v || v.destroyed) return null;
    const r = this.config.flagRadius;
    for (const f of this.flags) {
      if (Math.hypot(v.x - f.gridX, v.z - f.gridZ) <= r || Math.hypot(v.x - f.x, v.z - f.z) <= r) return f;
    }
    return null;
  }

  /** The route of a race (generated once, deterministically, from the road graph). */
  route(id: string): RaceRoute {
    let r = this.routes.get(id);
    if (!r) {
      const def = this.defOf(id)!;
      const flag = this.flags.find((f) => f.id === id)!;
      r = this.buildRoute(def, flag);
      this.routes.set(id, r);
    }
    return r;
  }

  private buildRoute(def: RaceDef, flag: FlagSite): RaceRoute {
    const g = this.world.roads;
    const main = mainNetwork(g);
    const fx = Math.sin(flag.yaw);
    const fz = Math.cos(flag.yaw);
    // The junctions straight ahead of and behind the grid, on its own road.
    let ahead = -1;
    let behind = -1;
    let ba = Infinity;
    let bb = Infinity;
    for (const n of g.nodes) {
      if (!main(n)) continue;
      const dx = n.x - flag.gridX;
      const dz = n.z - flag.gridZ;
      const along = dx * fx + dz * fz;
      if (Math.abs(dx * fz - dz * fx) > 12) continue;
      if (along > 4 && along < ba) {
        ba = along;
        ahead = n.id;
      } else if (along < -4 && -along < bb) {
        bb = -along;
        behind = n.id;
      }
    }
    if (ahead < 0) throw new Error(`Race "${def.id}": no road ahead of the grid`);
    const rng = new Rng((this.seed ^ strHash(def.id)) >>> 0);
    const edgeOk = (a: number, b: number): boolean => {
      const e = g.edgeBetween(a, b);
      return !!e && e.kind !== 'alley' && main(g.nodes[b]!);
    };
    for (let attempt = 0; attempt < 40; attempt++) {
      const nodes = [ahead];
      const seen = new Set<number>([ahead]);
      if (behind >= 0) seen.add(behind);
      let len = ba;
      let dirX = fx;
      let dirZ = fz;
      const goal = def.kind === 'circuit' ? def.length * rng.range(0.45, 0.6) : def.length;
      let stuck = false;
      while (len < goal) {
        const cur = g.nodes[nodes[nodes.length - 1]!]!;
        const opts = cur.links.filter((l) => !seen.has(l) && edgeOk(cur.id, l));
        if (opts.length === 0) {
          stuck = true;
          break;
        }
        // Prefer carrying on straight, but turn often enough to make it a race.
        let pick = opts[0]!;
        let bestScore = -Infinity;
        for (const l of opts) {
          const m = g.nodes[l]!;
          const d = Math.hypot(m.x - cur.x, m.z - cur.z) || 1;
          const straight = ((m.x - cur.x) * dirX + (m.z - cur.z) * dirZ) / d;
          const score = straight * 0.6 + rng.range(0, 1.2);
          if (score > bestScore) {
            bestScore = score;
            pick = l;
          }
        }
        const m = g.nodes[pick]!;
        const d = Math.hypot(m.x - cur.x, m.z - cur.z);
        dirX = (m.x - cur.x) / d;
        dirZ = (m.z - cur.z) / d;
        len += d;
        nodes.push(pick);
        seen.add(pick);
      }
      if (stuck) continue;
      if (def.kind === 'circuit') {
        if (behind < 0) continue;
        const back = g.path(nodes[nodes.length - 1]!, behind);
        // The way home must not use the grid's own road or cross the route already driven.
        if (back[back.length - 1] !== behind || back.slice(1).some((id) => seen.has(id) && id !== behind)) continue;
        for (const id of back.slice(1)) {
          const p = g.nodes[nodes[nodes.length - 1]!]!;
          const q = g.nodes[id]!;
          len += Math.hypot(q.x - p.x, q.z - p.z);
          nodes.push(id);
        }
        len += bb;
      }
      return this.checkpoints(def, flag, nodes, len);
    }
    throw new Error(`Race "${def.id}": could not build a route`);
  }

  private checkpoints(def: RaceDef, flag: FlagSite, nodes: number[], length: number): RaceRoute {
    const g = this.world.roads;
    const xs: number[] = [];
    const zs: number[] = [];
    const pts: { x: number; z: number }[] = [{ x: flag.gridX, z: flag.gridZ }, ...nodes.map((id) => ({ x: g.nodes[id]!.x, z: g.nodes[id]!.z }))];
    if (def.kind === 'circuit') pts.push({ x: flag.gridX, z: flag.gridZ });
    const spacing = this.config.checkpointSpacing;
    let since = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      // Extra gates along a long straight.
      const extra = Math.floor((since + seg) / spacing);
      for (let k = 1; k <= extra; k++) {
        const t = (k * spacing - since) / seg;
        if (t > 0.15 && t < 0.85) {
          xs.push(a.x + (b.x - a.x) * t);
          zs.push(a.z + (b.z - a.z) * t);
        }
      }
      since = (since + seg) % spacing;
      const c = pts[i + 1];
      const last = i === pts.length - 1;
      const turn = c ? Math.abs((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x)) / (seg * (Math.hypot(c.x - b.x, c.z - b.z) || 1)) > 0.5 : false;
      if (turn || last) {
        xs.push(b.x);
        zs.push(b.z);
        since = 0;
      }
    }
    const ndx = pts.slice(1).map((p) => p.x);
    const ndz = pts.slice(1).map((p) => p.z);
    return { xs, zs, nodesX: ndx, nodesZ: ndz, length };
  }

  /** Line up on the grid and start the countdown. */
  start(id: string): boolean {
    const w = this.world;
    const def = this.defOf(id);
    const flag = this.flags.find((f) => f.id === id);
    const pv = w.player.vehicle;
    if (!def || !flag || !pv) return false;
    const route = this.route(id);
    const fx = Math.sin(flag.yaw);
    const fz = Math.cos(flag.yaw);
    const rx = -fz;
    const rz = fx;
    const slots: [number, number][] = [
      [0, 0],
      [0, -2 * flag.lane],
      [-9, 0],
      [-9, -2 * flag.lane],
    ];
    const at = (s: [number, number]): [number, number] => [flag.gridX + fx * s[0] + rx * s[1], flag.gridZ + fz * s[0] + rz * s[1]];
    // Clear the grid of traffic and loose cars.
    for (const v of w.vehicles) {
      if (!v.active || v === pv || v.persistent) continue;
      if (slots.some((s) => {
        const [x, z] = at(s);
        return Math.hypot(v.x - x, v.z - z) < 7;
      }) || (v.role === 'traffic' && Math.hypot(v.x - flag.gridX, v.z - flag.gridZ) < 45)) w.despawnVehicle(v);
    }
    const [px, pz] = at(slots[0]!);
    w.teleportVehicle(pv, px, pz, flag.yaw);
    const opponents: Racer[] = [];
    for (let i = 0; i < def.opponents; i++) {
      const [x, z] = at(slots[i + 1]!);
      const variant = def.opponentVariants[i % def.opponentVariants.length]!;
      const v = w.spawnVehicle(variant, x, z, flag.yaw, 'parked');
      if (!v) break;
      v.locked = true;
      v.hp = v.params.maxHealth * def.opponentHull;
      opponents.push({ vehicleId: v.id, next: 0, finished: false, finishSec: 0 });
    }
    this.run = {
      def,
      flag,
      route,
      phase: 'countdown',
      countdown: this.config.countdownSec,
      elapsed: 0,
      player: { vehicleId: pv.id, next: 0, finished: false, finishSec: 0 },
      opponents,
      total: route.xs.length * def.laps,
      place: 1,
      finishedOpponents: 0,
      away: 0,
    };
    this.emit('countdown', 0, false, '');
    return true;
  }

  /** Checkpoint `i` of the whole race (laps unrolled). */
  checkpoint(i: number): { x: number; z: number } | null {
    const r = this.run;
    if (!r || i >= r.total) return null;
    const n = r.route.xs.length;
    return { x: r.route.xs[i % n]!, z: r.route.zs[i % n]! };
  }

  get lap(): number {
    const r = this.run;
    if (!r) return 0;
    return Math.min(r.def.laps, Math.floor(r.player.next / r.route.xs.length) + 1);
  }

  private emit(phase: 'countdown' | 'go' | 'checkpoint' | 'lap' | 'finished' | 'failed' | 'cancelled', reward: number, best: boolean, reason: string): void {
    const r = this.run!;
    this.world.events.push({ type: 'race', id: r.def.id, phase, place: r.place, racers: r.opponents.length + 1, lap: this.lap, laps: r.def.laps, seconds: r.elapsed, reward, best, reason });
  }

  cancel(): void {
    if (!this.run) return;
    this.emit('cancelled', 0, false, '');
    this.release();
  }

  private fail(reason: string): void {
    this.emit('failed', 0, false, reason);
    this.release();
  }

  private release(): void {
    const w = this.world;
    for (const o of this.run!.opponents) {
      const v = w.vehicles[o.vehicleId];
      w.actors.stopDriving(o.vehicleId);
      if (v && v.active) v.locked = false;
    }
    this.run = null;
  }

  /** Pre-physics: hold the grid during the countdown. */
  preStep(): void {
    const r = this.run;
    if (!r || r.phase !== 'countdown') return;
    const w = this.world;
    for (const id of [r.player.vehicleId, ...r.opponents.map((o) => o.vehicleId)]) {
      const v = w.vehicles[id];
      if (!v || !v.active) continue;
      v.vx = v.vz = v.yawRate = 0;
      v.body?.setLinvel({ x: 0, y: 0, z: 0 }, true);
      v.body?.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  private progressOf(r: Racer, v: Vehicle | undefined): number {
    const cp = this.checkpoint(r.next);
    if (r.finished) return 1e9 - r.finishSec;
    if (!cp || !v) return r.next * 1e4;
    return r.next * 1e4 - Math.hypot(cp.x - v.x, cp.z - v.z);
  }

  step(dt: number): void {
    const r = this.run;
    if (!r) return;
    const w = this.world;
    const pv = w.vehicles[r.player.vehicleId];
    if (w.playerCtl.dead || w.playerCtl.busted) return this.fail('Out of the race');
    if (!pv || !pv.active || pv.destroyed) return this.fail('Car wrecked');
    if (w.player.vehicle !== pv) {
      r.away += dt;
      if (r.away > this.config.leaveSec) return this.fail('You left the car');
    } else r.away = 0;
    if (r.phase === 'countdown') {
      r.countdown -= dt;
      if (r.countdown <= 0) {
        r.phase = 'run';
        const wps: { x: number; z: number }[] = [];
        for (let lap = 0; lap < r.def.laps; lap++) for (let i = 0; i < r.route.nodesX.length; i++) wps.push({ x: r.route.nodesX[i]!, z: r.route.nodesZ[i]! });
        for (const o of r.opponents) {
          const v = w.vehicles[o.vehicleId];
          if (v && v.active) w.actors.driveRoute(v, wps, r.def.opponentSpeed, { polite: false, aggressive: true });
        }
        this.emit('go', 0, false, '');
      }
      return;
    }
    r.elapsed += dt;
    const rad = this.config.checkpointRadius;
    // Opponents: a wider gate (they drive the lane lines and cut corners differently).
    for (const o of r.opponents) {
      if (o.finished) continue;
      const v = w.vehicles[o.vehicleId];
      if (!v || !v.active || v.destroyed) continue;
      const cp = this.checkpoint(o.next);
      if (cp && Math.hypot(cp.x - v.x, cp.z - v.z) <= rad + 8) o.next++;
      // A driver at the end of its route has crossed the line.
      const d = w.actors.driverFor(o.vehicleId);
      if (o.next >= r.total || (d && d.done && o.next >= r.total - 1)) {
        o.finished = true;
        o.finishSec = r.elapsed;
        r.finishedOpponents++;
      }
    }
    const cp = this.checkpoint(r.player.next);
    if (cp && w.player.vehicle === pv && Math.hypot(cp.x - pv.x, cp.z - pv.z) <= rad) {
      r.player.next++;
      const n = r.route.xs.length;
      if (r.player.next >= r.total) {
        r.player.finished = true;
        r.player.finishSec = r.elapsed;
        r.place = r.finishedOpponents + 1;
        const reward = r.def.prizes[Math.min(r.place, r.def.prizes.length) - 1] ?? 0;
        w.score.credits += reward;
        const p = this.progress();
        const rec = (p.races[r.def.id] ??= { wins: 0, finishes: 0, bestSec: 0 });
        rec.finishes++;
        if (r.place === 1) rec.wins++;
        const t = Math.round(r.elapsed * 100) / 100;
        const best = rec.bestSec === 0 || t < rec.bestSec;
        if (best) rec.bestSec = t;
        this.emit('finished', reward, best, '');
        this.release();
        return;
      }
      this.emit(r.player.next % n === 0 ? 'lap' : 'checkpoint', 0, false, '');
    }
    // Current place.
    const mine = this.progressOf(r.player, pv);
    let place = 1;
    for (const o of r.opponents) if (this.progressOf(o, w.vehicles[o.vehicleId]) > mine) place++;
    r.place = place;
  }
}
