import { resetAiState } from './ai';
import { clamp } from './physics';
import { Rng } from './rng';
import { districtAt } from './citygen';
import { onPavement } from './street';
import { Anim, Look } from './ped-tags';
import { steerPed, stopPed } from './services';
import type { CrewLook, GangCrew, GangsConfig } from './life-config';
import type { Ped } from './peds';
import type { Vehicle, World } from './world';

/**
 * Street crews. Each crew's members hang about in groups at spots in its home
 * district (spawned out of view near the player, gone when the player is far),
 * dressed in the crew colour with a silhouette detail of their own (hood,
 * visor, hat, beanie, crest), and the crew's cars cruise its turf in its colour.
 *
 * How they treat the player follows the player's respect with the crew
 * (`setRespect`, fed from the save through the mission director):
 * - friendly (respect >= friendlyAt): they nod as you pass, and join in when
 *   police officers come for you near them;
 * - neutral: they leave you alone unless you attack one of them (the group then
 *   holds a grudge for a while);
 * - hostile (respect <= hostileAt): they shoot on sight in their turf.
 *
 * Rival crews clash now and then: a squad walks into the other crew's patch,
 * they square up (crowds gather), then shoot it out.
 *
 * Attacking a crew member is a police matter only when police see it
 * (`reportAttack`).
 */

export type Attitude = 'friendly' | 'neutral' | 'hostile';
type GroupMode = 'loiter' | 'fight' | 'raid' | 'standoff' | 'brawl' | 'retreat';
/** What a fighting group is after. */
type Target = 'none' | 'player' | 'police' | 'rival';

const MAX_MEMBERS = 36;
const MAX_GROUPS = 12;
const SLOT_RADIUS = 1.7;

export interface GangCrewRuntime {
  id: string;
  name: string;
  colour: string;
  look: CrewLook;
  trousers: string;
  config: GangCrew;
  /** Index into map.districts. */
  district: number;
  respect: number;
  spots: { x: number; z: number }[];
  /** Group occupying each spot (-1), and seconds before a spot may fill again. */
  spotGroup: Int16Array;
  spotCooldown: Float32Array;
  /** Drivable road edges inside the turf (for crew cars). */
  edges: number[];
}

export interface GangMember {
  id: number;
  active: boolean;
  pedId: number;
  crew: number;
  group: number;
  armed: boolean;
  /** Ring slot around the group's spot. */
  slot: number;
  fireCooldown: number;
  nodCooldown: number;
  /** Target this member is shooting at: officer id or rival ped id (-1 = the player / none). */
  targetId: number;
}

export interface GangGroup {
  id: number;
  active: boolean;
  crew: number;
  /** Loitering spot index in the crew's list, or -1 for a rival squad. */
  spot: number;
  x: number;
  z: number;
  mode: GroupMode;
  target: Target;
  /** Seconds left of a grudge against the player. */
  grudge: number;
  /** The other group in a clash, or -1. */
  rival: number;
  timer: number;
  /** Seconds since any member last saw the player (fights end when it runs long). */
  unseen: number;
  nodTimer: number;
}

export class GangSystem {
  readonly crews: GangCrewRuntime[] = [];
  readonly members: GangMember[] = [];
  readonly groups: GangGroup[] = [];
  config: GangsConfig;
  /** Most crew members around at once (quality tiers set it; by default it follows the ambient crowd size). */
  cap: number;
  /** Most crew cars around at once (by default one, if there is traffic at all). */
  carCap: number;
  /** Crew index of each vehicle cruising for a crew (-1 for none). */
  readonly carCrew: Int8Array;
  /** Ped ids of members currently fighting the player (auto-aim reads these). */
  readonly hostilePeds: Int16Array;
  hostileCount = 0;
  private fightTimer: number;
  private readonly heard: number[] = [];
  private readonly crewIndex = new Map<string, number>();

