import { z } from 'zod';
import { driveTowards, handleStuck, resetAiState } from './ai';
import { Groups, clamp, interactionGroups, wrapAngle } from './physics';
import { forwardSpeed } from './vehicle';
import type { Ped } from './peds';
import type { Vehicle, World } from './world';

/**
 * Mission actors: scripted people (gang members, guards, VIPs, snitches) and
 * scripted drivers (couriers to tail, cars that flee, rivals that race, convoys
 * that ram). Missions place them through this API; the sim runs them.
 *
 * People are ordinary pooled peds from PedSystem with behaviour layered on top,
 * so everything that already hits peds (the pistol, cars) hits actors too. A
 * downed actor with hit points left gets back up.
 *
 * Drivers are ordinary pooled vehicles with role `mission`, so traffic and
 * police leave them alone.
 */

export const ActorConfigSchema = z.object({
  /** Most actors at once (pool size). */
  maxActors: z.number().int().positive().default(24),
  maxDrivers: z.number().int().positive().default(12),
  walkSpeed: z.number().positive().default(1.6),
  runSpeed: z.number().positive().default(5),
  /** Hostiles notice the player within this range when they can see them. */
  aggroRadius: z.number().positive().default(26),
  /** A shot fired this close to a hostile makes it (and its group) aggressive. */
  hearShotRadius: z.number().positive().default(40),
  /** Guards wander back home once this far away and not fighting. */
  guardLeash: z.number().positive().default(8),
  shotRange: z.number().positive().default(28),
  shotIntervalSec: z.number().positive().default(1.2),
  /** Chance a shot hits at point-blank range; falls off to half at max range. */
  accuracy: z.number().min(0).max(1).default(0.45),
  shotDamagePlayer: z.number().nonnegative().default(6),
  shotDamageVehicle: z.number().nonnegative().default(5),
  /** Armed hostiles try to stay this far from their target. */
  fightRange: z.number().positive().default(14),
  followDistance: z.number().positive().default(3),
  /** A player round passing this close to an actor hits it. */
  hitRadius: z.number().positive().default(0.8),
  driver: z
    .object({
      cruiseSpeed: z.number().positive().default(14),
      fleeSpeed: z.number().positive().default(24),
      ramSpeed: z.number().positive().default(26),
      raceSpeed: z.number().positive().default(27),
      cornerSpeed: z.number().positive().default(8),
      cornerSlowDist: z.number().nonnegative().default(24),
      arriveRadius: z.number().positive().default(9),
      laneOffset: z.number().nonnegative().default(3.5),
      detectRange: z.number().positive().default(24),
      laneHalfWidth: z.number().positive().default(1.3),
      minGap: z.number().positive().default(6),
      timeHeadway: z.number().positive().default(1),
      stuckSec: z.number().positive().default(1.6),
      reverseSec: z.number().positive().default(1),
      aiHz: z.number().positive().default(15),
    })
    .prefault({}),
});
export type ActorConfig = z.infer<typeof ActorConfigSchema>;

export type ActorBehaviour = 'idle' | 'guard' | 'wander' | 'flee' | 'follow' | 'goto';

export interface ActorSpawn {
  x: number;
  z: number;
  facing?: number;
  /** Crew id, for colour and for "who shoots whom". */
  faction: string;
  /** Hostile actors fight the player once they notice them. */
  hostile: boolean;
  /** Hostiles that carry a gun shoot; unarmed ones only run at you. */
  armed?: boolean;
  behaviour: ActorBehaviour;
  /** Pistol hits (or knock-downs) it takes to put this actor down. */
  hp?: number;
  /** Actors in one group aggro together. */
  group?: string;
}

export interface Actor {
  /** Pool slot. */
  id: number;
  active: boolean;
  pedId: number;
  faction: string;
  group: string;
  hostile: boolean;
  armed: boolean;
  aggro: boolean;
  behaviour: ActorBehaviour;
  homeX: number;
  homeZ: number;
  goalX: number;
  goalZ: number;
  /** goto: run rather than walk. */
  running: boolean;
  arrived: boolean;
  hp: number;
  maxHp: number;
  dead: boolean;
  /** Riding in a vehicle: no ped in the world. */
  riding: boolean;
  fireCooldown: number;
  /** Another actor (pool slot) this hostile goes after, or -1. */
  targetActor: number;
  /** Who this hostile shoots at: -1 the player, otherwise a vehicle id. */
  targetVehicle: number;
  /** Last known position (also while riding or after death). */
  x: number;
  z: number;
  facing: number;
}

