import { curveAt, type CrowdsConfig } from './life-config';
import { Anim, hasUmbrella } from './ped-tags';
import { Cell, cityGrid, onPavement } from './street';
import { districtAt } from './citygen';
import { trafficLight } from './traffic';
import { steerPed, stopPed } from './services';
import type { NavNode } from './nav';
import type { Ped } from './peds';
import type { World } from './world';

/**
 * Crowd life on top of the ambient pedestrians:
 * - people walk in twos and threes (followers keep pace beside a leader);
 * - wanderers near a junction go to the zebra crossing, wait at the kerb and
 *   cross only while the traffic on that road has a red light;
 * - in a storm, people without umbrellas shelter in doorways;
 * - a wreck, someone knocked down or a gang stand-off draws a ring of onlookers
 *   (phones up), who scatter as soon as shots ring out;
 * - a car mounting the pavement sends the people ahead of it diving aside;
 * - ambient density follows the district and the time of day.
 * People rarely wander straight across the road any more (most cross at junctions).
 *
 * A ped with a crowd task is owned by this system (`owner: 'crowd'`), still part
 * of the ambient population; any scare (alarm, knock-down) hands it straight
 * back to the ped system.
 */

const Task = { none: 0, follow: 1, cross: 2, gawk: 3, shelter: 4 } as const;
const MAX_INCIDENTS = 8;

export type IncidentKind = 'wreck' | 'hurt' | 'fight';

export interface CrowdIncident {
  active: boolean;
  kind: IncidentKind;
  x: number;
  z: number;
  /** Seconds left, and seconds since it happened. */
  timer: number;
  age: number;
  /** Onlookers drawn to it. */
  count: number;
}

export class CrowdSystem {
  config: CrowdsConfig;
  readonly incidents: CrowdIncident[] = [];
  /** Per ped: task, phase within it, goal, crossing end, junction, road axis, timer, incident. */
  readonly task: Uint8Array;
  readonly phase: Uint8Array;
  private readonly gx: Float32Array;
  private readonly gz: Float32Array;
  private readonly ex: Float32Array;
  private readonly ez: Float32Array;
  private readonly node: Int32Array;
  private readonly axisX: Uint8Array;
  private readonly timer: Float32Array;
  private readonly incident: Int8Array;
  /** Current ambient density multiplier (district and hour), for HUD and tests. */
  density = 1;

  constructor(private readonly world: World) {
    this.config = world.content.life.crowds;
    const n = world.peds.peds.length;
    this.task = new Uint8Array(n);
    this.phase = new Uint8Array(n);
    this.gx = new Float32Array(n);
    this.gz = new Float32Array(n);
    this.ex = new Float32Array(n);
    this.ez = new Float32Array(n);
    this.node = new Int32Array(n);
    this.axisX = new Uint8Array(n);
    this.timer = new Float32Array(n);
    this.incident = new Int8Array(n).fill(-1);
    for (let i = 0; i < MAX_INCIDENTS; i++) this.incidents.push({ active: false, kind: 'wreck', x: 0, z: 0, timer: 0, age: 0, count: 0 });
    world.peds.spawnHooks.push((p, ambient) => this.onSpawn(p, ambient));
    world.peds.targetFilter = (x0, z0, x1, z1) => this.walkable(x0, z0, x1, z1);
  }

  // ------------------------------------------------------------ hooks

  private onSpawn(p: Ped, ambient: boolean): void {
    const w = this.world;
    this.task[p.id] = Task.none;
    this.incident[p.id] = -1;
    if (!ambient || this.config.groupMax <= 0 || !w.rng.chance(this.config.groupChance)) return;
    const peds = w.peds;
    const n = w.rng.int(1, this.config.groupMax);
    const room = Math.max(peds.cap, peds.cap + peds.extra) - peds.activeCount();
    const map = w.content.map;
    for (let i = 0; i < Math.min(n, room); i++) {
      const side = i === 0 ? 1 : -1;
      const x = p.x + Math.cos(p.facing) * 0.9 * side;
      const z = p.z - Math.sin(p.facing) * 0.9 * side;
      if (!onPavement(map, x, z) || w.insideBuilding(x, z, 0.5)) continue;
      const q = peds.spawnPedAt(x, z);
      if (!q) return;
      q.owner = 'crowd';
      q.facing = q.prevFacing = p.facing;
      this.task[q.id] = Task.follow;
      peds.tags.leader[q.id] = p.id;
    }
  }