  constructor(private readonly world: World) {
    this.config = world.content.life.gangs;
    this.cap = Math.round(world.content.peds.count * 0.7);
    this.carCap = world.content.traffic.count > 0 ? 1 : 0;
    const map = world.content.map;
    this.carCrew = new Int8Array(world.vehicles.length).fill(-1);
    this.hostilePeds = new Int16Array(MAX_MEMBERS);
    for (let i = 0; i < MAX_MEMBERS; i++) {
      this.members.push({ id: i, active: false, pedId: -1, crew: 0, group: -1, armed: false, slot: 0, fireCooldown: 0, nodCooldown: 0, targetId: -1 });
    }
    for (let i = 0; i < MAX_GROUPS; i++) {
      this.groups.push({ id: i, active: false, crew: 0, spot: -1, x: 0, z: 0, mode: 'loiter', target: 'none', grudge: 0, rival: -1, timer: 0, unseen: 0, nodTimer: 0 });
    }
    // Loitering spots: chosen once per map from a generator seeded by the world seed (layout, like the city itself).
    for (const [id, cfg] of Object.entries(this.config.crews)) {
      const info = world.content.crews[id];
      if (!info) continue;
      const district = map.districts.findIndex((d) => d.id === info.district);
      if (district < 0) continue;
      const idx = this.crews.length;
      this.crewIndex.set(id, idx);
      const spots = this.layoutSpots(district, (world.seed * 7919 + idx * 104729 + 13) >>> 0);
      const edges: number[] = [];
      for (const e of world.roads.edges) {
        if (e.kind === 'alley') continue;
        const a = world.roads.nodes[e.a]!;
        const b = world.roads.nodes[e.b]!;
        if (districtAt(map, (a.x + b.x) / 2, (a.z + b.z) / 2) === district) edges.push(e.id);
      }
      this.crews.push({
        id,
        name: info.name,
        colour: info.colour,
        look: cfg.look,
        trousers: cfg.trousers,
        config: cfg,
        district,
        respect: 0,
        spots,
        spotGroup: new Int16Array(spots.length).fill(-1),
        spotCooldown: new Float32Array(spots.length),
        edges,
      });
    }
    const [f0, f1] = this.config.fight.intervalSec;
    this.fightTimer = (f0 + f1) / 2;
  }

  /** Pavement and yard spots in a district, well apart and clear of walls. */
  private layoutSpots(district: number, seed: number): { x: number; z: number }[] {
    const w = this.world;
    const map = w.content.map;
    const rng = new Rng(seed);
    const rects = map.districts[district]!.rects;
    const out: { x: number; z: number }[] = [];
    const want = this.config.spotsPerDistrict;
    for (let tries = 0; tries < want * 60 && out.length < want; tries++) {
      const r = rects[rng.int(0, rects.length - 1)]!;
      const x = rng.range(r[0] + 10, r[2] - 10);
      const z = rng.range(r[1] + 10, r[3] - 10);
      if (!onPavement(map, x, z) || w.insideBuilding(x, z, 2.5)) continue;
      // Room for the ring: no road or wall within a few metres.
      let clear = true;
      for (let a = 0; a < 8 && clear; a++) {
        const px = x + Math.cos(a * 0.785) * (SLOT_RADIUS + 0.8);
        const pz = z + Math.sin(a * 0.785) * (SLOT_RADIUS + 0.8);
        if (!onPavement(map, px, pz) || w.insideBuilding(px, pz, 0.5)) clear = false;
      }
      if (!clear) continue;
      if (out.some((s) => Math.hypot(s.x - x, s.z - z) < 45)) continue;
      out.push({ x, z });
    }
    return out;
  }

  // ------------------------------------------------------------ respect

  crewIdOf(index: number): string {
    return this.crews[index]?.id ?? '';
  }

  indexOf(crew: string): number {
    return this.crewIndex.get(crew) ?? -1;
  }

  setRespect(crew: string, value: number): void {
    const i = this.indexOf(crew);
    if (i >= 0) this.crews[i]!.respect = value;
  }

  /** Respect for every crew at once (missing crews count as 0). */
  setAllRespect(respect: Readonly<Record<string, number>>): void {
    for (const c of this.crews) c.respect = respect[c.id] ?? 0;
  }

  respect(crew: string): number {
    return this.crews[this.indexOf(crew)]?.respect ?? 0;
  }

  attitude(crew: string | number): Attitude {
    const c = typeof crew === 'number' ? this.crews[crew] : this.crews[this.indexOf(crew)];
    if (!c) return 'neutral';
    if (c.respect >= this.config.friendlyAt) return 'friendly';
    if (c.respect <= this.config.hostileAt) return 'hostile';
    return 'neutral';
  }

  // ------------------------------------------------------------ queries

  /** The member for a ped, if it is a live crew member. */
  memberForPed(pedId: number): GangMember | null {
    for (const m of this.members) if (m.active && m.pedId === pedId) return m;
    return null;
  }

  /** Crew index of a ped (live member or body), or -1. */
  crewOfPed(pedId: number): number {
    const p = this.world.peds.peds[pedId];
    if (!p || p.owner !== 'gang') return -1;
    const look = this.world.peds.tags.look[pedId]!;
    return look >= Look.crew && look < Look.crew + this.crews.length ? look - Look.crew : -1;
  }

