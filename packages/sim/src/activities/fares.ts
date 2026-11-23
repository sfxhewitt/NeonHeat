import type { World, Vehicle } from '../world';
import type { Actor } from '../actors';
import { onPavement } from '../street';
import type { FareJob } from './config';
import type { ActivityProgress } from './progress';

export interface FareStop {
  /** Where the fare stands (pavement). */
  x: number;
  z: number;
  /** Where to stop (the lane beside the kerb). */
  laneX: number;
  laneZ: number;
}

export interface FareShift {
  job: string;
  def: FareJob;
  vehicleId: number;
  /** seek: drive to the pick-up; ride: take them to the drop-off. */
  phase: 'seek' | 'ride';
  pickup: FareStop;
  drop: FareStop;
  /** Passenger (taxi); null for parcels. */
  actor: Actor | null;
  timeLeft: number;
  timeTotal: number;
  /** Route length pick-up to drop-off (m), for the fare. */
  routeLength: number;
  /** Hull fraction at pick-up (parcels pay less for damage). */
  hullAtPickup: number;
  streak: number;
  /** Fares done this shift. */
  done: number;
  earned: number;
  /** Seconds the player has been out of the duty vehicle. */
  away: number;
}

/**
 * Taxi and courier work. In a vehicle of the right class the activity button
 * puts you on duty: a fare waves at a kerb (or a parcel waits at a door) with a
 * pick-up clock, then a drop-off across town against a timer with the GPS on.
 * Pay is per metre of route, plus a tip for speed and a streak bonus; parcels
 * lose pay for damage. Fail a fare and the streak resets; leave the car and the
 * shift ends. Everything is in activities.json `fares`.
 */
export class FareSystem {
  shift: FareShift | null = null;
  /** Passengers who just got out, walking off: [actor, seconds left]. */
  private readonly leaving: { actor: Actor; t: number }[] = [];

  constructor(
    private readonly world: World,
    readonly jobs: Record<string, FareJob>,
    private readonly progress: () => ActivityProgress,
  ) {}

  /** The job a vehicle can do (by class), if any. */
  jobFor(v: Vehicle | null): string | null {
    if (!v || v.destroyed) return null;
    for (const [id, j] of Object.entries(this.jobs)) if (j.classes.includes(v.params.class)) return id;
    return null;
  }

  startShift(job: string): boolean {
    const w = this.world;
    const v = w.player.vehicle;
    const def = this.jobs[job];
    if (!def || !v) return false;
    this.shift = {
      job,
      def,
      vehicleId: v.id,
      phase: 'seek',
      pickup: { x: 0, z: 0, laneX: 0, laneZ: 0 },
      drop: { x: 0, z: 0, laneX: 0, laneZ: 0 },
      actor: null,
      timeLeft: 0,
      timeTotal: 0,
      routeLength: 0,
      hullAtPickup: 1,
      streak: 0,
      done: 0,
      earned: 0,
      away: 0,
    };
    this.emit('onDuty', 0, 0, 0, '');
    this.newFare();
    return true;
  }

  endShift(reason: string): void {
    const s = this.shift;
    if (!s) return;
    if (s.actor) this.release(s.actor, s.phase === 'ride');
    this.shift = null;
    this.world.events.push({ type: 'fare', job: s.job, phase: 'offDuty', pay: s.earned, tip: 0, bonus: 0, streak: s.done, reason });
  }

  private emit(phase: 'onDuty' | 'offDuty' | 'newFare' | 'pickedUp' | 'delivered' | 'lost', pay: number, tip: number, bonus: number, reason: string): void {
    const s = this.shift!;
    this.world.events.push({ type: 'fare', job: s.job, phase, pay, tip, bonus, streak: s.streak, reason });
  }

