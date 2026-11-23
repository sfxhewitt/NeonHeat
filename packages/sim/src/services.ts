import { driveTowards, handleStuck, resetAiState } from './ai';
import { wrapAngle } from './physics';
import { forwardSpeed } from './vehicle';
import { mainNetwork, nearestMain } from './road-main';
import { Anim, Look } from './ped-tags';
import type { NavEdge } from './nav';
import type { Ped } from './peds';
import type { ServicesConfig } from './life-config';
import type { Vehicle, World } from './world';

/**
 * Emergency services. A pedestrian knocked down near the player gets an
 * ambulance; a burning wreck gets a fire tender. The call goes out a few
 * seconds later (someone phones it in). The vehicle comes from the nearest
 * clinic if one is close, otherwise from a road out of the player's view, and
 * drives the road graph with lights and siren. It stops at the kerb, its crew
 * gets out (pooled peds), revives the patient or hoses the fire out, gets back
 * in and the vehicle joins the traffic with its lights off.
 *
 * Traffic ahead of any vehicle with its lights on (responders, and police on a
 * case) pulls over to the kerb and slows: see `pullOver`.
 *
 * Wrecks burn: `burnOf(vehicleId)` is 1 when a car goes up and falls to 0 as
 * it burns out on its own (slowly) or under the hoses (quickly). The renderer
 * scales flames and firelight by it.
 */

export type ServiceKind = 'ambulance' | 'fire';
export type UnitState = 'enRoute' | 'onScene' | 'leaving';

const MAX_CALLS = 16;
const MAX_UNITS = 6;
const MAX_CREW = 3;
const MAX_ROUTE = 96;
/** Crew phases. */
const OUT = 0;
const WORK = 1;
const BACK = 2;
const ABOARD = 3;

export interface ServiceCall {
  active: boolean;
  kind: ServiceKind;
  /** Ped id (ambulance) or vehicle id (fire). */
  target: number;
  x: number;
  z: number;
  /** Seconds until the call goes out. */
  delay: number;
  age: number;
  /** Unit slot handling it, or -1. */
  unit: number;
}

export interface ServiceUnit {
  id: number;
  active: boolean;
  kind: ServiceKind;
  vehicleId: number;
  /** Call slot being worked. */
  call: number;
  state: UnitState;
  xs: Float64Array;
  zs: Float64Array;
  n: number;
  idx: number;
  /** Crew ped ids and their phases. */
  crew: Int16Array;
  phase: Uint8Array;
  crewN: number;
  /** Seconds of work done on the current patient. */
  work: number;
  age: number;
  /** Seconds on scene. */
  scene: number;
  /** The road edge the vehicle stopped on, in its direction of travel (for joining traffic). */
  edgeFrom: number;
  edgeTo: number;
}

export class ServicesSystem {
  readonly calls: ServiceCall[] = [];
  readonly units: ServiceUnit[] = [];
  /** Most responders out at once (quality tiers set it). */
  cap = 3;
  config: ServicesConfig;
  /** How much each vehicle is still burning, 0 to 1. */
  readonly burn: Float32Array;
  /** Seconds a traffic car stays pulled over. */
  private readonly pullT: Float32Array;
  /** Vehicles with lights on this step. */
  private readonly sirens: Int16Array;
  private sirenN = 0;
  private readonly clinics: { x: number; z: number }[] = [];
  private retry = 0;