  /** Would hurting this ped be a police matter? Crew members only count when police see it. */
  reportable(pedId: number): boolean {
    if (this.crewOfPed(pedId) < 0) return true;
    const w = this.world;
    return w.police.policeSees(w.player.x, w.player.z);
  }

  /** The player hurt this ped: the member's group turns on them. Returns whether it is a police matter. */
  reportAttack(pedId: number): boolean {
    const m = this.memberForPed(pedId);
    if (m) this.provoke(this.groups[m.group]!);
    return this.reportable(pedId);
  }

  /** A crew car steering by its turf: the next node at a junction (-1 = not a crew car, let traffic choose). */
  chooseTurn(v: Vehicle, options: readonly number[]): number {
    const crew = this.carCrew[v.id]!;
    if (crew < 0 || options.length === 0) return -1;
    const map = this.world.content.map;
    const home = this.crews[crew]!.district;
    let n = 0;
    for (const id of options) {
      const node = this.world.roads.nodes[id]!;
      if (districtAt(map, node.x, node.z) === home) n++;
    }
    if (n === 0) return -1;
    let k = this.world.rng.int(0, n - 1);
    for (const id of options) {
      const node = this.world.roads.nodes[id]!;
      if (districtAt(map, node.x, node.z) !== home) continue;
      if (k-- === 0) return id;
    }
    return -1;
  }

  activeMembers(): number {
    let n = 0;
    for (const m of this.members) if (m.active) n++;
    return n;
  }

  // ------------------------------------------------------------ spawning

  /** Put a group of a crew at (x, z). Returns the group, or null if the pools are full. */
  spawnGroup(crew: number, x: number, z: number, size: number, spot = -1): GangGroup | null {
    const w = this.world;
    const c = this.crews[crew];
    const g = this.groups.find((q) => !q.active);
    if (!c || !g) return null;
    Object.assign(g, { active: true, crew, spot, x, z, mode: 'loiter', target: 'none', grudge: 0, rival: -1, timer: 0, unseen: 0, nodTimer: 0 });
    let made = 0;
    for (let i = 0; i < size; i++) {
      const m = this.members.find((q) => !q.active);
      if (!m) break;
      const a = (i / size) * Math.PI * 2 + w.rng.range(-0.3, 0.3);
      let px = x + Math.sin(a) * SLOT_RADIUS;
      let pz = z + Math.cos(a) * SLOT_RADIUS;
      if (w.insideBuilding(px, pz, 0.4)) {
        px = x;
        pz = z;
      }
      const p = w.peds.spawnPedAt(px, pz);
      if (!p) break;
      p.owner = 'gang';
      p.hp = this.config.hp;
      p.facing = p.prevFacing = Math.atan2(x - px, z - pz);
      m.active = true;
      m.pedId = p.id;
      m.crew = crew;
      m.group = g.id;
      m.armed = w.rng.chance(c.config.armed);
      m.slot = a;
      m.fireCooldown = w.rng.range(0.3, this.config.shotIntervalSec);
      m.nodCooldown = 0;
      m.targetId = -1;
      w.peds.tags.look[p.id] = Look.crew + crew;
      w.peds.tags.armed[p.id] = m.armed ? 1 : 0;
      w.peds.tags.anim[p.id] = Anim.loiter;
      made++;
    }
    if (made === 0) {
      g.active = false;
      return null;
    }
    if (spot >= 0) c.spotGroup[spot] = g.id;
    return g;
  }

  /** Remove a group (its live members leave the world; bodies stay to the ped system). */
  despawnGroup(g: GangGroup, cooldown: number): void {
    const w = this.world;
    for (const m of this.members) {
      if (!m.active || m.group !== g.id) continue;
      const p = w.peds.peds[m.pedId];
      if (p && p.active && p.state !== 'down') w.peds.despawn(p);
      m.active = false;
    }
    const c = this.crews[g.crew]!;
    if (g.spot >= 0 && c.spotGroup[g.spot] === g.id) {
      c.spotGroup[g.spot] = -1;
      c.spotCooldown[g.spot] = cooldown;
    }
    for (const o of this.groups) if (o.active && o.rival === g.id) o.rival = -1;
    g.active = false;
  }

  private outOfView(x: number, z: number): boolean {
    const w = this.world;
    const dx = x - w.player.x;
    const dz = z - w.player.z;
    return !(Math.abs(dx) < 70 && dz > -90 && dz < 50);
  }