export type DriverMode = 'route' | 'flee' | 'ram' | 'hold';

export interface Driver {
  id: number;
  active: boolean;
  vehicleId: number;
  mode: DriverMode;
  /** Route points (lane-offset), and the index being driven towards. */
  xs: number[];
  zs: number[];
  idx: number;
  /** Route mode: reached the last point. */
  done: boolean;
  /** Speed cap for this driver (m/s). */
  speed: number;
  aggressive: boolean;
  /** Keep a gap behind traffic instead of shunting through it. */
  polite: boolean;
  /** Ram mode: vehicle id to ram, or -1 for the player. */
  targetVehicle: number;
  /** Flee mode: road node driven towards and the one before it. */
  node: number;
  prevNode: number;
  /** Route mode: loop back to the first point instead of stopping. */
  loop: boolean;
}

const PED_GROUPS = interactionGroups(Groups.ped, Groups.static | Groups.vehicle | Groups.ped | Groups.player);

export class ActorSystem {
  readonly actors: Actor[] = [];
  readonly drivers: Driver[] = [];
  config: ActorConfig;
  /** Shots heard this step (x, z pairs), filled from world events before stepping. */
  private readonly heard: number[] = [];

  constructor(
    private readonly world: World,
    config?: Partial<ActorConfig>,
  ) {
    this.config = ActorConfigSchema.parse(config ?? {});
    for (let i = 0; i < this.config.maxActors; i++) this.actors.push(makeActor(i));
    for (let i = 0; i < this.config.maxDrivers; i++) this.drivers.push(makeDriver(i));
  }

  /** Replace tuning (from content). Pools keep their size. */
  configure(config: ActorConfig): void {
    this.config = config;
  }

  // ---------------------------------------------------------------- people

  spawnActor(s: ActorSpawn): Actor | null {
    const a = this.actors.find((x) => !x.active);
    if (!a) return null;
    const ped = this.world.peds.spawnPedAt(s.x, s.z);
    if (!ped) return null;
    // Room in the population for this one, so ambient trimming never takes it.
    this.world.peds.cap++;
    Object.assign(a, makeActor(a.id));
    a.active = true;
    a.pedId = ped.id;
    a.faction = s.faction;
    a.group = s.group ?? s.faction;
    a.hostile = s.hostile;
    a.armed = s.armed ?? s.hostile;
    a.behaviour = s.behaviour;
    a.homeX = a.goalX = a.x = s.x;
    a.homeZ = a.goalZ = a.z = s.z;
    a.hp = a.maxHp = s.hp ?? 1;
    a.facing = s.facing ?? ped.facing;
    a.fireCooldown = this.world.rng.range(0.4, this.config.shotIntervalSec);
    ped.facing = ped.prevFacing = a.facing;
    this.hold(ped);
    return a;
  }

  /** Remove an actor (mission cleanup). A dead actor's body is left to the ped system. */
  despawnActor(a: Actor): void {
    if (!a.active) return;
    const ped = this.pedOf(a);
    if (ped && !a.dead) this.world.peds.despawn(ped);
    if (a.pedId >= 0) this.world.peds.cap = Math.max(0, this.world.peds.cap - 1);
    a.pedId = -1;
    a.active = false;
  }

  /** Clear everything (end of a mission). */
  clear(): void {
    for (const a of this.actors) if (a.active) this.despawnActor(a);
    for (const d of this.drivers) if (d.active) this.stopDriving(d.vehicleId);
  }

  pedOf(a: Actor): Ped | null {
    if (a.pedId < 0) return null;
    const p = this.world.peds.peds[a.pedId];
    return p && p.active ? p : null;
  }

  /** The actor for a ped id, if that ped is a live mission actor. */
  actorForPed(pedId: number): Actor | null {
    for (const a of this.actors) if (a.active && !a.dead && a.pedId === pedId) return a;
    return null;
  }