  constructor(private readonly world: World) {
    this.config = world.content.life.services;
    const nv = world.vehicles.length;
    this.burn = new Float32Array(nv);
    this.pullT = new Float32Array(nv);
    this.sirens = new Int16Array(nv);
    for (let i = 0; i < MAX_CALLS; i++) this.calls.push({ active: false, kind: 'ambulance', target: -1, x: 0, z: 0, delay: 0, age: 0, unit: -1 });
    for (let i = 0; i < MAX_UNITS; i++) {
      this.units.push({
        id: i,
        active: false,
        kind: 'ambulance',
        vehicleId: -1,
        call: -1,
        state: 'enRoute',
        xs: new Float64Array(MAX_ROUTE),
        zs: new Float64Array(MAX_ROUTE),
        n: 0,
        idx: 0,
        crew: new Int16Array(MAX_CREW).fill(-1),
        phase: new Uint8Array(MAX_CREW),
        crewN: 0,
        work: 0,
        age: 0,
        scene: 0,
        edgeFrom: -1,
        edgeTo: -1,
      });
    }
    for (const [id, m] of Object.entries(world.content.map.markers)) if (id.startsWith('clinic')) this.clinics.push({ x: m.pos[0], z: m.pos[2] });
  }

  burnOf(vehicleId: number): number {
    return this.burn[vehicleId] ?? 0;
  }

  activeUnits(): number {
    let n = 0;
    for (const u of this.units) if (u.active) n++;
    return n;
  }

  /** The unit driving a vehicle, if any. */
  unitFor(vehicleId: number): ServiceUnit | null {
    for (const u of this.units) if (u.active && u.vehicleId === vehicleId) return u;
    return null;
  }

  // ------------------------------------------------------------ incidents

  /** Ask for an ambulance for a downed ped (normally automatic). Returns false if it does not qualify. */
  requestAmbulance(pedId: number, delay = this.rollDelay()): boolean {
    const w = this.world;
    const p = w.peds.peds[pedId];
    if (!p || !p.active || p.state !== 'down') return false;
    if (p.owner === 'gang' || p.owner === 'service' || w.peds.tags.actor[pedId]) return false;
    if (this.findCall('ambulance', pedId)) return false;
    const c = this.calls.find((q) => !q.active);
    if (!c) return false;
    this.open(c, 'ambulance', pedId, p.x, p.z, delay);
    // Stay down until help comes (the ped system would otherwise clear the body).
    p.timer = 1e6;
    return true;
  }

  /** Set a wreck alight and call the fire tender (normally automatic when a car is destroyed). */
  ignite(vehicleId: number, delay = this.config.fireCallDelaySec + this.rollDelay()): boolean {
    const v = this.world.vehicles[vehicleId];
    if (!v || !v.active || !v.destroyed) return false;
    this.burn[vehicleId] = 1;
    if (this.findCall('fire', vehicleId)) return true;
    const c = this.calls.find((q) => !q.active);
    if (c) this.open(c, 'fire', vehicleId, v.x, v.z, delay);
    return true;
  }

  private rollDelay(): number {
    const [a, b] = this.config.dispatchDelaySec;
    return this.world.rng.range(a, Math.max(a, b));
  }

  private open(c: ServiceCall, kind: ServiceKind, target: number, x: number, z: number, delay: number): void {
    c.active = true;
    c.kind = kind;
    c.target = target;
    c.x = x;
    c.z = z;
    c.delay = delay;
    c.age = 0;
    c.unit = -1;
  }

  private findCall(kind: ServiceKind, target: number): ServiceCall | null {
    for (const c of this.calls) if (c.active && c.kind === kind && c.target === target) return c;
    return null;
  }

  /** Close a call; a patient nobody came for is left to the ped system again. */
  private close(c: ServiceCall): void {
    if (!c.active) return;
    if (c.kind === 'ambulance') {
      const p = this.world.peds.peds[c.target];
      if (p && p.active && p.state === 'down' && p.timer > 1e5) p.timer = 0;
    }
    c.active = false;
    c.unit = -1;
  }

  /** Is the call's subject still in need? */
  private needed(c: ServiceCall): boolean {
    const w = this.world;
    if (c.kind === 'ambulance') {
      const p = w.peds.peds[c.target];
      return !!p && p.active && p.state === 'down';
    }
    const v = w.vehicles[c.target];
    return !!v && v.active && v.destroyed && this.burn[c.target]! > 0;
  }

  // ------------------------------------------------------------ pull over