  /** Once a second: groups in and out around the player, crew cars, rival clashes. */
  private stream(): void {
    const w = this.world;
    const cfg = this.config;
    const [r0, r1] = cfg.spawnDist;
    for (const g of this.groups) {
      if (!g.active) continue;
      let live = 0;
      let near = false;
      for (const m of this.members) {
        if (!m.active || m.group !== g.id) continue;
        live++;
        const p = w.peds.peds[m.pedId]!;
        if (w.distToPlayer(p.x, p.z) < cfg.despawnDist) near = true;
      }
      if (live === 0) this.despawnGroup(g, 90);
      else if (!near && (g.spot >= 0 || g.mode === 'retreat' || g.mode === 'raid')) this.despawnGroup(g, 20);
      else if (g.mode === 'retreat' && w.distToPlayer(g.x, g.z) > 70 && this.outOfView(g.x, g.z)) this.despawnGroup(g, 0);
    }
    for (let ci = 0; ci < this.crews.length; ci++) {
      const c = this.crews[ci]!;
      for (let s = 0; s < c.spots.length; s++) {
        if (c.spotCooldown[s]! > 0) c.spotCooldown[s] = Math.max(0, c.spotCooldown[s]! - 1);
        if (c.spotGroup[s]! >= 0 || c.spotCooldown[s]! > 0) continue;
        const sp = c.spots[s]!;
        const d = w.distToPlayer(sp.x, sp.z);
        if (d < r0 || d > r1 || !this.outOfView(sp.x, sp.z)) continue;
        const size = w.rng.int(cfg.groupSize[0], Math.max(cfg.groupSize[0], cfg.groupSize[1]));
        if (this.cap - this.activeMembers() < Math.min(size, cfg.groupSize[0])) continue;
        this.spawnGroup(ci, sp.x, sp.z, Math.min(size, this.cap - this.activeMembers()), s);
      }
    }
    this.streamCars();
    this.fightTimer -= 1;
    if (this.fightTimer <= 0) {
      const [f0, f1] = cfg.fight.intervalSec;
      this.fightTimer = w.rng.range(f0, Math.max(f0, f1));
      if (w.rng.chance(cfg.fight.chance)) this.startRandomFight();
    }
  }

  private streamCars(): void {
    const w = this.world;
    let n = 0;
    for (let i = 0; i < this.carCrew.length; i++) {
      if (this.carCrew[i]! < 0) continue;
      const v = w.vehicles[i]!;
      if (!v.active || v.role !== 'traffic') {
        // Gone, or the player took it (its paint stays): no longer cruising.
        if (!v.active) this.carCrew[i] = -1;
        continue;
      }
      n++;
    }
    if (n >= this.carCap) return;
    const d = districtAt(w.content.map, w.player.x, w.player.z);
    const crew = this.crews.findIndex((c) => c.district === d);
    if (crew < 0) return;
    const c = this.crews[crew]!;
    if (c.edges.length === 0) return;
    const g = w.roads;
    for (let tries = 0; tries < 12; tries++) {
      const e = g.edges[c.edges[w.rng.int(0, c.edges.length - 1)]!]!;
      const fwd = w.rng.chance(0.5);
      const a = g.nodes[fwd ? e.a : e.b]!;
      const b = g.nodes[fwd ? e.b : e.a]!;
      const len = e.length || 1;
      const dx = (b.x - a.x) / len;
      const dz = (b.z - a.z) / len;
      const off = e.width / 4;
      const x = (a.x + b.x) / 2 - dz * off;
      const z = (a.z + b.z) / 2 + dx * off;
      const dist = w.distToPlayer(x, z);
      if (dist < 100 || dist > 200 || !this.outOfView(x, z)) continue;
      let blocked = false;
      for (const o of w.vehicles) if (o.active && Math.hypot(o.x - x, o.z - z) < 12) blocked = true;
      if (blocked) continue;
      const v = w.spawnVehicle(c.config.cars[w.rng.int(0, c.config.cars.length - 1)]!, x, z, Math.atan2(dx, dz), 'traffic');
      if (!v) return;
      resetAiState(v.ai);
      v.ai.mode = 'drive';
      v.ai.navFrom = a.id;
      v.ai.navTo = b.id;
      v.ai.navNext = -1;
      v.ai.cruise = this.config.carCruise;
      this.carCrew[v.id] = crew;
      return;
    }
  }

  /** A rival squad walks in on a loitering group near the player. */
  private startRandomFight(): boolean {
    const w = this.world;
    for (const g of this.groups) {
      if (!g.active || g.spot < 0 || g.mode !== 'loiter') continue;
      if (w.distToPlayer(g.x, g.z) > 130) continue;
      const crewId = this.crews[g.crew]!.id;
      const rivals: number[] = [];
      for (const [a, b] of this.config.rivals) {
        if (a === crewId && this.indexOf(b) >= 0) rivals.push(this.indexOf(b));
        else if (b === crewId && this.indexOf(a) >= 0) rivals.push(this.indexOf(a));
      }
      if (rivals.length === 0) continue;
      return this.startFight(g, rivals[w.rng.int(0, rivals.length - 1)]!) !== null;
    }
    return false;
  }