  /** Wander targets: mostly not straight across a road (people cross at junctions). */
  private walkable(x0: number, z0: number, x1: number, z1: number): boolean {
    if (!this.crossesRoad(x0, z0, x1, z1)) return true;
    return this.world.rng.chance(0.12);
  }

  private crossesRoad(x0: number, z0: number, x1: number, z1: number): boolean {
    const g = cityGrid(this.world.content.map);
    const d = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.ceil(d / 1.2);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const c = g.at(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
      if (c & Cell.road && !(c & Cell.alley)) return true;
    }
    return false;
  }

  /** Something worth watching at (x, z). */
  addIncident(x: number, z: number, kind: IncidentKind): void {
    for (const i of this.incidents) {
      if (i.active && Math.hypot(i.x - x, i.z - z) < 10) {
        i.timer = Math.max(i.timer, this.config.gawkSec);
        if (kind === 'fight') i.kind = 'fight';
        return;
      }
    }
    const i = this.incidents.find((q) => !q.active);
    if (!i) return;
    i.active = true;
    i.kind = kind;
    i.x = x;
    i.z = z;
    i.timer = this.config.gawkSec;
    i.age = 0;
    i.count = 0;
  }

  /** Hand a ped back to the ped system. */
  release(p: Ped): void {
    const inc = this.incident[p.id]!;
    if (inc >= 0) {
      const i = this.incidents[inc]!;
      i.count = Math.max(0, i.count - 1);
    }
    this.task[p.id] = Task.none;
    this.incident[p.id] = -1;
    const tags = this.world.peds.tags;
    tags.anim[p.id] = Anim.none;
    tags.leader[p.id] = -1;
    if (p.owner === 'crowd') p.owner = 'ambient';
    if (p.state === 'wander') {
      p.timer = 0;
      p.targetX = p.x;
      p.targetZ = p.z;
    }
  }

  // ------------------------------------------------------------ crossings

  /**
   * May people start across the road at junction `j` that runs along x
   * (`alongX`)? Only while its traffic has a red light, with time to get over.
   */
  canCross(j: NavNode, alongX: boolean, crossSec: number): boolean {
    const w = this.world;
    const cfg = w.content.traffic.lights;
    if (trafficLight(j, alongX, w.time, cfg) !== 'red') return false;
    const half = cfg.green + cfg.amber + cfg.allRed;
    const cycle = half * 2;
    const t = (((w.time + ((j.id * 7.31) % cycle)) % cycle) + cycle) % cycle;
    const local = alongX ? t : (t + half) % cycle;
    return cycle - local >= crossSec * 0.8;
  }

  /**
   * Send a ped to cross at a junction: walk to the kerb end of the zebra nearest
   * them, wait for the red, cross. Optionally pick the junction and road.
   */
  startCrossing(p: Ped, nodeId = -1, edgeId = -1): boolean {
    const w = this.world;
    const g = w.roads;
    const map = w.content.map;
    const J = nodeId >= 0 ? g.nodes[nodeId]! : g.nearest(p.x, p.z, (n) => n.junction);
    if (!J.junction || Math.hypot(J.x - p.x, J.z - p.z) > this.config.crossRadius) return false;
    let best = Infinity;
    let pick = -1;
    let sx = 0;
    let sz = 0;
    let tx = 0;
    let tz = 0;
    for (const id of J.edges) {
      const e = g.edges[id]!;
      if (e.kind === 'alley' || (edgeId >= 0 && id !== edgeId)) continue;
      const other = g.nodes[e.a === J.id ? e.b : e.a]!;
      const len = Math.hypot(other.x - J.x, other.z - J.z) || 1;
      const dx = (other.x - J.x) / len;
      const dz = (other.z - J.z) / len;
      // The zebra sits just outside the junction box (painted 0.8-3.8 m past it).
      let box = 0;
      for (const k of J.edges) {
        const f = g.edges[k]!;
        if (f.alongX !== e.alongX) box = Math.max(box, f.width / 2);
      }
      const cx = J.x + dx * (box + 2.3);
      const cz = J.z + dz * (box + 2.3);
      const half = e.width / 2 + 1.1;
      const ax = cx - dz * half;
      const az = cz + dx * half;
      const bx = cx + dz * half;
      const bz = cz - dx * half;
      if (!onPavement(map, ax, az) || !onPavement(map, bx, bz) || w.insideBuilding(ax, az, 0.4) || w.insideBuilding(bx, bz, 0.4)) continue;
      const da = Math.hypot(ax - p.x, az - p.z);
      const db = Math.hypot(bx - p.x, bz - p.z);
      const [s0x, s0z, s1x, s1z, d] = da <= db ? [ax, az, bx, bz, da] : [bx, bz, ax, az, db];
      if (d >= best || this.crossesRoad(p.x, p.z, s0x, s0z)) continue;
      best = d;
      pick = id;
      // People queue side by side along the kerb, not on one spot.
      const jitter = ((p.id % 3) - 1) * 0.7;
      const back = (p.id % 2) * 0.5;
      const kx = (s0x - s1x) / (2 * half);
      const kz = (s0z - s1z) / (2 * half);
      sx = s0x + dx * jitter + kx * back;
      sz = s0z + dz * jitter + kz * back;
      tx = s1x + dx * jitter;
      tz = s1z + dz * jitter;
    }
    if (pick < 0) return false;
    if (p.owner !== 'ambient' && p.owner !== 'crowd') return false;
    if (this.task[p.id] !== Task.none) this.release(p);
    p.owner = 'crowd';
    this.task[p.id] = Task.cross;
    this.phase[p.id] = 0;
    this.gx[p.id] = sx;
    this.gz[p.id] = sz;
    this.ex[p.id] = tx;
    this.ez[p.id] = tz;
    this.node[p.id] = J.id;
    this.axisX[p.id] = g.edges[pick]!.alongX ? 1 : 0;
    this.timer[p.id] = 0;
    return true;
  }