  /** Lights on: responders on a call, and police cars working a case. */
  sirenOn(v: Vehicle): boolean {
    if (!v.active || v.destroyed) return false;
    if (v.siren) return true;
    if (v.role !== 'police' || this.world.heat.level <= 0) return false;
    const m = v.ai.mode;
    return m !== 'leave' && m !== 'hold' && m !== 'roadblock' && Math.hypot(v.vx, v.vz) > 3;
  }

  /**
   * Should this traffic car pull over? True while a vehicle with its lights on
   * is coming up behind it on the same road (and for a moment after).
   */
  pullOver(v: Vehicle): boolean {
    const cfg = this.config.pullOver;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    for (let i = 0; i < this.sirenN; i++) {
      const s = this.world.vehicles[this.sirens[i]!]!;
      if (s === v) continue;
      const sx = Math.sin(s.yaw);
      const sz = Math.cos(s.yaw);
      // Heading the same way...
      if (fx * sx + fz * sz < 0.6) continue;
      const dx = v.x - s.x;
      const dz = v.z - s.z;
      const ahead = dx * sx + dz * sz;
      // ...ahead of the siren, on the same road.
      if (ahead <= 0 || ahead > cfg.range) continue;
      if (Math.abs(dx * sz - dz * sx) > 9) continue;
      this.pullT[v.id] = cfg.holdSec;
      return true;
    }
    return this.pullT[v.id]! > 0;
  }

  // ------------------------------------------------------------ step

  step(dt: number): void {
    const w = this.world;
    // Who has lights on, and pull-over timers.
    this.sirenN = 0;
    for (const v of w.vehicles) {
      if (this.pullT[v.id]! > 0) this.pullT[v.id] = Math.max(0, this.pullT[v.id]! - dt);
      if (this.sirenOn(v)) this.sirens[this.sirenN++] = v.id;
    }
    // Mark mission actors' bodies (never revived: the mission owns them).
    for (const a of w.actors.actors) if (a.active && a.pedId >= 0) w.peds.tags.actor[a.pedId] = 1;
    // Fires burn down on their own.
    for (let i = 0; i < this.burn.length; i++) {
      if (this.burn[i]! <= 0) continue;
      const v = w.vehicles[i]!;
      if (!v.active || !v.destroyed) this.burn[i] = 0;
      else this.burn[i] = Math.max(0, this.burn[i]! - dt / this.config.burnSec);
    }
    this.retry -= dt;
    for (const c of this.calls) {
      if (!c.active) continue;
      c.age += dt;
      if (c.unit >= 0) continue;
      if (!this.needed(c) || c.age > this.config.giveUpSec) {
        this.close(c);
        continue;
      }
      c.delay -= dt;
      if (c.delay > 0 || this.retry > 0 || this.activeUnits() >= this.cap) continue;
      if (w.distToPlayer(c.x, c.z) > this.config.callRadius) {
        // Nobody around to see it: let it go.
        this.close(c);
        continue;
      }
      if (!this.dispatch(c)) this.retry = 1.5;
    }
    for (const u of this.units) if (u.active) this.stepUnit(u, dt);
  }

  /** Post-physics: new incidents from this step's events. */
  postStep(): void {
    const w = this.world;
    const ex = w.content.weapons.explosion;
    for (const e of w.events) {
      if (e.type === 'pedHit') {
        const p = w.peds.peds[e.pedId];
        if (p && w.distToPlayer(p.x, p.z) < this.config.callRadius) this.requestAmbulance(e.pedId);
      } else if (e.type === 'vehicleDestroyed') {
        const v = w.vehicles[e.vehicleId];
        if (v && v.params.mass >= ex.wreckMinMass) this.ignite(e.vehicleId);
      }
    }
  }

  // ------------------------------------------------------------ dispatch