  /** Send a squad of `rivalCrew` at group `g`. Returns the squad, or null. */
  startFight(g: GangGroup, rivalCrew: number): GangGroup | null {
    const w = this.world;
    const map = w.content.map;
    const size = Math.min(this.config.fight.squad, MAX_MEMBERS - this.activeMembers());
    if (size <= 0) return null;
    for (let tries = 0; tries < 16; tries++) {
      const a = w.rng.range(0, Math.PI * 2);
      const r = w.rng.range(40, 60);
      const x = g.x + Math.sin(a) * r;
      const z = g.z + Math.cos(a) * r;
      if (!onPavement(map, x, z) || w.insideBuilding(x, z, 2)) continue;
      if (!w.police.lineOfSight(x, z, g.x, g.z) && tries < 12) continue;
      const s = this.spawnGroup(rivalCrew, x, z, size, -1);
      if (!s) return null;
      s.mode = 'raid';
      s.rival = g.id;
      s.timer = 0;
      g.rival = s.id;
      return s;
    }
    return null;
  }

  // ------------------------------------------------------------ step

  step(dt: number): void {
    const w = this.world;
    if (w.tick % 60 === 17) this.stream();
    this.heard.length = 0;
    for (const e of w.events) if (e.type === 'shot' && e.byPlayer) this.heard.push(e.x, e.z);
    const period = Math.max(1, Math.round(60 / this.config.aiHz));
    for (const g of this.groups) {
      if (!g.active) continue;
      if (g.grudge > 0) g.grudge = Math.max(0, g.grudge - dt);
      g.nodTimer = Math.max(0, g.nodTimer - dt);
      if ((w.tick + g.id) % period === 0) this.decideGroup(g, dt * period);
    }
    this.hostileCount = 0;
    for (const m of this.members) {
      if (!m.active) continue;
      const p = w.peds.peds[m.pedId];
      if (!p || !p.active || p.owner !== 'gang') {
        m.active = false;
        continue;
      }
      if (p.state === 'down') {
        // Down for good: the body stays (and is not revived: crews look after their own).
        m.active = false;
        w.peds.tags.anim[p.id] = Anim.none;
        continue;
      }
      this.stepMember(m, p, dt, period);
    }
  }

  /** The player hurt the group (or a hostile crew spotted them): fight. */
  private provoke(g: GangGroup): void {
    const w = this.world;
    if (!g.active) return;
    g.grudge = this.config.grudgeSec;
    if (g.target !== 'player') w.events.push({ type: 'gangAggro', crew: this.crews[g.crew]!.id, target: 'player', x: g.x, z: g.z });
    g.mode = 'fight';
    g.target = 'player';
    g.unseen = 0;
  }

  private decideGroup(g: GangGroup, dt: number): void {
    const w = this.world;
    const cfg = this.config;
    const crewId = this.crews[g.crew]!.id;
    const att = this.attitude(g.crew);
    const pc = w.playerCtl;
    const alive = !pc.dead && w.survival.alive;
    const pd = w.distToPlayer(g.x, g.z);
    const inTurf = districtAt(w.content.map, w.player.x, w.player.z) === this.crews[g.crew]!.district;
    if (g.mode === 'loiter') {
      const angry = (att === 'hostile' && inTurf) || g.grudge > 0;
      if (alive && angry && pd < cfg.aggroRadius && this.groupSees(g, w.player.x, w.player.z)) {
        this.provoke(g);
        return;
      }
      if (alive && att === 'hostile' && pd < 45) {
        for (let i = 0; i < this.heard.length; i += 2) {
          if (Math.hypot(this.heard[i]! - g.x, this.heard[i + 1]! - g.z) < 40) {
            this.provoke(g);
            return;
          }
        }
      }
      if (alive && att === 'friendly' && w.heat.level >= 1 && pd < cfg.helpRadius * 1.5 && this.nearestOfficer(g.x, g.z, cfg.helpRadius)) {
        g.mode = 'fight';
        g.target = 'police';
        w.events.push({ type: 'gangAggro', crew: crewId, target: 'police', x: g.x, z: g.z });
      }
      return;
    }
    if (g.mode === 'fight') {
      if (g.target === 'player') {
        if (this.groupSees(g, w.player.x, w.player.z)) g.unseen = 0;
        else g.unseen += dt;
        if (!alive || pd > 55 || g.unseen > 8 || (att === 'friendly' && g.grudge <= 0)) this.calmDown(g);
      } else if (g.target === 'police') {
        if (w.heat.level === 0 || !this.nearestOfficer(g.x, g.z, cfg.helpRadius * 1.4)) this.calmDown(g);
      } else if (g.target === 'rival') {
        this.endBrawlIfDone(g, dt);
      }
      return;
    }
    if (g.mode === 'raid') {
      const r = this.groups[g.rival];
      g.timer += dt;
      if (!r || !r.active || g.timer > cfg.fight.approachSec) {
        g.mode = 'retreat';
        return;
      }
      const c = this.centre(g);
      if (Math.hypot(c.x - r.x, c.z - r.z) < 22) {
        for (const s of [g, r]) {
          if (s.mode === 'fight' && s.target === 'player') continue;
          s.mode = 'standoff';
          s.timer = cfg.fight.standoffSec;
          s.rival = s === g ? r.id : g.id;
        }
        const mx = (c.x + r.x) / 2;
        const mz = (c.z + r.z) / 2;
        w.events.push({ type: 'gangFight', crews: [crewId, this.crews[r.crew]!.id], x: mx, z: mz });
        w.crowds.addIncident(mx, mz, 'fight');
      }
      return;
    }
    if (g.mode === 'standoff') {
      g.timer -= dt;
      if (g.timer <= 0) {
        g.mode = 'fight';
        g.target = 'rival';
        g.timer = 0;
        const r = this.groups[g.rival];
        w.events.push({ type: 'gangAggro', crew: crewId, target: 'rival', x: r?.x ?? g.x, z: r?.z ?? g.z });
      }
      return;
    }
    if (g.mode === 'retreat') {
      // Walk back where the squad came from; stream() lets it go once out of view.
      return;
    }
  }