  /** Nearest live hostile actor within range of (x, z), for auto-aim. */
  nearestHostile(x: number, z: number, range: number): Actor | null {
    let best: Actor | null = null;
    let bd = range;
    for (const a of this.actors) {
      if (!a.active || a.dead || a.riding || !a.hostile) continue;
      const d = Math.hypot(a.x - x, a.z - z);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }

  /** Start (or stop) a fight. The target is the player unless another actor or a vehicle is given. */
  setAggro(a: Actor, on = true, target: { actor?: Actor | null; vehicleId?: number } = {}): void {
    if (!a.hostile && on) a.hostile = true;
    a.aggro = on;
    a.targetActor = target.actor ? target.actor.id : -1;
    a.targetVehicle = target.vehicleId ?? -1;
  }

  /** Make every actor of a group aggressive. */
  aggroGroup(group: string): void {
    for (const a of this.actors) if (a.active && !a.dead && a.hostile && a.group === group) a.aggro = true;
  }

  goTo(a: Actor, x: number, z: number, run: boolean): void {
    a.behaviour = 'goto';
    a.goalX = x;
    a.goalZ = z;
    a.running = run;
    a.arrived = false;
  }

  /** Put an actor in a vehicle: the ped leaves the world until it gets out. */
  board(a: Actor): void {
    if (!a.active || a.dead || a.riding) return;
    const ped = this.pedOf(a);
    if (ped) this.world.peds.despawn(ped);
    if (a.pedId >= 0) this.world.peds.cap = Math.max(0, this.world.peds.cap - 1);
    a.pedId = -1;
    a.riding = true;
  }

  /** Get out at (x, z). */
  alight(a: Actor, x: number, z: number): void {
    if (!a.active || a.dead || !a.riding) return;
    const ped = this.world.peds.spawnPedAt(x, z);
    a.riding = false;
    a.x = a.homeX = a.goalX = x;
    a.z = a.homeZ = a.goalZ = z;
    if (!ped) return;
    this.world.peds.cap++;
    a.pedId = ped.id;
    this.hold(ped);
  }

  /** Damage an actor directly (explosions, scripted kills). */
  hurtActor(a: Actor, amount: number): void {
    if (!a.active || a.dead) return;
    a.hp -= amount;
    if (a.hp > 0) return;
    a.hp = 0;
    const ped = this.pedOf(a);
    if (ped && ped.state !== 'down') this.world.peds.knockDown(ped, 0, 0, false);
    this.kill(a);
  }

  /** The first live actor the segment passes through takes a hit. */
  private hitAlong(x0: number, z0: number, x1: number, z1: number): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) return;
    const r2 = this.config.hitRadius * this.config.hitRadius;
    let best: Actor | null = null;
    let bt = Infinity;
    for (const a of this.actors) {
      if (!a.active || a.dead || a.riding) continue;
      const t = ((a.x - x0) * dx + (a.z - z0) * dz) / len2;
      if (t < 0 || t > 1) continue;
      const px = x0 + dx * t - a.x;
      const pz = z0 + dz * t - a.z;
      if (px * px + pz * pz > r2) continue;
      if (t < bt) {
        bt = t;
        best = a;
      }
    }
    if (!best) return;
    if (best.hostile) this.aggroGroup(best.group);
    if (best.hp > 1) best.hp -= 1;
    else this.hurtActor(best, 1);
  }

  private kill(a: Actor): void {
    a.dead = true;
    a.aggro = false;
    if (a.pedId >= 0) this.world.peds.cap = Math.max(0, this.world.peds.cap - 1);
    a.pedId = -1;
    // The group hears it.
    if (a.hostile) this.aggroGroup(a.group);
  }

  private hold(p: Ped): void {
    p.state = 'wander';
    p.timer = 1e6;
    p.targetX = p.x;
    p.targetZ = p.z;
  }

  // --------------------------------------------------------------- drivers

  driverFor(vehicleId: number): Driver | null {
    for (const d of this.drivers) if (d.active && d.vehicleId === vehicleId) return d;
    return null;
  }

  private claim(v: Vehicle): Driver | null {
    let d = this.driverFor(v.id);
    if (!d) d = this.drivers.find((x) => !x.active) ?? null;
    if (!d) return null;
    Object.assign(d, makeDriver(d.id));
    d.active = true;
    d.vehicleId = v.id;
    if (this.world.player.vehicle !== v) v.role = 'mission';
    resetAiState(v.ai);
    v.ai.mode = 'drive';
    return d;
  }

  /**
   * Drive a vehicle along the roads through each waypoint in turn, ending at the
   * last one exactly. Polite drivers keep their distance from traffic.
   */
  driveRoute(v: Vehicle, waypoints: readonly { x: number; z: number }[], speed?: number, opts: { polite?: boolean; aggressive?: boolean; loop?: boolean } = {}): Driver | null {
    const d = this.claim(v);
    if (!d) return null;
    d.mode = 'route';
    d.speed = speed ?? this.config.driver.cruiseSpeed;
    d.polite = opts.polite ?? true;
    d.aggressive = opts.aggressive ?? false;
    d.loop = opts.loop ?? false;
    this.buildRoute(d, v, waypoints);
    return d;
  }

  /** Run from the player through the road network. */
  flee(v: Vehicle, speed?: number): Driver | null {
    const d = this.claim(v);
    if (!d) return null;
    d.mode = 'flee';
    d.speed = speed ?? this.config.driver.fleeSpeed;
    d.aggressive = true;
    d.polite = false;
    d.node = this.world.roads.nearest(v.x, v.z).id;
    d.prevNode = -1;
    return d;
  }

  /** Hunt and ram a vehicle (or the player when targetVehicle is -1). */
  ram(v: Vehicle, targetVehicle: number, speed?: number): Driver | null {
    const d = this.claim(v);
    if (!d) return null;
    d.mode = 'ram';
    d.speed = speed ?? this.config.driver.ramSpeed;
    d.aggressive = true;
    d.polite = false;
    d.targetVehicle = targetVehicle;
    return d;
  }

  /** Stop and hold (brake). */
  holdVehicle(v: Vehicle): Driver | null {
    const d = this.claim(v);
    if (!d) return null;
    d.mode = 'hold';
    return d;
  }

  /** Hand a vehicle back: parked, no driver. */
  stopDriving(vehicleId: number): void {
    const d = this.driverFor(vehicleId);
    if (!d) return;
    d.active = false;
    const v = this.world.vehicles[vehicleId];
    if (v && v.active && v.role === 'mission') v.role = 'parked';
  }

  private readonly tmpPts: { x: number; z: number }[] = [];

  private buildRoute(d: Driver, v: Vehicle, waypoints: readonly { x: number; z: number }[]): void {
    const g = this.world.roads;
    const lane = this.config.driver.laneOffset;
    const pts = this.tmpPts;
    pts.length = 0;
    let from = g.nearest(v.x, v.z).id;
    const nodes: number[] = [from];
    for (const wp of waypoints) {
      const to = g.nearest(wp.x, wp.z).id;
      const path = g.path(from, to);
      for (let i = 1; i < path.length; i++) nodes.push(path[i]!);
      from = to;
    }
    // Skip a first node that is behind us.
    if (nodes.length > 1) {
      const a = g.nodes[nodes[0]!]!;
      const b = g.nodes[nodes[1]!]!;
      if (Math.hypot(b.x - v.x, b.z - v.z) < Math.hypot(b.x - a.x, b.z - a.z)) nodes.shift();
    }
    // Drop repeated nodes (waypoints sharing a nearest node).
    for (let i = nodes.length - 1; i > 0; i--) if (nodes[i] === nodes[i - 1]) nodes.splice(i, 1);
    for (let i = 0; i < nodes.length; i++) {
      const n = g.nodes[nodes[i]!]!;
      const prev = i > 0 ? g.nodes[nodes[i - 1]!]! : null;
      const next = i < nodes.length - 1 ? g.nodes[nodes[i + 1]!]! : null;
      let ox = 0;
      let oz = 0;
      if (prev) [ox, oz] = right(n.x - prev.x, n.z - prev.z);
      if (next) {
        const [rx, rz] = right(next.x - n.x, next.z - n.z);
        // At a corner the two lane offsets add up to the inside corner point; straight on, keep one.
        if (!prev || Math.abs(rx * ox + rz * oz) < 0.7) {
          ox += rx;
          oz += rz;
        }
      }
      pts.push({ x: n.x + ox * lane, z: n.z + oz * lane });
    }
    const last = waypoints[waypoints.length - 1];
    if (last) pts.push({ x: last.x, z: last.z });
    d.xs = pts.map((p) => p.x);
    d.zs = pts.map((p) => p.z);
    d.idx = 0;
    d.done = pts.length === 0;
  }

  // ------------------------------------------------------------------ step

  /** Pre-physics: actor movement and shooting, driver controls. Called by World.step after peds. */
  step(dt: number): void {
    const w = this.world;
    this.heard.length = 0;
    for (const e of w.events) {
      if (e.type !== 'shot') continue;
      this.heard.push(e.x, e.z);
      // The player's rounds: a ped-height hit test along the shot, so actors can be shot
      // whatever height the shot ray is cast at. Rounds that already hit a ped are left to it.
      if (e.hit !== 'ped' && !w.player.vehicle && Math.hypot(e.x - w.playerCtl.x, e.z - w.playerCtl.z) < 1.5) this.hitAlong(e.x, e.z, e.hx, e.hz);
    }
    for (const a of this.actors) if (a.active && !a.dead && !a.riding) this.stepActor(a, dt);
    for (const d of this.drivers) if (d.active) this.stepDriver(d, dt);
  }

  /** Post-physics: read positions back, notice knock-downs. Called by World.step after peds. */
  postStep(): void {
    for (const a of this.actors) {
      if (!a.active || a.dead || a.riding) continue;
      const p = a.pedId >= 0 ? this.world.peds.peds[a.pedId] : undefined;
      if (!p || !p.active) continue;
      a.x = p.x;
      a.z = p.z;
      if (p.state !== 'down') continue;
      a.hp -= 1;
      if (a.hp > 0) {
        // Tough: gets straight back up, angrier.
        this.hold(p);
        p.collider?.setCollisionGroups(PED_GROUPS);
        if (a.hostile) this.aggroGroup(a.group);
      } else {
        a.hp = 0;
        this.kill(a);
      }
    }
  }

  private stepActor(a: Actor, dt: number): void {
    const w = this.world;
    const cfg = this.config;
    let p = this.pedOf(a);
    if (!p) {
      // Lost our ped (population trimmed): stand back up where we were.
      const fresh = w.peds.spawnPedAt(a.x, a.z);
      if (!fresh) return;
      a.pedId = fresh.id;
      this.hold(fresh);
      p = fresh;
    }
    if (!p.body || p.state === 'down') return;
    a.fireCooldown = Math.max(0, a.fireCooldown - dt);
    const pl = w.player;
    const pdx = pl.x - a.x;
    const pdz = pl.z - a.z;
    const pdist = Math.hypot(pdx, pdz);
    const playerDown = w.playerCtl.dead;

    // Hostiles notice the player, or gunfire nearby.
    if (a.hostile && !a.aggro && !playerDown) {
      if (pdist < cfg.aggroRadius && w.police.lineOfSight(a.x, a.z, pl.x, pl.z)) this.aggroGroup(a.group);
      else
        for (let i = 0; i < this.heard.length; i += 2) {
          if (Math.hypot(this.heard[i]! - a.x, this.heard[i + 1]! - a.z) < cfg.hearShotRadius) {
            this.aggroGroup(a.group);
            break;
          }
        }
    }

    let vx = 0;
    let vz = 0;
    let face = a.facing;
    const move = (tx: number, tz: number, speed: number, stopAt: number): void => {
      const dx = tx - a.x;
      const dz = tz - a.z;
      const d = Math.hypot(dx, dz);
      if (d <= stopAt) return;
      vx = (dx / d) * speed;
      vz = (dz / d) * speed;
      face = Math.atan2(dx, dz);
    };

    if (a.hostile && a.aggro && !playerDown) {
      // Fight: close to shooting range of the target, then stand and shoot.
      let tx = pl.x;
      let tz = pl.z;
      const ta = this.liveTarget(a);
      // Someone else is the target, unless the player gets in their face.
      if (ta && pdist > 10) {
        tx = ta.x;
        tz = ta.z;
      } else if (a.targetVehicle >= 0) {
        const tv = w.vehicles[a.targetVehicle];
        if (tv && tv.active && !tv.destroyed) {
          tx = tv.x;
          tz = tv.z;
        }
      }
      const d = Math.hypot(tx - a.x, tz - a.z);
      const sees = d < cfg.shotRange && w.police.lineOfSight(a.x, a.z, tx, tz);
      if (!a.armed) move(tx, tz, cfg.runSpeed, 1.2);
      else if (!sees || d > cfg.fightRange) move(tx, tz, cfg.runSpeed, 0);
      face = Math.atan2(tx - a.x, tz - a.z);
      if (a.armed && sees && a.fireCooldown <= 0) this.shoot(a, tx, tz, d);
    } else if (a.behaviour === 'flee') {
      if (pdist < 60) move(a.x - pdx, a.z - pdz, cfg.runSpeed, 0);
    } else if (a.behaviour === 'follow') {
      move(pl.x, pl.z, pdist > 10 ? cfg.runSpeed : cfg.walkSpeed * 1.6, cfg.followDistance);
    } else if (a.behaviour === 'goto') {
      const d = Math.hypot(a.goalX - a.x, a.goalZ - a.z);
      if (d < 1) a.arrived = true;
      else move(a.goalX, a.goalZ, a.running ? cfg.runSpeed : cfg.walkSpeed, 0.5);
    } else if (a.behaviour === 'wander') {
      if (Math.hypot(p.targetX - a.x, p.targetZ - a.z) < 1 || Math.hypot(p.targetX - a.homeX, p.targetZ - a.homeZ) > cfg.guardLeash * 2) {
        p.targetX = a.homeX + w.rng.range(-cfg.guardLeash, cfg.guardLeash);
        p.targetZ = a.homeZ + w.rng.range(-cfg.guardLeash, cfg.guardLeash);
      }
      move(p.targetX, p.targetZ, cfg.walkSpeed, 0.5);
    } else if (Math.hypot(a.homeX - a.x, a.homeZ - a.z) > (a.behaviour === 'guard' ? cfg.guardLeash : 1.5)) {
      move(a.homeX, a.homeZ, cfg.walkSpeed, 0.5);
    } else if (a.behaviour === 'guard') {
      // Look about.
      face = a.facing + Math.sin(w.time * 0.5 + a.id) * 0.01;
    }

    a.facing = wrapAngle(face);
    p.state = 'wander';
    p.timer = 1e6;
    p.targetX = a.x + vx;
    p.targetZ = a.z + vz;
    p.vx = vx;
    p.vz = vz;
    p.facing = a.facing;
    p.body.setLinvel({ x: vx, y: 0, z: vz }, true);
  }

  /** The actor this one is after, if it is still up and about. */
  private liveTarget(a: Actor): Actor | null {
    if (a.targetActor < 0) return null;
    const t = this.actors[a.targetActor];
    return t && t.active && !t.dead && !t.riding ? t : null;
  }

  private shoot(a: Actor, tx: number, tz: number, dist: number): void {
    const w = this.world;
    const cfg = this.config;
    a.fireCooldown = cfg.shotIntervalSec * w.rng.range(0.8, 1.25);
    const pc = w.playerCtl;
    const chance = cfg.accuracy * (1 - 0.5 * clamp(dist / cfg.shotRange, 0, 1));
    const rolling = a.targetVehicle < 0 && !w.player.vehicle && pc.dodgeTime > 0;
    const hit = !rolling && w.rng.chance(chance);
    const dx = tx - a.x;
    const dz = tz - a.z;
    const len = Math.hypot(dx, dz) || 1;
    let hx = tx;
    let hz = tz;
    let kind: 'none' | 'vehicle' | 'ped' = 'none';
    const ta = this.liveTarget(a);
    const atActor = ta !== null && Math.hypot(ta.x - tx, ta.z - tz) < 0.5;
    if (hit) {
      if (atActor) {
        this.hurtActor(ta, 1);
        kind = 'ped';
      } else if (a.targetVehicle >= 0) {
        const tv = w.vehicles[a.targetVehicle];
        if (tv && tv.active) {
          w.damageVehicle(tv, cfg.shotDamageVehicle);
          kind = 'vehicle';
        }
      } else if (w.player.vehicle) {
        w.damageVehicle(w.player.vehicle, cfg.shotDamageVehicle);
        kind = 'vehicle';
      } else {
        pc.hurt(cfg.shotDamagePlayer, -1);
        kind = 'ped';
      }
    } else {
      // A miss whistles past.
      const side = w.rng.range(-1, 1) * 2.5;
      hx = tx + (-dz / len) * side + (dx / len) * 4;
      hz = tz + (dx / len) * side + (dz / len) * 4;
    }
    w.peds.alarm(a.x, a.z, w.content.peds.gunshotAlertRadius * 0.6);
    w.events.push({ type: 'shot', x: a.x + (dx / len) * 0.6, z: a.z + (dz / len) * 0.6, hx, hz, hit: kind });
  }

  private stepDriver(d: Driver, dt: number): void {
    const w = this.world;
    const cfg = this.config.driver;
    const v = w.vehicles[d.vehicleId];
    if (!v || !v.active || v.destroyed || w.player.vehicle === v) {
      d.active = false;
      if (v && v.active && v.role === 'mission') v.role = 'parked';
      return;
    }
    const a = v.ai;
    if (a.mode === 'stunned') {
      a.timer -= dt;
      v.controls.throttle = 0;
      v.controls.brake = 0.6;
      v.controls.steer = 0;
      if (a.timer <= 0) a.mode = 'drive';
      return;
    }
    const period = Math.max(1, Math.round(60 / cfg.aiHz));
    if ((w.tick + v.id) % period === 0) this.decideDriver(d, v);
    if (d.mode === 'hold' || (d.mode === 'route' && d.done)) {
      driveTowards(v, v.x, v.z, 0, v.controls);
      return;
    }
    if (handleStuck(v, dt, cfg.stuckSec, cfg.reverseSec)) return;
    driveTowards(v, a.targetX, a.targetZ, a.targetSpeed, v.controls, d.aggressive);
  }

  private decideDriver(d: Driver, v: Vehicle): void {
    const w = this.world;
    const cfg = this.config.driver;
    const a = v.ai;
    const g = w.roads;
    let speed = Math.min(d.speed, v.params.topSpeed);
    if (d.mode === 'route') {
      if (d.done) return;
      while (d.idx < d.xs.length && Math.hypot(d.xs[d.idx]! - v.x, d.zs[d.idx]! - v.z) < cfg.arriveRadius) d.idx++;
      if (d.idx >= d.xs.length) {
        if (d.loop && d.xs.length > 1) d.idx = 0;
        else {
          d.done = true;
          return;
        }
      }
      a.targetX = d.xs[d.idx]!;
      a.targetZ = d.zs[d.idx]!;
      // Slow for the corner at the point we are heading to.
      const next = d.idx + 1 < d.xs.length ? d.idx + 1 : -1;
      const dist = Math.hypot(a.targetX - v.x, a.targetZ - v.z);
      if (next >= 0 && dist < cfg.cornerSlowDist) {
        const inYaw = Math.atan2(a.targetX - v.x, a.targetZ - v.z);
        const outYaw = Math.atan2(d.xs[next]! - a.targetX, d.zs[next]! - a.targetZ);
        const turn = Math.abs(wrapAngle(outYaw - inYaw));
        if (turn > 0.5) speed = Math.min(speed, cfg.cornerSpeed + (speed - cfg.cornerSpeed) * (dist / cfg.cornerSlowDist));
      }
      if (next < 0) speed = Math.min(speed, 4 + dist * 0.6);
    } else if (d.mode === 'flee') {
      const pl = w.player;
      const n = g.nodes[d.node]!;
      if (Math.hypot(n.x - v.x, n.z - v.z) < cfg.arriveRadius + 3) {
        // Pick the onward road that takes us furthest from the player.
        let best = -1;
        let bs = -Infinity;
        for (const l of n.links) {
          if (l === d.prevNode && n.links.length > 1) continue;
          const m = g.nodes[l]!;
          const score = Math.hypot(m.x - pl.x, m.z - pl.z) + w.rng.range(0, 25);
          if (score > bs) {
            bs = score;
            best = l;
          }
        }
        if (best >= 0) {
          d.prevNode = d.node;
          d.node = best;
        }
      }
      const t = g.nodes[d.node]!;
      const from = d.prevNode >= 0 ? g.nodes[d.prevNode]! : null;
      let ox = 0;
      let oz = 0;
      if (from) [ox, oz] = right(t.x - from.x, t.z - from.z);
      a.targetX = t.x + ox * cfg.laneOffset;
      a.targetZ = t.z + oz * cfg.laneOffset;
    } else if (d.mode === 'ram') {
      let tx = w.player.x;
      let tz = w.player.z;
      let tvx = w.player.vx;
      let tvz = w.player.vz;
      if (d.targetVehicle >= 0) {
        const tv = w.vehicles[d.targetVehicle];
        if (!tv || !tv.active || tv.destroyed) {
          d.mode = 'hold';
          return;
        }
        tx = tv.x;
        tz = tv.z;
        tvx = tv.vx;
        tvz = tv.vz;
      }
      const dist = Math.hypot(tx - v.x, tz - v.z);
      if (dist < 90 && w.police.lineOfSight(v.x, v.z, tx, tz)) {
        const lead = Math.min(1, dist / 40) * 0.8;
        a.targetX = tx + tvx * lead;
        a.targetZ = tz + tvz * lead;
      } else {
        const here = g.nearest(v.x, v.z);
        const hop = Math.hypot(here.x - v.x, here.z - v.z) < 12 ? g.nodes[g.nextHop(here.id, g.nearest(tx, tz).id)]! : here;
        a.targetX = hop.x;
        a.targetZ = hop.z;
      }
    }
    if (d.polite) {
      const gap = w.gapAhead(v, cfg.detectRange, cfg.laneHalfWidth);
      if (gap < Infinity) speed = Math.min(speed, Math.max(0, (gap - cfg.minGap) / cfg.timeHeadway));
    }
    a.targetSpeed = speed;
    a.aggressive = d.aggressive;
  }

  /** Distance along the remaining route (route mode), for "how far to go" checks. */
  remaining(d: Driver): number {
    const v = this.world.vehicles[d.vehicleId];
    if (!v || d.idx >= d.xs.length) return 0;
    let s = Math.hypot(d.xs[d.idx]! - v.x, d.zs[d.idx]! - v.z);
    for (let i = d.idx + 1; i < d.xs.length; i++) s += Math.hypot(d.xs[i]! - d.xs[i - 1]!, d.zs[i]! - d.zs[i - 1]!);
    return s;
  }

  /** Speed of a driven vehicle along its heading. */
  speedOf(vehicleId: number): number {
    const v = this.world.vehicles[vehicleId];
    return v && v.active ? forwardSpeed(v) : 0;
  }
}

/** Driver's right-hand side for travel direction (dx, dz), normalised. */
function right(dx: number, dz: number): [number, number] {
  const len = Math.hypot(dx, dz) || 1;
  return [-dz / len, dx / len];
}

function makeActor(id: number): Actor {
  return {
    id,
    active: false,
    pedId: -1,
    faction: '',
    group: '',
    hostile: false,
    armed: false,
    aggro: false,
    behaviour: 'idle',
    homeX: 0,
    homeZ: 0,
    goalX: 0,
    goalZ: 0,
    running: false,
    arrived: false,
    hp: 1,
    maxHp: 1,
    dead: false,
    riding: false,
    fireCooldown: 0,
    targetActor: -1,
    targetVehicle: -1,
    x: 0,
    z: 0,
    facing: 0,
  };
}

function makeDriver(id: number): Driver {
  return {
    id,
    active: false,
    vehicleId: -1,
    mode: 'hold',
    xs: [],
    zs: [],
    idx: 0,
    done: false,
    speed: 0,
    aggressive: false,
    polite: true,
    targetVehicle: -1,
    node: -1,
    prevNode: -1,
    loop: false,
  };
}
