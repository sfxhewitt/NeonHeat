import type RAPIER_NS from '@dimforge/rapier3d-simd-compat';
import { Heat, type CrimeKind, type HeatConfig } from './heat';
import { driveTowards, handleStuck, resetAiState } from './ai';
import { Groups, interactionGroups } from './physics';
import { forwardSpeed } from './vehicle';
import { WitnessSystem } from './witness';
import { RoadblockSystem } from './roadblocks';
import type { ImpactOther } from './events';
import type { ResprayResult } from './combat-events';
import type { Vehicle, VehicleRole, World } from './world';

export interface Drone {
  active: boolean;
  x: number;
  z: number;
  y: number;
  prevX: number;
  prevZ: number;
  vx: number;
  vz: number;
  sees: boolean;
  /** Leaving: flies away and deactivates. */
  leaving: boolean;
}

type HeatReason = 'up' | 'escape' | 'swap' | 'respray' | 'clear';

/**
 * Police response to HEAT. Each level is distinct:
 * 1: one patrol investigates the last known position, follows, and stops you.
 * 2: pursuit with box-ins and PIT manoeuvres; officers get out to cuff you.
 * 3: the drone joins, more units, officers shoot at you on foot.
 * 4: heavy interceptors, roadblocks and spike strips.
 * 5: tactical vans and many cars.
 * Police try to stop you, not kill you: their rams are capped, and they pull
 * up short of a player on foot.
 */
export class PoliceSystem {
  readonly heat: Heat;
  readonly drone: Drone = { active: false, x: 0, z: 0, y: 0, prevX: 0, prevZ: 0, vx: 0, vz: 0, sees: false, leaving: false };
  readonly witnesses: WitnessSystem;
  readonly roadblocks: RoadblockSystem;
  /** Police unit cap (quality tiers lower it). */
  cap = 8;
  /** 0..1 progress towards BOOKED (for the HUD). */
  arrestProgress = 0;
  /** Seconds since any unit last saw the player. */
  sinceSeen = 0;
  private arrestTimer = 0;
  private spawnCooldown = 0;
  private spawnCount = 0;
  private nextSlot = 0;
  private lastRamDamage = -1e9;
  private lastPoliceContact = -1e9;
  private lastLevel = 0;
  private levelReason: HeatReason | null = null;
  /** Vehicle the player was last seen in (-1 on foot). */
  private seenVehicleId = -1;
  private swapUsed = false;
  private readonly ray: RAPIER_NS.Ray;
  private readonly losGroups = interactionGroups(0xffff, Groups.static);