  private dispatch(c: ServiceCall): boolean {
    const w = this.world;
    const u = this.units.find((q) => !q.active);
    if (!u) return false;
    const g = w.roads;
    // Where to stop: at the kerb beside the patient, or short of the wreck.
    const stop = this.stopPoint(c);
    if (!stop) return false;
    const goal = stop.from;
    // Where to come from: the clinic, if near, else a road out of view.
    let start = -1;
    if (c.kind === 'ambulance') {
      let best = this.config.clinicMaxDist;
      for (const k of this.clinics) {
        const d = Math.hypot(k.x - c.x, k.z - c.z);
        if (d < best && w.distToPlayer(k.x, k.z) > 80) {
          best = d;
          start = nearestMain(g, k.x, k.z).id;
        }
      }
    }
    if (start < 0) start = this.outOfViewNode(c.x, c.z);
    if (start < 0) return false;
    const path = g.path(start, goal);
    if (path.length < 2 || path[path.length - 1] !== goal) return false;
    const variant = c.kind === 'ambulance' ? this.config.ambulance : this.config.fireTender;
    // Spawn a little way along the first road, facing along the route.
    const a = g.nodes[path[0]!]!;
    const b = g.nodes[path[1]!]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    const lane = this.laneOf(g.edgeBetween(a.id, b.id));
    const t = Math.min(10, len * 0.3);
    const sx = a.x + dx * t - dz * lane;
    const sz = a.z + dz * t + dx * lane;
    for (const o of w.vehicles) if (o.active && Math.hypot(o.x - sx, o.z - sz) < 7) return false;
    const v = w.spawnVehicle(variant, sx, sz, Math.atan2(dx, dz), 'service');
    if (!v) return false;
    v.persistent = false;
    v.siren = true;
    v.beacons = true;
    resetAiState(v.ai);
    v.ai.mode = 'drive';
    v.vx = dx * 8;
    v.vz = dz * 8;
    v.body?.setLinvel({ x: v.vx, y: 0, z: v.vz }, true);
    u.active = true;
    u.kind = c.kind;
    u.vehicleId = v.id;
    u.call = this.calls.indexOf(c);
    u.state = 'enRoute';
    u.crewN = 0;
    u.crew.fill(-1);
    u.work = 0;
    u.age = 0;
    u.scene = 0;
    u.edgeFrom = stop.from;
    u.edgeTo = stop.to;
    this.buildRoute(u, path, stop.x, stop.z, stop.to);
    u.idx = 1;
    c.unit = u.id;
    w.events.push({ type: 'serviceDispatched', kind: c.kind, vehicleId: v.id, x: c.x, z: c.z });
    w.events.push({ type: 'siren', vehicleId: v.id, on: true });
    return true;
  }

  /** Lane centre offset from the road's centre line: responders drive near the middle, past cars pulled in. */
  private laneOf(e: NavEdge | null): number {
    const w = e?.width ?? 13;
    return Math.min(w / 4, this.config.overtakeOffset + 1.2);
  }