  /**
   * A kerbside stop between `min` and `max` metres (as the crow flies) from a point:
   * a pavement spot beside a street or avenue, with the lane point next to it.
   */
  findStop(fromX: number, fromZ: number, min: number, max: number): FareStop | null {
    const w = this.world;
    const g = w.roads;
    const map = w.content.map;
    for (let tries = 0; tries < 200; tries++) {
      const n = g.nodes[w.rng.int(0, g.nodes.length - 1)]!;
      const d = Math.hypot(n.x - fromX, n.z - fromZ);
      if (d < min || d > max || n.edges.length === 0) continue;
      const e = g.edges[n.edges[w.rng.int(0, n.edges.length - 1)]!]!;
      if (e.kind === 'alley' || e.kind === 'bridge' || e.length < 30) continue;
      const a = g.nodes[e.a]!;
      const b = g.nodes[e.b]!;
      const t = w.rng.range(0.3, 0.7);
      const cx = a.x + (b.x - a.x) * t;
      const cz = a.z + (b.z - a.z) * t;
      const side = w.rng.chance(0.5) ? 1 : -1;
      const off = e.width / 2 + 1.6;
      const lane = e.width / 2 - 2.2;
      const px = e.alongX ? cx : cx + side * off;
      const pz = e.alongX ? cz + side * off : cz;
      if (!onPavement(map, px, pz) || w.insideBuilding(px, pz, 1.2)) continue;
      return { x: px, z: pz, laneX: e.alongX ? cx : cx + side * lane, laneZ: e.alongX ? cz + side * lane : cz };
    }
    return null;
  }