  constructor(
    private readonly world: World,
    public config: HeatConfig,
  ) {
    this.heat = new Heat(config);
    this.ray = new world.R.Ray({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
    this.witnesses = new WitnessSystem(world);
    this.roadblocks = new RoadblockSystem(world);
  }

  /** True when nothing static blocks the straight line between two ground points. */
  lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return true;
    const r = this.ray;
    r.origin.x = ax;
    r.origin.y = 1.2;
    r.origin.z = az;
    r.dir.x = dx / len;
    r.dir.y = 0;
    r.dir.z = dz / len;
    const hit = this.world.physics.castRay(r, len, true, undefined, this.losGroups);
    return hit === null;
  }

  /** Outside the box around the player the camera roughly shows (north is -Z, up the screen). */
  offScreen(x: number, z: number): boolean {
    const s = this.config.screen;
    const dx = x - this.world.player.x;
    const dz = z - this.world.player.z;
    return Math.abs(dx) > s.halfWidth || dz < -s.north || dz > s.south;
  }

  countRole(role: VehicleRole): number {
    let n = 0;
    for (const v of this.world.vehicles) if (v.active && v.role === role && !v.destroyed) n++;
    return n;
  }

  /** Police cars working the case (not parked in a roadblock, not leaving). */
  private pursuitUnits(): number {
    let n = 0;
    for (const v of this.world.vehicles) {
      if (v.active && v.role === 'police' && !v.destroyed && v.ai.mode !== 'roadblock' && v.ai.mode !== 'leave') n++;
    }
    return n;
  }

  /** Does any police unit (car, officer, drone) see the point (x, z)? */
  policeSees(x: number, z: number): boolean {
    const w = this.world;
    const cfg = this.config;
    const d = this.drone;
    if (d.active && !d.leaving && Math.hypot(d.x - x, d.z - z) < cfg.droneSightRange) return true;
    for (const v of w.vehicles) {
      if (!v.active || v.role !== 'police' || v.destroyed || v.ai.mode === 'leave') continue;
      if (Math.hypot(v.x - x, v.z - z) > cfg.sightRange) continue;
      if (this.lineOfSight(v.x, v.z, x, z)) return true;
    }
    return w.officers.canSee(x, z);
  }

  /** The player committed a crime at (x, z). HEAT depends on who saw it. */
  crime(kind: CrimeKind, x: number, z: number): void {
    if (!this.world.survival.alive) return;
    this.witnesses.crime(kind, x, z);
  }

  /**
   * A respray: clears HEAT up to `respray.maxLevel` if no unit has seen the
   * player for a moment. The economy charges for it; this only says whether it worked.
   */
  respray(): ResprayResult {
    const w = this.world;
    const pv = w.player.vehicle;
    if (pv) this.roadblocks.repair(pv);
    if (this.heat.level === 0) return 'clean';
    if (this.heat.level > this.config.respray.maxLevel) return 'tooHot';
    if (this.sinceSeen < this.config.respray.unseenSec) return 'seen';
    this.clearHeat('respray');
    w.score.bank();
    return 'cleared';
  }

  /** Clear HEAT and send everyone home. */
  clearHeat(reason: HeatReason = 'clear'): void {
    this.heat.clear();
    this.witnesses.clear();
    this.levelReason = reason;
    this.seenVehicleId = -1;
    this.arrestTimer = 0;
    this.arrestProgress = 0;
  }

  /** The player got into a car. A different car while unseen drops a level (once per sighting). */
  onPlayerEnteredVehicle(v: Vehicle): void {
    if (this.heat.level === 0 || this.swapUsed) return;
    if (this.sinceSeen < this.config.carSwapUnseenSec || v.id === this.seenVehicleId) return;
    this.heat.dropLevel();
    this.levelReason = 'swap';
    this.swapUsed = true;
    this.seenVehicleId = v.id;
  }

  /**
   * Damage the player's car takes from a contact, after police scaling: rams
   * are a shove, capped per hit and rate-limited, so a car survives a long
   * chase. Being shoved into a wall or a parked car straight after a police
   * contact, or with a patrol car right on your bumper, counts as part of the same ram.
   */
  scaleImpactDamage(v: Vehicle, other: { kind: ImpactOther; id: number }, raw: number): number {
    const w = this.world;
    if (v !== w.player.vehicle) return raw;
    const rd = this.config.ramDamage;
    // Pursuing crews ram as hard as police do, so the same cap applies.
    const role = other.kind === 'vehicle' ? w.vehicles[other.id]!.role : null;
    const police = role === 'police' || role === 'squad';
    if (police) this.lastPoliceContact = w.time;
    else if (w.time - this.lastPoliceContact > rd.knockOnSec && !this.policeNear(v, rd.knockOnDist)) return raw;
    if (w.time - this.lastRamDamage < rd.cooldownSec) return 0;
    this.lastRamDamage = w.time;
    return Math.min(rd.maxPerHit, raw * rd.mul);
  }

  private policeNear(v: Vehicle, r: number): boolean {
    for (const o of this.world.vehicles) {
      if (o.active && o.role === 'police' && !o.destroyed && o.ai.mode !== 'leave' && Math.hypot(o.x - v.x, o.z - v.z) < r) return true;
    }
    return false;
  }

  /** Pre-physics: spawn/despawn and choose controls. */
  step(dt: number): void {
    const w = this.world;
    const cfg = this.config;
    const heat = this.heat;
    const lvl = heat.levelConfig;
    const desired = w.survival.alive ? Math.min(this.cap, lvl.units) : 0;

    // Spawn reinforcements, off screen.
    this.spawnCooldown -= dt;
    let active = this.pursuitUnits();
    if (active < desired && this.spawnCooldown <= 0) {
      const variant = lvl.variants[this.spawnCount % lvl.variants.length]!;
      if (this.spawnUnit('police', variant)) {
        active++;
        this.spawnCount++;
      }
      this.spawnCooldown = cfg.spawnIntervalSec;
    }
    // Stand down extras (the ones that cannot see the player first); they leave and despawn once out of the way.
    let extra = active - desired;
    for (let pass = 0; pass < 2 && extra > 0; pass++) {
      for (const v of w.vehicles) {
        if (extra <= 0) break;
        if (!v.active || v.role !== 'police' || v.destroyed) continue;
        if (v.ai.mode === 'leave' || v.ai.mode === 'roadblock' || v.ai.mode === 'stunned') continue;
        if (pass === 0 && v.ai.sees) continue;
        v.ai.mode = 'leave';
        extra--;
      }
    }
    for (const v of w.vehicles) {
      if (!v.active || v.role !== 'police') continue;
      if (v.ai.mode === 'leave' && w.distToPlayer(v.x, v.z) > cfg.despawnDist && w.officers.countFor(v.id) === 0) w.despawnVehicle(v);
      else if (v.destroyed && w.time - v.destroyedTime > 6 && w.distToPlayer(v.x, v.z) > cfg.despawnDist) w.despawnVehicle(v);
    }

    const period = Math.max(1, Math.round(60 / cfg.aiHz));
    for (const v of w.vehicles) {
      if (!v.active || v.destroyed || (v.role !== 'police' && v.role !== 'squad')) continue;
      const a = v.ai;
      a.cooldown = Math.max(0, a.cooldown - dt);
      if (a.mode === 'stunned') {
        a.timer -= dt;
        v.controls.throttle = 0;
        // Brake to a stop, then hold the handbrake (the foot brake at a standstill means reverse).
        const moving = forwardSpeed(v) > 0.5;
        v.controls.brake = moving ? 0.5 : 0;
        v.controls.handbrake = !moving;
        v.controls.steer = 0;
        if (a.timer <= 0) a.mode = 'drive';
        continue;
      }
      if ((w.tick + v.id) % period === 0) this.decide(v);
      if (a.mode === 'hold' || a.mode === 'roadblock') {
        // Parked: hold the handbrake (the foot brake would reverse).
        v.controls.throttle = 0;
        v.controls.brake = 0;
        v.controls.steer = 0;
        v.controls.handbrake = true;
        continue;
      }
      if (handleStuck(v, dt, cfg.stuckSec, cfg.reverseSec)) continue;
      driveTowards(v, a.targetX, a.targetZ, a.targetSpeed, v.controls, a.aggressive);
    }
    this.stepDrone(dt);
    this.roadblocks.step(dt);
  }

  /** Post-physics: who can see the player, HEAT decay, arrests. (Resprays at `respray*` markers: economy.ts.) */
  postStep(dt: number): void {
    const w = this.world;
    const p = w.player;
    let seen = false;
    for (const v of w.vehicles) if (v.active && v.role === 'police' && !v.destroyed && v.ai.sees) seen = true;
    if (this.drone.active && this.drone.sees) seen = true;
    if (w.officers.anySees()) seen = true;
    if (!w.survival.alive) seen = false;
    if (seen) {
      this.sinceSeen = 0;
      this.swapUsed = false;
      this.seenVehicleId = p.vehicle?.id ?? -1;
    } else this.sinceSeen += dt;
    this.witnesses.step(dt);
    this.heat.update(dt, seen, p.x, p.z);
    this.updateArrest(dt);
    if (this.heat.level !== this.lastLevel) {
      const reason = this.levelReason ?? (this.heat.level > this.lastLevel ? 'up' : 'escape');
      w.events.push({ type: 'heat', level: this.heat.level, previous: this.lastLevel, reason });
      this.lastLevel = this.heat.level;
      if (this.heat.level === 0) this.roadblocks.clear();
    }
    this.levelReason = null;
  }

  private updateArrest(dt: number): void {
    const w = this.world;
    const cfg = this.config;
    const oc = cfg.officers;
    const pc = w.playerCtl;
    let pressure = false;
    let required = oc.arrestSec;
    if (this.heat.level > 0 && w.survival.alive && !pc.dead) {
      const pv = w.player.vehicle;
      if (!pv) {
        const slow = Math.hypot(pc.vx, pc.vz) <= oc.arrestMaxPlayerSpeed + 0.01 && pc.dodgeTime <= 0;
        pressure = slow && w.officers.nearestDist(pc.x, pc.z) < oc.arrestRange;
      } else if (Math.abs(forwardSpeed(pv)) < cfg.pursuit.boxInSpeed) {
        let cars = 0;
        for (const v of w.vehicles) {
          if (!v.active || v.role !== 'police' || v.destroyed || v.ai.mode === 'leave') continue;
          if (Math.hypot(v.x - pv.x, v.z - pv.z) < cfg.pursuit.boxInRadius) cars++;
        }
        const officer = w.officers.nearestDist(pv.x, pv.z) < oc.carArrestRange + pv.params.width / 2;
        if (officer) {
          pressure = true;
          required = oc.arrestSec * 1.6;
        } else if (cars >= cfg.pursuit.boxInUnits) {
          pressure = true;
          required = cfg.pursuit.boxInBustSec;
        }
      }
    }
    if (pressure) this.arrestTimer += dt;
    else this.arrestTimer = Math.max(0, this.arrestTimer - dt * 1.5);
    this.arrestProgress = Math.min(1, this.arrestTimer / required);
    if (this.arrestTimer >= required) {
      this.arrestTimer = 0;
      this.arrestProgress = 0;
      w.survival.book();
    }
  }

  spawnUnit(role: 'police' | 'squad', variant: string): Vehicle | null {
    const w = this.world;
    const cfg = this.config;
    const clear = (x: number, z: number): boolean => !w.vehicles.some((v) => v.active && Math.hypot(v.x - x, v.z - z) < 10);
    let candidates = w.roads.nodes.filter((n) => {
      const d = w.distToPlayer(n.x, n.z);
      return d >= cfg.spawnMinDist && d <= cfg.spawnMaxDist && this.offScreen(n.x, n.z) && clear(n.x, n.z);
    });
    // A small map or a player in a corner: settle for anything off screen.
    if (candidates.length === 0) candidates = w.roads.nodes.filter((n) => this.offScreen(n.x, n.z) && w.distToPlayer(n.x, n.z) >= 45 && clear(n.x, n.z));
    if (candidates.length === 0) return null;
    const node = w.rng.pick(candidates);
    const yaw = Math.atan2(w.player.x - node.x, w.player.z - node.z);
    const v = w.spawnVehicle(variant, node.x, node.z, yaw, role);
    if (!v) return null;
    resetAiState(v.ai);
    v.ai.mode = 'drive';
    v.ai.targetX = w.player.x;
    v.ai.targetZ = w.player.z;
    v.ai.slot = this.nextSlot++;
    return v;
  }

  private decide(v: Vehicle): void {
    const w = this.world;
    const cfg = this.config;
    const a = v.ai;
    const top = v.params.topSpeed;
    const p = w.player;
    if (a.mode === 'leave') {
      // Head for the farthest road node from the player.
      let best = w.roads.nodes[0]!;
      let bd = -1;
      for (const n of w.roads.nodes) {
        const d = w.distToPlayer(n.x, n.z);
        if (d > bd) {
          bd = d;
          best = n;
        }
      }
      this.route(v, best.x, best.z, top * 0.6);
      a.sees = false;
      a.aggressive = false;
      return;
    }
    const dist = Math.hypot(p.x - v.x, p.z - v.z);
    const alive = w.survival.alive;
    a.sees = alive && dist < cfg.sightRange && this.lineOfSight(v.x, v.z, p.x, p.z);
    if (v.role === 'squad') {
      this.decideSquad(v, dist);
      return;
    }
    if (!alive) {
      a.targetSpeed = 0;
      a.targetX = v.x;
      a.targetZ = v.z;
      return;
    }
    if (a.mode === 'hold') {
      if (w.officers.countFor(v.id) === 0) {
        a.mode = 'drive';
        a.cooldown = 5;
      }
      return;
    }
    if (this.maybeDeploy(v, dist) || a.mode === 'roadblock') return;
    const lvl = this.heat.levelConfig;
    const pv = p.vehicle;
    if (a.sees) {
      a.searchNode = -1;
      if (!pv) {
        // On foot: pull up short and let the officers do it. Never run them down.
        const stop = cfg.pursuit.footStopDist;
        a.targetX = p.x;
        a.targetZ = p.z;
        a.targetSpeed = Math.max(0, Math.min(top, (dist - stop) * 1.1));
        a.aggressive = false;
        a.waypoint = -1;
        return;
      }
      const ps = Math.hypot(p.vx, p.vz);
      const hx = ps > 1 ? p.vx / ps : Math.sin(pv.yaw);
      const hz = ps > 1 ? p.vz / ps : Math.cos(pv.yaw);
      if (lvl.tactic !== 'pursue') {
        // Investigate: tail the car and wait for it to stop.
        const fd = cfg.pursuit.followDist;
        a.targetX = p.x - hx * fd;
        a.targetZ = p.z - hz * fd;
        a.targetSpeed = Math.min(top, ps + 3 + Math.max(0, dist - 20) * 0.4);
        a.aggressive = false;
        a.waypoint = -1;
        return;
      }
      this.pursue(v, dist, ps, hx, hz);
      return;
    }
    a.aggressive = false;
    const tx = this.heat.lastKnownX;
    const tz = this.heat.lastKnownZ;
    if (Math.hypot(tx - v.x, tz - v.z) < 18) {
      // Reached the last known position: search nearby roads.
      if (a.searchNode < 0 || Math.hypot(w.roads.nodes[a.searchNode]!.x - v.x, w.roads.nodes[a.searchNode]!.z - v.z) < 12) {
        const here = w.roads.nearest(v.x, v.z);
        a.searchNode = here.links.length > 0 ? w.rng.pick(here.links) : here.id;
      }
      const n = w.roads.nodes[a.searchNode]!;
      a.targetX = n.x;
      a.targetZ = n.z;
      a.targetSpeed = top * 0.55;
      a.waypoint = -1;
      return;
    }
    this.route(v, tx, tz, top * (this.heat.level >= 2 ? 0.9 : 0.75));
  }

  /** Box in and PIT: each unit plays a role by its slot. Close in gently: contact is a shove. */
  private pursue(v: Vehicle, dist: number, ps: number, hx: number, hz: number): void {
    const cfg = this.config.pursuit;
    const a = v.ai;
    const p = this.world.player;
    const top = v.params.topSpeed;
    // Player's left (+X local is a car's left).
    const lx = hz;
    const lz = -hx;
    const relX = v.x - p.x;
    const relZ = v.z - p.z;
    const along = relX * hx + relZ * hz;
    const lat = relX * lx + relZ * lz;
    const slot = a.slot % 3;
    let tx: number;
    let tz: number;
    let speed = top;
    if (slot === 1) {
      // Flank: run alongside on one side, squeezing the player against the kerb.
      const side = (a.slot >> 1) % 2 === 0 ? 1 : -1;
      tx = p.x + hx * ps * 0.5 + lx * cfg.flankOffset * side;
      tz = p.z + hz * ps * 0.5 + lz * cfg.flankOffset * side;
    } else if (slot === 2 && ps > 6) {
      // Cut-off: get ahead and block the road.
      tx = p.x + hx * ps * cfg.cutoffLeadSec;
      tz = p.z + hz * ps * cfg.cutoffLeadSec;
      // Once in front, ease off so the player has to brake or go round: never race away.
      if (along > 4) speed = Math.max(6, ps - cfg.closingSpeed);
    } else if (dist < cfg.pitDist && along < 0 && along > -7 && Math.abs(lat) < 4.5) {
      // PIT: steer into the player's rear quarter from the side we are on.
      const s = lat >= 0 ? 1 : -1;
      tx = p.x - hx * 1.4 - lx * s * 0.6;
      tz = p.z - hz * 1.4 - lz * s * 0.6;
      speed = ps + cfg.closingSpeed;
    } else {
      const lead = dist < 20 ? 0.25 : Math.min(1.2, dist / 40) * this.config.lookAheadSec * 2;
      tx = p.x + p.vx * lead;
      tz = p.z + p.vz * lead;
    }
    if (dist < cfg.matchSpeedDist) speed = Math.min(speed, ps + cfg.closingSpeed);
    a.targetX = tx;
    a.targetZ = tz;
    a.targetSpeed = Math.max(4, Math.min(top, speed));
    a.aggressive = true;
    a.waypoint = -1;
  }

  /** Stopped near the player: officers get out. */
  private maybeDeploy(v: Vehicle, dist: number): boolean {
    const w = this.world;
    const a = v.ai;
    const oc = this.config.officers;
    const lvl = this.heat.levelConfig;
    if (!a.sees || a.cooldown > 0 || lvl.officersPerCar <= 0 || this.heat.level === 0) return false;
    if (Math.abs(forwardSpeed(v)) > oc.deploySpeed) return false;
    const pv = w.player.vehicle;
    const onFoot = !pv && dist < oc.deployDist;
    const stoppedCar = !!pv && Math.abs(forwardSpeed(pv)) < oc.carArrestMaxSpeed * 1.5 && dist < 16;
    if (!onFoot && !stoppedCar) return false;
    if (w.officers.countFor(v.id) > 0) return false;
    const n = w.officers.deploy(v, lvl.officersPerCar, lvl.tactical && v.variantId === lvl.variants[0]);
    a.cooldown = 4;
    if (n === 0 || a.mode === 'roadblock') return false;
    a.mode = 'hold';
    return true;
  }

  /** Mission squads: tipped off by their employer, they always know where you are and ram hard. */
  private decideSquad(v: Vehicle, dist: number): void {
    const a = v.ai;
    const p = this.world.player;
    const top = v.params.topSpeed;
    if (a.sees || dist < 30) {
      const lead = dist < this.config.ramDistance ? 0.2 : Math.min(1, dist / 40) * this.config.lookAheadSec * 2;
      a.targetX = p.x + p.vx * lead;
      a.targetZ = p.z + p.vz * lead;
      a.targetSpeed = top;
      a.aggressive = true;
      a.searchNode = -1;
      return;
    }
    a.aggressive = false;
    this.route(v, p.x, p.z, top * 0.9);
  }

  /** Route along the road graph towards (tx, tz), driving straight there when the way is clear. */
  private route(v: Vehicle, tx: number, tz: number, speed: number): void {
    const w = this.world;
    const a = v.ai;
    a.targetSpeed = speed;
    const d = Math.hypot(tx - v.x, tz - v.z);
    if (d < 90 && this.lineOfSight(v.x, v.z, tx, tz)) {
      a.targetX = tx;
      a.targetZ = tz;
      a.waypoint = -1;
      return;
    }
    const nodes = w.roads.nodes;
    if (a.waypoint < 0 || Math.hypot(nodes[a.waypoint]!.x - v.x, nodes[a.waypoint]!.z - v.z) > 110) {
      a.waypoint = w.roads.nearest(v.x, v.z).id;
    }
    const wp = nodes[a.waypoint]!;
    if (Math.hypot(wp.x - v.x, wp.z - v.z) < 12) {
      const dest = w.roads.nearest(tx, tz);
      a.waypoint = w.roads.nextHop(wp.id, dest.id);
    }
    const next = nodes[a.waypoint]!;
    a.targetX = next.x;
    a.targetZ = next.z;
  }

  private stepDrone(dt: number): void {
    const d = this.drone;
    const cfg = this.config;
    const w = this.world;
    const want = this.heat.levelConfig.drone && w.survival.alive;
    d.prevX = d.x;
    d.prevZ = d.z;
    if (want && (!d.active || d.leaving)) {
      if (!d.active) {
        // Arrive from a little way off, out of view.
        d.x = w.player.x + (w.player.x > 0 ? -140 : 140);
        d.z = w.player.z + (w.player.z > 0 ? -140 : 140);
        d.prevX = d.x;
        d.prevZ = d.z;
        d.vx = d.vz = 0;
      }
      d.active = true;
      d.leaving = false;
      d.y = cfg.droneAltitude;
    } else if (!want && d.active) {
      d.leaving = true;
    }
    if (!d.active) {
      d.sees = false;
      return;
    }
    // Fly over buildings towards the player (or away when leaving).
    let tx = w.player.x;
    let tz = w.player.z;
    if (d.leaving) {
      tx = d.x + (d.x - w.player.x) * 4;
      tz = d.z + (d.z - w.player.z) * 4;
    }
    const dx = tx - d.x;
    const dz = tz - d.z;
    const len = Math.hypot(dx, dz);
    const desiredSpeed = d.leaving ? cfg.droneSpeed : Math.min(cfg.droneSpeed, len * 1.2);
    const dvx = len > 0.01 ? (dx / len) * desiredSpeed : 0;
    const dvz = len > 0.01 ? (dz / len) * desiredSpeed : 0;
    const k = 1 - Math.exp(-2.5 * dt);
    d.vx += (dvx - d.vx) * k;
    d.vz += (dvz - d.vz) * k;
    d.x += d.vx * dt;
    d.z += d.vz * dt;
    d.sees = !d.leaving && Math.hypot(w.player.x - d.x, w.player.z - d.z) < cfg.droneSightRange;
    if (d.leaving && Math.hypot(w.player.x - d.x, w.player.z - d.z) > 200) {
      d.active = false;
      d.leaving = false;
    }
  }
}