  /**
   * The kerbside point to stop at, on the nearest road to the incident, with the
   * incident on the vehicle's right (kerb) side. `from` and `to` are the road
   * edge's nodes in the direction of travel.
   */
  private stopPoint(c: ServiceCall): { x: number; z: number; from: number; to: number } | null {
    const g = this.world.roads;
    const main = mainNetwork(g);
    let best: NavEdge | null = null;
    let bd = Infinity;
    let bt = 0;
    for (const e of g.edges) {
      if (e.kind === 'alley') continue;
      const A = g.nodes[e.a]!;
      const B = g.nodes[e.b]!;
      if (!main(A) || !main(B)) continue;
      const ex = B.x - A.x;
      const ez = B.z - A.z;
      const l2 = ex * ex + ez * ez || 1;
      const t = Math.max(0.12, Math.min(0.88, ((c.x - A.x) * ex + (c.z - A.z) * ez) / l2));
      const d = Math.hypot(A.x + ex * t - c.x, A.z + ez * t - c.z);
      if (d < bd) {
        bd = d;
        best = e;
        bt = t;
      }
    }
    if (!best || bd > 40) return null;
    const A = g.nodes[best.a]!;
    const B = g.nodes[best.b]!;
    const len = best.length || 1;
    const dx = (B.x - A.x) / len;
    const dz = (B.z - A.z) / len;
    const px = A.x + (B.x - A.x) * bt;
    const pz = A.z + (B.z - A.z) * bt;
    // Right-hand side of A->B is (-dz, dx). Travel so the incident is on the right.
    const side = (c.x - px) * -dz + (c.z - pz) * dx;
    const forward = side >= 0;
    const tx = forward ? dx : -dx;
    const tz = forward ? dz : -dz;
    const kerb = best.width / 2 - 1.7;
    // Ambulances pull up beside the patient; the fire tender stops short of the wreck.
    const back = c.kind === 'fire' ? 10 : 2.5;
    let along = forward ? bt * len - back : (1 - bt) * len - back;
    along = Math.max(3, Math.min(len - 3, along));
    const ox = forward ? A.x : B.x;
    const oz = forward ? A.z : B.z;
    return { x: ox + tx * along - tz * kerb, z: oz + tz * along + tx * kerb, from: forward ? A.id : B.id, to: forward ? B.id : A.id };
  }