  private endBrawlIfDone(g: GangGroup, dt: number): void {
    g.timer += dt;
    const r = this.groups[g.rival];
    const rivalLive = r && r.active ? this.liveCount(r) : 0;
    if (rivalLive > 0 && g.timer < this.config.fight.maxSec) return;
    if (g.spot >= 0) this.calmDown(g);
    else g.mode = 'retreat';
    g.rival = -1;
  }

  private calmDown(g: GangGroup): void {
    g.target = 'none';
    g.unseen = 0;
    g.mode = g.spot >= 0 ? 'loiter' : 'retreat';
    for (const m of this.members) if (m.active && m.group === g.id) m.targetId = -1;
  }

  private liveCount(g: GangGroup): number {
    let n = 0;
    for (const m of this.members) if (m.active && m.group === g.id) n++;
    return n;
  }

  private readonly tmpC = { x: 0, z: 0 };

  /** Where the group's members are now (their mean position). */
  private centre(g: GangGroup): { x: number; z: number } {
    const w = this.world;
    let x = 0;
    let z = 0;
    let n = 0;
    for (const m of this.members) {
      if (!m.active || m.group !== g.id) continue;
      const p = w.peds.peds[m.pedId]!;
      x += p.x;
      z += p.z;
      n++;
    }
    this.tmpC.x = n ? x / n : g.x;
    this.tmpC.z = n ? z / n : g.z;
    return this.tmpC;
  }

  private groupSees(g: GangGroup, x: number, z: number): boolean {
    const w = this.world;
    for (const m of this.members) {
      if (!m.active || m.group !== g.id) continue;
      const p = w.peds.peds[m.pedId]!;
      if (Math.hypot(p.x - x, p.z - z) < this.config.shotRange + 6 && w.police.lineOfSight(p.x, p.z, x, z)) return true;
    }
    return false;
  }

  private nearestOfficer(x: number, z: number, range: number): number {
    let best = -1;
    let bd = range;
    for (const o of this.world.officers.officers) {
      if (!o.active || o.state === 'down') continue;
      const d = Math.hypot(o.x - x, o.z - z);
      if (d < bd) {
        bd = d;
        best = o.id;
      }
    }
    return best;
  }