  private routeLength(a: FareStop, b: FareStop): number {
    const pts = this.world.roads.route(a.laneX, a.laneZ, b.laneX, b.laneZ);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z);
    return len;
  }

  private newFare(): void {
    const s = this.shift!;
    const w = this.world;
    const stop = this.findStop(w.player.x, w.player.z, s.def.pickupDistance[0], s.def.pickupDistance[1]);
    if (!stop) {
      this.endShift('No fares about');
      return;
    }
    s.phase = 'seek';
    s.pickup = stop;
    s.timeLeft = s.timeTotal = s.def.pickupSec;
    s.actor = null;
    if (s.def.cargo === 'passenger') {
      const facing = Math.atan2(stop.laneX - stop.x, stop.laneZ - stop.z);
      s.actor = w.actors.spawnActor({ x: stop.x, z: stop.z, facing, faction: 'fare', hostile: false, behaviour: 'idle', hp: 1 });
    }
    this.emit('newFare', 0, 0, 0, '');
  }

  /** Let a passenger go: out of the car if riding, then off along the pavement and gone. */
  private release(a: Actor, riding: boolean): void {
    const w = this.world;
    if (!a.active) return;
    if (riding) {
      const v = w.player.vehicle ?? w.vehicles[this.shift?.vehicleId ?? -1];
      // Out on the kerb side (the car's right).
      const x = v ? v.x - Math.cos(v.yaw) * 2.2 : w.player.x;
      const z = v ? v.z + Math.sin(v.yaw) * 2.2 : w.player.z;
      w.actors.alight(a, x, z);
    }
    if (a.dead) return;
    w.actors.goTo(a, a.x + w.rng.range(-12, 12), a.z + w.rng.range(-12, 12), false);
    this.leaving.push({ actor: a, t: 8 });
  }

  /** The fare is the player's to deliver: stopped close enough, in the duty vehicle? */
  private atStop(stop: FareStop, v: Vehicle): boolean {
    const d = Math.min(Math.hypot(v.x - stop.laneX, v.z - stop.laneZ), Math.hypot(v.x - stop.x, v.z - stop.z));
    return d <= this.shift!.def.stopRadius && Math.hypot(v.vx, v.vz) <= this.shift!.def.stopSpeed;
  }

  step(dt: number): void {
    const w = this.world;
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const l = this.leaving[i]!;
      l.t -= dt;
      if (l.t <= 0 || !l.actor.active) {
        if (l.actor.active) w.actors.despawnActor(l.actor);
        this.leaving.splice(i, 1);
      }
    }
    const s = this.shift;
    if (!s) return;
    const v = w.vehicles[s.vehicleId];
    if (!v || !v.active || v.destroyed) {
      this.endShift(v?.destroyed ? 'The car is wrecked' : 'The car is gone');
      return;
    }
    if (w.playerCtl.dead || w.playerCtl.busted) {
      this.endShift('Shift over');
      return;
    }
    if (w.player.vehicle !== v) {
      s.away += dt;
      if (s.away >= s.def.leaveSec) this.endShift('You left the car');
      return;
    }
    s.away = 0;
    s.timeLeft -= dt;
    if (s.phase === 'seek') {
      if (s.actor && (!s.actor.active || s.actor.dead)) {
        this.lose('The fare is down');
        return;
      }
      if (this.atStop(s.pickup, v)) {
        const drop = this.findStop(s.pickup.x, s.pickup.z, s.def.dropDistance[0], s.def.dropDistance[1]);
        if (!drop) {
          this.endShift('No fares about');
          return;
        }
        if (s.actor) w.actors.board(s.actor);
        s.drop = drop;
        s.phase = 'ride';
        s.routeLength = this.routeLength(s.pickup, drop);
        s.timeLeft = s.timeTotal = s.def.baseSec + s.routeLength / s.def.allowanceSpeed;
        s.hullAtPickup = w.vehicleHealth(v);
        this.emit('pickedUp', 0, 0, 0, '');
        return;
      }
      if (s.timeLeft <= 0) this.lose(s.def.cargo === 'passenger' ? 'They found another ride' : 'The parcel went with someone else');
      return;
    }
    if (this.atStop(s.drop, v)) {
      const d = s.def;
      let pay = d.pay.base + d.pay.perMetre * s.routeLength;
      const lostHull = Math.max(0, s.hullAtPickup - w.vehicleHealth(v));
      pay *= 1 - Math.min(1, lostHull * d.pay.damagePenalty * 4);
      pay = Math.round(pay);
      const tip = Math.round(pay * d.pay.tipMax * Math.max(0, s.timeLeft / s.timeTotal));
      s.streak++;
      s.done++;
      const bonus = s.streak % d.streakEvery === 0 ? d.streakBonus * (s.streak / d.streakEvery) : 0;
      const total = pay + tip + bonus;
      s.earned += total;
      w.score.credits += total;
      const p = this.progress();
      const rec = (p.fares[s.job] ??= { done: 0, earned: 0, bestStreak: 0 });
      rec.done++;
      rec.earned += total;
      rec.bestStreak = Math.max(rec.bestStreak, s.streak);
      if (s.actor) this.releaseAt(s.actor, s.drop);
      s.actor = null;
      this.emit('delivered', pay, tip, bonus, '');
      this.newFare();
      return;
    }
    if (s.timeLeft <= 0) this.lose(s.def.cargo === 'passenger' ? 'Too slow: they got out' : 'Too late: delivery refused');
  }

  private releaseAt(a: Actor, stop: FareStop): void {
    const w = this.world;
    w.actors.alight(a, stop.x, stop.z);
    if (!a.active || a.dead) return;
    w.actors.goTo(a, stop.x + (stop.x - stop.laneX) * 3, stop.z + (stop.z - stop.laneZ) * 3, false);
    this.leaving.push({ actor: a, t: 6 });
  }

  private lose(reason: string): void {
    const s = this.shift!;
    if (s.actor) this.release(s.actor, s.phase === 'ride');
    s.actor = null;
    s.streak = 0;
    this.emit('lost', 0, 0, 0, reason);
    this.newFare();
  }

  /** Where the player should drive now (pick-up or drop-off lane point). */
  target(): { x: number; z: number } | null {
    const s = this.shift;
    if (!s) return null;
    const p = s.phase === 'seek' ? s.pickup : s.drop;
    return { x: p.laneX, z: p.laneZ };
  }
}