  /** A main-network node at spawning distance from (x, z), out of the player's view. */
  private outOfViewNode(x: number, z: number): number {
    const w = this.world;
    const g = w.roads;
    const main = mainNetwork(g);
    const [r0, r1] = this.config.spawnDist;
    const px = w.player.x;
    const pz = w.player.z;
    let count = 0;
    let pick = -1;
    for (const n of g.nodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < r0 || d > r1 || !main(n)) continue;
      const dp = Math.hypot(n.x - px, n.z - pz);
      if (dp < 90) continue;
      if (dp < 150 && Math.abs(n.x - px) < 80 && n.z - pz > -100 && n.z - pz < 60) continue;
      let ok = false;
      for (const id of n.edges) if (g.edges[id]!.kind !== 'alley') ok = true;
      if (!ok) continue;
      // Reservoir sampling: a fair pick without building a list.
      count++;
      if (w.rng.int(1, count) === 1) pick = n.id;
    }
    return pick;
  }

  private buildRoute(u: ServiceUnit, nodes: number[], stopX: number, stopZ: number, after: number): void {
    const g = this.world.roads;
    let n = 0;
    for (let i = 0; i < nodes.length && n < MAX_ROUTE - 1; i++) {
      const node = g.nodes[nodes[i]!]!;
      const prev = i > 0 ? g.nodes[nodes[i - 1]!]! : null;
      const nextId = i < nodes.length - 1 ? nodes[i + 1]! : after;
      const next = g.nodes[nextId]!;
      let ox = 0;
      let oz = 0;
      const lane = this.laneOf(prev ? g.edgeBetween(prev.id, node.id) : g.edgeBetween(node.id, nextId));
      if (prev) [ox, oz] = right(node.x - prev.x, node.z - prev.z);
      if (next !== node) {
        const [rx, rz] = right(next.x - node.x, next.z - node.z);
        if (!prev || Math.abs(rx * ox + rz * oz) < 0.7) {
          ox += rx;
          oz += rz;
        }
      }
      u.xs[n] = node.x + ox * lane;
      u.zs[n] = node.z + oz * lane;
      n++;
    }
    u.xs[n] = stopX;
    u.zs[n] = stopZ;
    n++;
    u.n = n;
    u.idx = 0;
  }

  // ------------------------------------------------------------ units

  private stepUnit(u: ServiceUnit, dt: number): void {
    const w = this.world;
    const v = w.vehicles[u.vehicleId]!;
    u.age += dt;
    // Stolen, wrecked or cleared away: the job is off.
    if (!v.active || v.destroyed || v.role !== 'service') {
      this.abort(u, v);
      return;
    }
    const c = this.calls[u.call]!;
    if (u.state === 'enRoute') {
      if (!c.active || !this.needed(c) || u.age > this.config.giveUpSec) {
        this.leave(u, v);
        return;
      }
      if (this.drive(u, v, dt)) {
        u.state = 'onScene';
        u.scene = 0;
        v.siren = false;
        w.events.push({ type: 'siren', vehicleId: v.id, on: false });
        w.events.push({ type: 'serviceArrived', kind: u.kind, vehicleId: v.id, x: v.x, z: v.z });
        this.spawnCrew(u, v);
      }
      return;
    }
    if (u.state === 'onScene') {
      driveTowards(v, v.x, v.z, 0, v.controls);
      u.scene += dt;
      this.stepCrew(u, v, c, dt);
    }
  }

  /** Follow the route. Returns true once stopped at the scene. */
  private drive(u: ServiceUnit, v: Vehicle, dt: number): boolean {
    const w = this.world;
    const cfg = this.config;
    const a = v.ai;
    const last = u.n - 1;
    if ((w.tick + v.id) % 4 === 0) {
      while (u.idx < last && Math.hypot(u.xs[u.idx]! - v.x, u.zs[u.idx]! - v.z) < cfg.arriveRadius) u.idx++;
      const tx = u.xs[u.idx]!;
      const tz = u.zs[u.idx]!;
      a.targetX = tx;
      a.targetZ = tz;
      const dist = Math.hypot(tx - v.x, tz - v.z);
      let speed = Math.min(cfg.driveSpeed, v.params.topSpeed);
      if (u.idx < last) {
        const nx = u.xs[u.idx + 1]!;
        const nz = u.zs[u.idx + 1]!;
        const turn = Math.abs(wrapAngle(Math.atan2(nx - tx, nz - tz) - Math.atan2(tx - v.x, tz - v.z)));
        if (turn > 0.5 && dist < 26) speed = Math.min(speed, cfg.cornerSpeed + (speed - cfg.cornerSpeed) * (dist / 26));
      } else speed = Math.min(speed, 1.5 + dist * 0.55);
      const gap = w.gapAhead(v, 24, 1.15);
      if (gap < Infinity) speed = Math.min(speed, Math.max(0, (gap - cfg.minGap) / 0.8));
      a.targetSpeed = speed;
    }
    const atEnd = u.idx === last && Math.hypot(u.xs[last]! - v.x, u.zs[last]! - v.z) < 2.5;
    if (atEnd && Math.abs(forwardSpeed(v)) < 1.2) return true;
    if (atEnd) {
      driveTowards(v, v.x, v.z, 0, v.controls);
      return false;
    }
    if (handleStuck(v, dt, 2, 1)) return false;
    driveTowards(v, a.targetX, a.targetZ, a.targetSpeed, v.controls);
    return false;
  }

  /** The crew gets out of the back. */
  private spawnCrew(u: ServiceUnit, v: Vehicle): void {
    const w = this.world;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    const back = v.params.length / 2 + 0.7;
    u.crewN = 0;
    for (let i = 0; i < this.config.crew; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      // Kerb side first (right of travel: (-fz, fx)).
      let x = v.x - fx * back - fz * 0.8 * side;
      let z = v.z - fz * back + fx * 0.8 * side;
      if (w.insideBuilding(x, z, 0.4)) {
        x = v.x - fx * back;
        z = v.z - fz * back;
      }
      const p = w.peds.spawnPedAt(x, z);
      if (!p) break;
      p.owner = 'service';
      p.facing = p.prevFacing = v.yaw + Math.PI;
      w.peds.tags.look[p.id] = u.kind === 'ambulance' ? Look.medic : Look.firefighter;
      u.crew[u.crewN] = p.id;
      u.phase[u.crewN] = OUT;
      u.crewN++;
    }
  }

  private stepCrew(u: ServiceUnit, v: Vehicle, c: ServiceCall, dt: number): void {
    const w = this.world;
    const cfg = this.config;
    const tags = w.peds.tags;
    const needed = c.active && this.needed(c);
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    const back = v.params.length / 2 + 0.7;
    const doorX = v.x - fx * back;
    const doorZ = v.z - fz * back;
    let working = 0;
    let aboard = 0;
    for (let i = 0; i < u.crewN; i++) {
      const p = w.peds.peds[u.crew[i]!];
      if (!p || !p.active || p.owner !== 'service' || p.state === 'down') {
        // Lost a crew member (knocked down, cleared away): count them as aboard.
        if (u.phase[i] !== ABOARD && p && p.active && p.owner === 'service') p.owner = 'ambient';
        u.phase[i] = ABOARD;
        aboard++;
        continue;
      }
      // Crews do not cower: they keep working.
      if (p.state !== 'wander') p.state = 'wander';
      if (!needed && u.phase[i]! < BACK) u.phase[i] = BACK;
      const side = i % 2 === 0 ? 1 : -1;
      if (u.phase[i] === OUT || u.phase[i] === WORK) {
        let tx: number;
        let tz: number;
        if (u.kind === 'ambulance') {
          // Kneel either side of the patient.
          const ax = c.x - doorX;
          const az = c.z - doorZ;
          const al = Math.hypot(ax, az) || 1;
          tx = c.x - (az / al) * 0.75 * side - (ax / al) * 0.2;
          tz = c.z + (ax / al) * 0.75 * side - (az / al) * 0.2;
        } else {
          // Stand off the wreck, either side of the line from the tender.
          const ax = v.x - c.x;
          const az = v.z - c.z;
          const base = Math.atan2(ax, az) + side * 0.45 * Math.ceil((i + 1) / 2);
          tx = c.x + Math.sin(base) * cfg.hoseRange;
          tz = c.z + Math.cos(base) * cfg.hoseRange;
        }
        const d = steerPed(p, tx, tz, cfg.walkSpeed, 0.35);
        if (d < 0.6 || (u.scene > 14 && d < 3)) {
          u.phase[i] = WORK;
          stopPed(p);
          p.facing = Math.atan2(c.x - p.x, c.z - p.z);
          tags.anim[p.id] = u.kind === 'ambulance' ? Anim.kneel : Anim.hose;
          tags.lookX[p.id] = c.x;
          tags.lookZ[p.id] = c.z;
          working++;
        } else tags.anim[p.id] = Anim.none;
      } else if (u.phase[i] === BACK) {
        tags.anim[p.id] = Anim.none;
        const d = steerPed(p, doorX, doorZ, cfg.walkSpeed, 0.3);
        if (d < 0.9 || u.scene > 60) {
          u.phase[i] = ABOARD;
          w.peds.despawn(p);
        }
      } else aboard++;
    }
    if (needed && working > 0) {
      if (u.kind === 'ambulance') {
        u.work += dt;
        if (u.work >= cfg.reviveSec) {
          const p = w.peds.peds[c.target]!;
          w.peds.revive(p);
          w.events.push({ type: 'pedRevived', pedId: p.id, x: p.x, z: p.z });
          this.nextJob(u, v, c);
        }
      } else {
        const b = Math.max(0, this.burn[c.target]! - cfg.hoseRate * working * dt);
        this.burn[c.target] = b;
        if (b <= 0) {
          w.events.push({ type: 'fireOut', vehicleId: c.target, x: c.x, z: c.z });
          this.nextJob(u, v, c);
        }
      }
    }
    // No crew got out (pool full) and nothing to do, or everyone is back aboard.
    if ((u.crewN === 0 && (!needed || u.scene > 20)) || (u.crewN > 0 && aboard >= u.crewN)) this.leave(u, v);
  }

  /** Done with this call: take the next one close by, or head back. */
  private nextJob(u: ServiceUnit, v: Vehicle, c: ServiceCall): void {
    const w = this.world;
    this.close(c);
    u.work = 0;
    let best: ServiceCall | null = null;
    let bd = u.kind === 'ambulance' ? 16 : 22;
    for (const o of this.calls) {
      if (!o.active || o.unit >= 0 || o.kind !== u.kind || !this.needed(o)) continue;
      const d = Math.hypot(o.x - v.x, o.z - v.z);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    if (best) {
      best.unit = u.id;
      u.call = this.calls.indexOf(best);
      for (let i = 0; i < u.crewN; i++) if (u.phase[i] === WORK) u.phase[i] = OUT;
      u.scene = 0;
      return;
    }
    for (let i = 0; i < u.crewN; i++) {
      if (u.phase[i] === ABOARD) continue;
      u.phase[i] = BACK;
      const id = u.crew[i]!;
      if (id >= 0) w.peds.tags.anim[id] = Anim.none;
    }
  }

  /** Lights off; join the traffic on the road it stopped on. */
  private leave(u: ServiceUnit, v: Vehicle): void {
    const w = this.world;
    const c = this.calls[u.call];
    if (c && c.unit === u.id) {
      c.unit = -1;
      if (!this.needed(c)) this.close(c);
    }
    this.releaseCrew(u, false);
    if (v.active && !v.destroyed && v.role === 'service') {
      if (v.siren) w.events.push({ type: 'siren', vehicleId: v.id, on: false });
      v.siren = false;
      v.beacons = false;
      v.role = 'traffic';
      resetAiState(v.ai);
      v.ai.mode = 'drive';
      v.ai.navFrom = u.edgeFrom;
      v.ai.navTo = u.edgeTo;
      v.ai.navNext = -1;
      v.ai.cruise = w.content.traffic.cruiseSpeed;
      w.events.push({ type: 'serviceLeft', kind: u.kind, vehicleId: v.id, x: v.x, z: v.z });
    }
    u.active = false;
    u.vehicleId = -1;
    u.call = -1;
  }

  /** The vehicle was taken or destroyed: the crew is on its own. */
  private abort(u: ServiceUnit, v: Vehicle): void {
    const c = this.calls[u.call];
    if (c && c.unit === u.id) c.unit = -1;
    this.releaseCrew(u, true);
    if (v.siren) this.world.events.push({ type: 'siren', vehicleId: v.id, on: false });
    v.siren = false;
    v.beacons = false;
    u.active = false;
    u.vehicleId = -1;
    u.call = -1;
  }

  private releaseCrew(u: ServiceUnit, scared: boolean): void {
    const w = this.world;
    for (let i = 0; i < u.crewN; i++) {
      const p = w.peds.peds[u.crew[i]!];
      if (u.phase[i] === ABOARD || !p || !p.active || p.owner !== 'service') continue;
      p.owner = 'ambient';
      w.peds.tags.anim[p.id] = Anim.none;
      if (scared) {
        p.state = 'flee';
        p.timer = 6;
        p.threatX = w.player.x;
        p.threatZ = w.player.z;
      } else p.timer = 0;
    }
    u.crewN = 0;
  }
}

/** Walk a steered ped towards a point. Returns the distance left. */
export function steerPed(p: Ped, tx: number, tz: number, speed: number, stopAt: number): number {
  const dx = tx - p.x;
  const dz = tz - p.z;
  const d = Math.hypot(dx, dz);
  if (d <= stopAt) {
    stopPed(p);
    return d;
  }
  p.vx = (dx / d) * speed;
  p.vz = (dz / d) * speed;
  p.facing = Math.atan2(dx, dz);
  p.body?.setLinvel({ x: p.vx, y: 0, z: p.vz }, true);
  return d;
}

export function stopPed(p: Ped): void {
  p.vx = 0;
  p.vz = 0;
  p.body?.setLinvel({ x: 0, y: 0, z: 0 }, true);
}

function right(dx: number, dz: number): [number, number] {
  const len = Math.hypot(dx, dz) || 1;
  return [-dz / len, dx / len];
}