  // ------------------------------------------------------------ step

  step(dt: number): void {
    const w = this.world;
    const cfg = this.config;
    if (w.tick % 60 === 29) this.updateDensity();
    for (const i of this.incidents) {
      if (!i.active) continue;
      i.age += dt;
      i.timer -= dt;
      if (i.timer <= 0) i.active = false;
    }
    if (w.tick % 3 === 0) this.pavementDanger();
    const period = Math.max(1, Math.round(60 / cfg.aiHz));
    const storm = w.weather.rain >= cfg.shelterRain;
    for (const p of w.peds.peds) {
      if (!p.active) continue;
      const id = p.id;
      const t = this.task[id]!;
      if (p.owner === 'crowd') {
        if (p.state !== 'wander') {
          // Scared (alarm, near miss, knocked down): back to the ped system.
          this.release(p);
          continue;
        }
        this.timer[id]! += dt;
        if (t === Task.follow) this.follow(p);
        else if (t === Task.cross) this.cross(p);
        else if (t === Task.gawk) this.gawk(p);
        else if (t === Task.shelter) this.shelter(p, storm);
        else this.release(p);
        continue;
      }
      if (t !== Task.none) this.task[id] = Task.none;
      if (p.owner !== 'ambient' || p.state !== 'wander' || (w.tick + id) % period !== 0) continue;
      if (w.peds.tags.actor[id]) continue;
      this.decide(p, storm);
    }
  }

  /** Post-physics: wrecks and knock-downs draw onlookers. */
  postStep(): void {
    const w = this.world;
    for (const e of w.events) {
      if (e.type === 'vehicleDestroyed') this.addIncident(e.x, e.z, 'wreck');
      else if (e.type === 'pedHit' && w.distToPlayer(e.x, e.z) < 80) this.addIncident(e.x, e.z, 'hurt');
    }
  }

  private updateDensity(): void {
    const w = this.world;
    const cfg = this.config;
    const map = w.content.map;
    const d = districtAt(map, w.player.x, w.player.z);
    const style = d >= 0 ? map.districts[d]!.style : '';
    const curve = cfg.density[style];
    const mult = curve ? Math.min(1 + cfg.maxBoost, curveAt(curve, w.weather.hour)) : 1;
    this.density = mult;
    // Room taken by mission actors (each raised the cap by one) is not ambient.
    let actorPeds = 0;
    for (const a of w.actors.actors) if (a.active && a.pedId >= 0) actorPeds++;
    const base = Math.max(0, w.peds.cap - actorPeds);
    const room = w.peds.peds.length - 34 - w.peds.cap;
    w.peds.extra = Math.min(Math.max(0, room), Math.round(base * (mult - 1)));
  }

  private decide(p: Ped, storm: boolean): void {
    const w = this.world;
    const cfg = this.config;
    // Storm: duck into a doorway (umbrella carriers walk on).
    if (storm && !hasUmbrella(p.id, cfg.umbrellaShare) && w.rng.chance(cfg.shelterShare * 0.4) && this.startShelter(p)) return;
    // Something to watch nearby?
    for (let k = 0; k < this.incidents.length; k++) {
      const i = this.incidents[k]!;
      if (!i.active || i.age < 1.5 || i.count >= cfg.gawkMax) continue;
      if (Math.hypot(i.x - p.x, i.z - p.z) > cfg.gawkRadius) continue;
      if (w.rng.chance(0.35) && this.startGawk(p, k)) return;
    }
    if (w.rng.chance(cfg.crossChance / cfg.aiHz)) this.startCrossing(p);
  }

