import type RAPIER_NS from '@dimforge/rapier3d-simd-compat';
import { Heat, type HeatConfig } from './heat';
import { driveTowards, handleStuck, resetAiState } from './ai';
import { Groups, interactionGroups } from './physics';
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

/**
 * Police response to HEAT: patrol cars that pursue and ram, a surveillance
 * drone at level 3, plus any mission squads that use the same pursuit AI.
 */
export class PoliceSystem {
  readonly heat: Heat;
  readonly drone: Drone = { active: false, x: 0, z: 0, y: 0, prevX: 0, prevZ: 0, vx: 0, vz: 0, sees: false, leaving: false };
  /** Police unit cap (quality tiers lower it). */
  cap = 8;
  private spawnCooldown = 0;
  private readonly ray: RAPIER_NS.Ray;
  private readonly losGroups = interactionGroups(0xffff, Groups.static);

  constructor(
    private readonly world: World,
    public config: HeatConfig,
  ) {
    this.heat = new Heat(config);
    this.ray = new world.R.Ray({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
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

  countRole(role: VehicleRole): number {
    let n = 0;
    for (const v of this.world.vehicles) if (v.active && v.role === role && !v.destroyed) n++;
    return n;
  }

  /** Pre-physics: spawn/despawn and choose controls. */
  step(dt: number): void {
    const w = this.world;
    const cfg = this.config;
    const heat = this.heat;
    const desired = Math.min(this.cap, cfg.units[heat.level] ?? 0);

    // Spawn reinforcements.
    this.spawnCooldown -= dt;
    let active = this.countRole('police');
    if (active < desired && this.spawnCooldown <= 0) {
      if (this.spawnUnit('police', 'interceptor')) active++;
      this.spawnCooldown = 1.5;
    }
    // Stand down extras: they leave and despawn once out of the way.
    let extra = active - desired;
    for (const v of w.vehicles) {
      if (!v.active || v.role !== 'police') continue;
      if (v.ai.mode === 'stunned') continue;
      if (extra > 0 && v.ai.mode !== 'leave') {
        v.ai.mode = 'leave';
        extra--;
      }
      if (v.ai.mode === 'leave' && w.distToPlayer(v.x, v.z) > cfg.despawnDist) w.despawnVehicle(v);
      else if (v.destroyed && w.time - v.destroyedTime > 6 && w.distToPlayer(v.x, v.z) > cfg.despawnDist) w.despawnVehicle(v);
    }

    const period = Math.max(1, Math.round(60 / cfg.aiHz));
    for (const v of w.vehicles) {
      if (!v.active || v.destroyed || (v.role !== 'police' && v.role !== 'squad')) continue;
      if (v.ai.mode === 'stunned') {
        v.ai.timer -= dt;
        v.controls.throttle = 0;
        v.controls.brake = 0.5;
        v.controls.steer = 0;
        if (v.ai.timer <= 0) v.ai.mode = 'drive';
        continue;
      }
      if ((w.tick + v.id) % period === 0) this.decide(v);
      if (handleStuck(v, dt, cfg.stuckSec, cfg.reverseSec)) continue;
      driveTowards(v, v.ai.targetX, v.ai.targetZ, v.ai.targetSpeed, v.controls, v.ai.aggressive);
    }
    this.stepDrone(dt);
  }

  /** Post-physics: who can see the player, then HEAT decay. */
  postStep(dt: number): void {
    const w = this.world;
    let seen = false;
    for (const v of w.vehicles) if (v.active && v.role === 'police' && !v.destroyed && v.ai.sees) seen = true;
    if (this.drone.active && this.drone.sees) seen = true;
    this.heat.update(dt, seen, w.player.x, w.player.z);
  }

  spawnUnit(role: 'police' | 'squad', variant: string): Vehicle | null {
    const w = this.world;
    const cfg = this.config;
    const nodes = w.roads.nodes;
    const candidates = nodes.filter((n) => {
      const d = w.distToPlayer(n.x, n.z);
      return d >= cfg.spawnMinDist && d <= cfg.spawnMaxDist && !w.vehicles.some((v) => v.active && Math.hypot(v.x - n.x, v.z - n.z) < 10);
    });
    if (candidates.length === 0) return null;
    const node = w.rng.pick(candidates);
    const yaw = Math.atan2(w.player.x - node.x, w.player.z - node.z);
    const v = w.spawnVehicle(variant, node.x, node.z, yaw, role);
    if (!v) return null;
    resetAiState(v.ai);
    v.ai.mode = 'drive';
    v.ai.targetX = w.player.x;
    v.ai.targetZ = w.player.z;
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
    a.sees = dist < cfg.sightRange && this.lineOfSight(v.x, v.z, p.x, p.z);
    // Squads are tipped off by their employer: they always know where you are.
    const knows = a.sees || v.role === 'squad';
    if (knows && (a.sees || dist < 30)) {
      const lead = dist < cfg.ramDistance ? 0.2 : Math.min(1, dist / 40) * cfg.lookAheadSec * 2;
      a.targetX = p.x + p.vx * lead;
      a.targetZ = p.z + p.vz * lead;
      a.targetSpeed = top;
      a.aggressive = true;
      a.searchNode = -1;
      return;
    }
    a.aggressive = false;
    const tx = v.role === 'squad' ? p.x : this.heat.lastKnownX;
    const tz = v.role === 'squad' ? p.z : this.heat.lastKnownZ;
    if (Math.hypot(tx - v.x, tz - v.z) < 18 && v.role === 'police') {
      // Reached the last known position: search nearby roads.
      if (a.searchNode < 0 || Math.hypot(w.roads.nodes[a.searchNode]!.x - v.x, w.roads.nodes[a.searchNode]!.z - v.z) < 12) {
        const here = w.roads.nearest(v.x, v.z);
        a.searchNode = w.rng.pick(here.links);
      }
      const n = w.roads.nodes[a.searchNode]!;
      a.targetX = n.x;
      a.targetZ = n.z;
      a.targetSpeed = top * 0.55;
      a.waypoint = -1;
      return;
    }
    this.route(v, tx, tz, top * 0.9);
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
    const want = this.heat.level >= cfg.droneLevel;
    d.prevX = d.x;
    d.prevZ = d.z;
    if (want && (!d.active || d.leaving)) {
      if (!d.active) {
        // Arrive from the map edge furthest from the player.
        d.x = w.player.x > 0 ? -140 : 140;
        d.z = w.player.z > 0 ? -140 : 140;
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