  private nearestRival(g: GangGroup, x: number, z: number): number {
    const w = this.world;
    let best = -1;
    let bd = Infinity;
    for (const m of this.members) {
      if (!m.active || m.group !== g.rival) continue;
      const p = w.peds.peds[m.pedId]!;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) {
        bd = d;
        best = p.id;
      }
    }
    return best;
  }

  private stepMember(m: GangMember, p: Ped, dt: number, period: number): void {
    const w = this.world;
    const cfg = this.config;
    const tags = w.peds.tags;
    const g = this.groups[m.group]!;
    m.fireCooldown = Math.max(0, m.fireCooldown - dt);
    m.nodCooldown = Math.max(0, m.nodCooldown - dt);
    if (tags.animT[p.id]! > 0) tags.animT[p.id] = Math.max(0, tags.animT[p.id]! - dt);
    // Stunned (arc caster): rooted until it wears off.
    if (p.state === 'cower') {
      stopPed(p);
      if (p.timer <= 0) p.state = 'wander';
      return;
    }
    // Crews do not run from gunfire.
    if (p.state !== 'wander') p.state = 'wander';
    p.timer = 1e6;
    const decide = (w.tick + p.id) % period === 0;

    if (g.mode === 'fight') {
      let tx = w.player.x;
      let tz = w.player.z;
      let kind: 'player' | 'officer' | 'ped' = 'player';
      if (g.target === 'police') {
        if (decide || m.targetId < 0) m.targetId = this.nearestOfficer(p.x, p.z, cfg.helpRadius * 1.4);
        const o = m.targetId >= 0 ? w.officers.officers[m.targetId] : undefined;
        if (!o || !o.active || o.state === 'down') {
          m.targetId = -1;
          this.loiter(m, p, g);
          return;
        }
        tx = o.x;
        tz = o.z;
        kind = 'officer';
      } else if (g.target === 'rival') {
        if (decide || m.targetId < 0) m.targetId = this.nearestRival(g, p.x, p.z);
        const r = m.targetId >= 0 ? w.peds.peds[m.targetId] : undefined;
        if (!r || !r.active || r.state === 'down') {
          m.targetId = -1;
          stopPed(p);
          return;
        }
        tx = r.x;
        tz = r.z;
        kind = 'ped';
      } else if (g.target === 'player') {
        this.hostilePeds[this.hostileCount++] = p.id;
        if (w.playerCtl.dead) {
          this.loiter(m, p, g);
          return;
        }
      }
      this.fight(m, p, tx, tz, kind, decide);
      return;
    }
    if (g.mode === 'raid') {
      const r = this.groups[g.rival];
      if (r && r.active) {
        const k = m.id % 3;
        steerPed(p, r.x + (k - 1) * 1.5, r.z + (k - 1) * 1.5, 2.6, 0.5);
        tags.anim[p.id] = Anim.none;
        return;
      }
    }
    if (g.mode === 'standoff') {
      const r = this.groups[g.rival];
      stopPed(p);
      if (r && r.active) {
        const c = this.centre(r);
        p.facing = Math.atan2(c.x - p.x, c.z - p.z);
      }
      tags.anim[p.id] = m.armed ? Anim.aim : Anim.loiter;
      return;
    }
    if (g.mode === 'retreat') {
      steerPed(p, g.x, g.z, 2.2, 1);
      tags.anim[p.id] = Anim.none;
      return;
    }
    this.loiter(m, p, g);
  }

  /** Hang about in a ring at the spot, facing in; friendly crews nod to a player walking past. */
  private loiter(m: GangMember, p: Ped, g: GangGroup): void {
    const w = this.world;
    const cfg = this.config;
    const tags = w.peds.tags;
    if (w.rng.chance(0.0015)) m.slot += w.rng.range(-0.9, 0.9);
    const sx = g.x + Math.sin(m.slot) * SLOT_RADIUS;
    const sz = g.z + Math.cos(m.slot) * SLOT_RADIUS;
    const d = steerPed(p, sx, sz, cfg.walkSpeed, 0.3);
    if (d > 0.3) {
      tags.anim[p.id] = Anim.none;
      return;
    }
    const pc = w.playerCtl;
    const pdx = pc.x - p.x;
    const pdz = pc.z - p.z;
    const pd = Math.hypot(pdx, pdz);
    if (tags.animT[p.id]! > 0 && tags.anim[p.id] === Anim.nod) {
      p.facing = Math.atan2(pdx, pdz);
      return;
    }
    if (pc.mode === 'foot' && !pc.dead && pd < cfg.nodRadius && m.nodCooldown <= 0 && this.attitude(m.crew) === 'friendly') {
      m.nodCooldown = 12;
      tags.anim[p.id] = Anim.nod;
      tags.animT[p.id] = 1.3;
      p.facing = Math.atan2(pdx, pdz);
      if (g.nodTimer <= 0) {
        g.nodTimer = 15;
        w.events.push({ type: 'gangNod', crew: this.crews[m.crew]!.id, pedId: p.id, x: p.x, z: p.z });
      }
      return;
    }
    // Face the middle, with a little sway so the ring does not look frozen.
    p.facing = Math.atan2(g.x - p.x, g.z - p.z) + Math.sin(w.time * 0.6 + m.id * 1.3) * 0.35;
    tags.anim[p.id] = Anim.loiter;
  }

  private fight(m: GangMember, p: Ped, tx: number, tz: number, kind: 'player' | 'officer' | 'ped', decide: boolean): void {
    const w = this.world;
    const cfg = this.config;
    const tags = w.peds.tags;
    const dx = tx - p.x;
    const dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    p.facing = Math.atan2(dx, dz);
    if (!m.armed) {
      tags.anim[p.id] = Anim.none;
      if (d > 1.2) {
        steerPed(p, tx, tz, cfg.runSpeed, 1.1);
        p.facing = Math.atan2(dx, dz);
        return;
      }
      stopPed(p);
      if (m.fireCooldown <= 0) {
        m.fireCooldown = 0.9;
        this.hit(m, p, kind, cfg.punchDamage, tx, tz, true);
      }
      return;
    }
    tags.anim[p.id] = Anim.aim;
    // Line of sight is the expensive check: refresh it on decision ticks only.
    if (decide) tags.animT[p.id] = d < cfg.shotRange && w.police.lineOfSight(p.x, p.z, tx, tz) ? 0.5 : 0;
    const sees = tags.animT[p.id]! > 0;
    if (!sees || d > cfg.fightRange) {
      steerPed(p, tx, tz, cfg.runSpeed, sees ? cfg.fightRange * 0.8 : 0.5);
      p.facing = Math.atan2(dx, dz);
    } else stopPed(p);
    if (sees && m.fireCooldown <= 0 && d < cfg.shotRange) this.shoot(m, p, kind, tx, tz, d);
  }

  private shoot(m: GangMember, p: Ped, kind: 'player' | 'officer' | 'ped', tx: number, tz: number, dist: number): void {
    const w = this.world;
    const cfg = this.config;
    m.fireCooldown = cfg.shotIntervalSec * w.rng.range(0.8, 1.25);
    const chance = cfg.accuracy * (1 - 0.5 * clamp(dist / cfg.shotRange, 0, 1));
    const rolling = kind === 'player' && !w.player.vehicle && w.playerCtl.dodgeTime > 0;
    const hit = !rolling && w.rng.chance(chance);
    const dx = tx - p.x;
    const dz = tz - p.z;
    const len = Math.hypot(dx, dz) || 1;
    let hx = tx;
    let hz = tz;
    let what: 'none' | 'vehicle' | 'ped' | 'player' | 'officer' = 'none';
    if (hit) what = this.hit(m, p, kind, kind === 'officer' ? cfg.shotDamageOfficer : kind === 'ped' ? cfg.shotDamagePed : cfg.shotDamagePlayer, tx, tz, false);
    else {
      const side = w.rng.range(-1, 1) * 2.5;
      hx = tx + (-dz / len) * side + (dx / len) * 4;
      hz = tz + (dx / len) * side + (dz / len) * 4;
    }
    w.peds.alarm(p.x, p.z, w.content.peds.gunshotAlertRadius * 0.6);
    w.events.push({ type: 'shot', x: p.x + (dx / len) * 0.6, z: p.z + (dz / len) * 0.6, hx, hz, hit: what, byPlayer: false });
  }

  /** Land a punch or a round on the target. */
  private hit(m: GangMember, p: Ped, kind: 'player' | 'officer' | 'ped', amount: number, tx: number, tz: number, melee: boolean): 'none' | 'vehicle' | 'ped' | 'player' | 'officer' {
    const w = this.world;
    const dx = tx - p.x;
    const dz = tz - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const kx = (dx / len) * 3;
    const kz = (dz / len) * 3;
    if (kind === 'officer') {
      const o = w.officers.officers[m.targetId];
      if (!o) return 'none';
      w.officers.damage(o, amount, kx, kz, false);
      return 'officer';
    }
    if (kind === 'ped') {
      const r = w.peds.peds[m.targetId];
      if (!r) return 'none';
      w.peds.damage(r, amount, kx, kz, false);
      return 'ped';
    }
    if (w.player.vehicle) {
      if (melee) return 'none';
      w.damageVehicle(w.player.vehicle, this.config.shotDamageVehicle);
      return 'vehicle';
    }
    w.playerCtl.hurt(amount, -1);
    return 'player';
  }

  /** Not used by the sim itself: for tests and tools. */
  groupOf(m: GangMember): GangGroup {
    return this.groups[m.group]!;
  }

  /** Nearest spot of a crew to (x, z), for tests and tools. */
  nearestSpot(crew: number, x: number, z: number): { x: number; z: number } | null {
    const c = this.crews[crew];
    if (!c) return null;
    let best: { x: number; z: number } | null = null;
    let bd = Infinity;
    for (const s of c.spots) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }
}