  private follow(p: Ped): void {
    const w = this.world;
    const tags = w.peds.tags;
    const lead = w.peds.peds[tags.leader[p.id]!];
    if (!lead || !lead.active || lead.state === 'down') {
      this.release(p);
      return;
    }
    if (lead.state === 'flee' || lead.state === 'cower') {
      // The leader ran: so do we.
      this.release(p);
      p.state = 'flee';
      p.timer = lead.timer;
      p.threatX = lead.threatX;
      p.threatZ = lead.threatZ;
      return;
    }
    const side = p.id % 2 === 0 ? 1 : -1;
    const f = lead.facing;
    const tx = lead.x + Math.cos(f) * 0.85 * side - Math.sin(f) * 0.25;
    const tz = lead.z - Math.sin(f) * 0.85 * side - Math.cos(f) * 0.25;
    const ls = Math.hypot(lead.vx, lead.vz);
    const d = Math.hypot(tx - p.x, tz - p.z);
    if (d > 25) {
      this.release(p);
      return;
    }
    if (d < 0.3 && ls < 0.2) {
      stopPed(p);
      // Chatting: turned a little towards the leader.
      p.facing = f - side * 0.6;
      return;
    }
    steerPed(p, tx, tz, Math.min(w.content.peds.runSpeed, ls + d * 1.6), 0.15);
    if (ls > 0.3) p.facing = f;
  }

  private cross(p: Ped): void {
    const w = this.world;
    const id = p.id;
    const tags = w.peds.tags;
    const ph = this.phase[id]!;
    const walk = w.content.peds.walkSpeed;
    if (ph === 0) {
      tags.anim[id] = Anim.none;
      if (steerPed(p, this.gx[id]!, this.gz[id]!, walk, 0.35) < 0.5) {
        this.phase[id] = 1;
        this.timer[id] = 0;
      } else if (this.timer[id]! > 25) this.release(p);
      return;
    }
    if (ph === 1) {
      stopPed(p);
      p.facing = Math.atan2(this.ex[id]! - p.x, this.ez[id]! - p.z);
      tags.anim[id] = Anim.wait;
      tags.lookX[id] = this.ex[id]!;
      tags.lookZ[id] = this.ez[id]!;
      const span = Math.hypot(this.ex[id]! - this.gx[id]!, this.ez[id]! - this.gz[id]!);
      if (this.canCross(w.roads.nodes[this.node[id]!]!, this.axisX[id] === 1, span / this.config.crossSpeed)) {
        this.phase[id] = 2;
        this.timer[id] = 0;
      } else if (this.timer[id]! > 45) this.release(p);
      return;
    }
    tags.anim[id] = Anim.none;
    if (steerPed(p, this.ex[id]!, this.ez[id]!, this.config.crossSpeed, 0.4) < 0.6 || this.timer[id]! > 30) this.release(p);
  }

  private startGawk(p: Ped, k: number): boolean {
    const w = this.world;
    const map = w.content.map;
    const i = this.incidents[k]!;
    const [r0, r1] = this.config.gawkRing;
    const extra = i.kind === 'fight' ? 9 : i.kind === 'hurt' ? -2 : 0;
    const base = Math.atan2(p.x - i.x, p.z - i.z);
    for (let tries = 0; tries < 6; tries++) {
      const a = base + w.rng.range(-0.9, 0.9);
      const r = w.rng.range(r0, r1) + extra;
      const x = i.x + Math.sin(a) * r;
      const z = i.z + Math.cos(a) * r;
      const c = cityGrid(map).at(x, z);
      if (c & (Cell.building | Cell.water) || w.insideBuilding(x, z, 0.5)) continue;
      // Onlookers stand on the pavement unless the wreck is out in the road with nowhere else to stand.
      if (c & Cell.road && tries < 4) continue;
      p.owner = 'crowd';
      this.task[p.id] = Task.gawk;
      this.phase[p.id] = 0;
      this.gx[p.id] = x;
      this.gz[p.id] = z;
      this.incident[p.id] = k;
      this.timer[p.id] = 0;
      i.count++;
      return true;
    }
    return false;
  }

  private gawk(p: Ped): void {
    const w = this.world;
    const k = this.incident[p.id]!;
    const i = k >= 0 ? this.incidents[k] : undefined;
    if (!i || !i.active || this.timer[p.id]! > 40) {
      this.release(p);
      return;
    }
    const tags = w.peds.tags;
    if (steerPed(p, this.gx[p.id]!, this.gz[p.id]!, w.content.peds.walkSpeed * 1.25, 0.35) > 0.5) {
      tags.anim[p.id] = Anim.none;
      return;
    }
    p.facing = Math.atan2(i.x - p.x, i.z - p.z);
    tags.anim[p.id] = Anim.gawk;
    tags.lookX[p.id] = i.x;
    tags.lookZ[p.id] = i.z;
  }

  private startShelter(p: Ped): boolean {
    const w = this.world;
    const g = cityGrid(w.content.map);
    let best = 99;
    let bdx = 0;
    let bdz = 0;
    for (const [dx, dz] of DIRS) {
      for (let k = 1; k <= 14 && k < best; k++) {
        const c = g.at(p.x + dx * k, p.z + dz * k);
        if (c & Cell.road) break;
        if (c & Cell.building) {
          best = k;
          bdx = dx;
          bdz = dz;
          break;
        }
      }
    }
    if (best > 14) return false;
    const jitter = w.rng.range(-1.5, 1.5);
    const x = p.x + bdx * (best - 1.1) + bdz * jitter;
    const z = p.z + bdz * (best - 1.1) - bdx * jitter;
    if (w.insideBuilding(x, z, 0.3) || !onPavement(w.content.map, x, z)) return false;
    p.owner = 'crowd';
    this.task[p.id] = Task.shelter;
    this.phase[p.id] = 0;
    this.gx[p.id] = x;
    this.gz[p.id] = z;
    this.ex[p.id] = x - bdx * 3;
    this.ez[p.id] = z - bdz * 3;
    this.timer[p.id] = 0;
    return true;
  }

  private shelter(p: Ped, storm: boolean): void {
    const w = this.world;
    const tags = w.peds.tags;
    if (!storm && w.weather.rain < this.config.shelterRain - 0.15) {
      this.release(p);
      return;
    }
    if (steerPed(p, this.gx[p.id]!, this.gz[p.id]!, w.content.peds.walkSpeed * 1.35, 0.3) > 0.45) {
      tags.anim[p.id] = Anim.none;
      if (this.timer[p.id]! > 20) this.release(p);
      return;
    }
    p.facing = Math.atan2(this.ex[p.id]! - p.x, this.ez[p.id]! - p.z);
    tags.anim[p.id] = Anim.shelter;
  }

  /** People in the path of a car driving along the pavement throw themselves aside. */
  private pavementDanger(): void {
    const w = this.world;
    const cfg = this.config.pavementDanger;
    for (const v of w.vehicles) {
      if (!v.active || v.destroyed || !(v.kerbFront || v.kerbRear)) continue;
      const sp = Math.hypot(v.vx, v.vz);
      if (sp < cfg.minSpeed) continue;
      const fx = v.vx / sp;
      const fz = v.vz / sp;
      const range = cfg.range + sp * 0.3;
      for (const p of w.peds.peds) {
        if (!p.active || p.state === 'down' || p.state === 'flee') continue;
        if (p.owner !== 'ambient' && p.owner !== 'crowd') continue;
        const dx = p.x - v.x;
        const dz = p.z - v.z;
        const ahead = dx * fx + dz * fz;
        if (ahead < -1 || ahead > range) continue;
        const lat = dx * fz - dz * fx;
        if (Math.abs(lat) > cfg.lateral + v.params.width / 2) continue;
        if (p.owner === 'crowd') this.release(p);
        const side = lat >= 0 ? 1 : -1;
        p.state = 'flee';
        p.timer = 1.1;
        // Away from the car's line, a little forward.
        p.threatX = p.x - fz * side * 5 - fx * 1.5;
        p.threatZ = p.z + fx * side * 5 - fz * 1.5;
        w.events.push({ type: 'pedDive', pedId: p.id, x: p.x, z: p.z });
      }
    }
  }

  /** Current task of a ped (for tests and the debug overlay). */
  taskOf(pedId: number): 'none' | 'follow' | 'cross' | 'gawk' | 'shelter' {
    const t = this.task[pedId]!;
    return t === Task.follow ? 'follow' : t === Task.cross ? 'cross' : t === Task.gawk ? 'gawk' : t === Task.shelter ? 'shelter' : 'none';
  }
}

const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
