import type { World, Vehicle } from '../world';
import { Groups, interactionGroups } from '../physics';
import type { JumpsConfig } from './config';
import { rampLength, rampSurface, type RampSite } from './placement';
import type { ActivityProgress } from './progress';

/** Collision groups of a car on the ground, and of one flying high enough to clear traffic and people. */
export const VEHICLE_GROUND_GROUPS = interactionGroups(Groups.vehicle, Groups.static | Groups.vehicle | Groups.ped | Groups.player | Groups.ramp);
export const VEHICLE_AIR_GROUPS = interactionGroups(Groups.vehicle, Groups.static);

/** Only take off when the ground's vertical speed drops this much (m/s) more than gravity allows. */
const LIFT_TOLERANCE = 2.6;

/**
 * Stunt ramps and airtime. The arcade car model is flat (XZ); this adds a
 * vertical axis on top of it: height and vertical speed per vehicle, gravity,
 * take-off from a ramp's kicker, landing (hard landings hurt) and, while in the
 * air, no steering and no grip, so the car keeps the line it left on.
 *
 * Every car rides the ramps (traffic too); the player's jumps are measured and
 * paid: distance from take-off to touch-down and time in the air, with a one-off
 * bonus the first time a ramp's target distance is cleared ("unique jump").
 */
export class JumpSystem {
  /** The player's jump in progress. */
  flight: { rampId: string; x: number; z: number; t: number; maxY: number } | null = null;
  /** The last finished jump (HUD and tests). */
  last: { rampId: string; distance: number; air: number; height: number; reward: number; unique: boolean } | null = null;

  constructor(
    private readonly world: World,
    readonly config: JumpsConfig,
    readonly ramps: readonly RampSite[],
    private readonly progress: () => ActivityProgress,
  ) {
    // Side rails along the raised part of each ramp: drive into the side and you hit a wall,
    // rather than popping up onto the deck. Only cars on the ground collide with them.
    const { R, physics } = world;
    const groups = interactionGroups(Groups.ramp, Groups.vehicle);
    for (const r of ramps) {
      const a0 = r.up * 0.35;
      const a1 = r.up + r.deck + r.down * 0.65;
      const fx = Math.sin(r.yaw);
      const fz = Math.cos(r.yaw);
      for (const side of [-1, 1]) {
        const lat = side * (r.width / 2 + 0.15);
        const mid = (a0 + a1) / 2;
        const c = physics.createCollider(
          R.ColliderDesc.cuboid(0.15, 0.6, (a1 - a0) / 2)
            .setTranslation(r.x + fx * mid + fz * lat, 0.6, r.z + fz * mid - fx * lat)
            .setRotation({ x: 0, y: Math.sin(r.yaw / 2), z: 0, w: Math.cos(r.yaw / 2) })
            .setCollisionGroups(groups)
            .setFriction(0.05),
        );
        world.registerCollider(c, 'static', -1);
      }
    }
  }

  /** Ground height under a point: a ramp's surface, else the road (0). */
  surface(x: number, z: number): number {
    let h = 0;
    for (const r of this.ramps) {
      // Cheap reject: ramps are under 20 m long.
      if (Math.abs(x - r.x) > 24 || Math.abs(z - r.z) > 24) continue;
      const s = rampSurface(r, x, z);
      if (s > h) h = s;
    }
    return h;
  }

  /** The ramp under (or just behind) a point, for crediting a take-off. */
  rampAt(x: number, z: number): RampSite | null {
    for (const r of this.ramps) {
      if (Math.abs(x - r.x) > 30 || Math.abs(z - r.z) > 30) continue;
      const fx = Math.sin(r.yaw);
      const fz = Math.cos(r.yaw);
      const dx = x - r.x;
      const dz = z - r.z;
      const along = dx * fx + dz * fz;
      const lat = dx * fz - dz * fx;
      if (Math.abs(lat) <= r.width / 2 + 1 && along >= -1 && along <= rampLength(r) + 3) return r;
    }
    return null;
  }

  /** Horizontal motion while flying: no steering, no grip; a little drag, the spin fades. */
  air(v: Vehicle, dt: number): void {
    const k = 1 - this.config.airDrag * dt;
    v.vx *= k;
    v.vz *= k;
    v.yawRate *= Math.exp(-this.config.airYawDamp * dt);
  }

  /**
   * Vertical step for one vehicle, after the physics step has moved it in XZ.
   * On the ground the car follows the surface (its vertical speed is the slope
   * times its speed); when the surface falls away below the ballistic path it
   * takes off, and in the air it falls until it meets the surface again.
   */
  vertical(v: Vehicle, dt: number): void {
    v.prevY = v.y;
    const cfg = this.config;
    const s = this.surface(v.x, v.z);
    if (!v.airborne && v.y === 0 && s === 0) return; // flat road: the common case
    const g = cfg.gravity;
    if (v.airborne) {
      v.vy -= g * dt;
      v.y += v.vy * dt;
      const f = this.flightOf(v);
      if (f && v.y > f.maxY) f.maxY = v.y;
      this.setGroups(v, v.y > cfg.clearHeight);
      if (v.y <= s) this.land(v, s);
      return;
    }
    if (s - v.y > 0.5) {
      // Onto a ramp from the side or by a teleport: set it on the surface, no launch.
      v.y = s;
      v.vy = 0;
      return;
    }
    // The ground's own vertical speed under the car. If it falls away faster than gravity
    // could pull the car after it (the top of a kicker, the edge of the deck), the car flies.
    const groundVy = (s - v.y) / dt;
    if (groundVy < v.vy - g * dt - LIFT_TOLERANCE) {
      v.airborne = true;
      if (v.vy > 0) v.vy *= cfg.launchBoost;
      v.vy -= g * dt;
      v.y += v.vy * dt;
      this.takeOff(v);
      return;
    }
    v.vy = (s - v.y) / dt;
    v.y = s;
    if (s === 0) v.vy = 0;
  }

  private flightOf(v: Vehicle): JumpSystem['flight'] {
    return v === this.world.player.vehicle ? this.flight : null;
  }

  private setGroups(v: Vehicle, high: boolean): void {
    if (v.airHigh === high || !v.collider) return;
    v.airHigh = high;
    v.collider.setCollisionGroups(high ? VEHICLE_AIR_GROUPS : VEHICLE_GROUND_GROUPS);
  }

  private takeOff(v: Vehicle): void {
    const w = this.world;
    if (v !== w.player.vehicle) return;
    const r = this.rampAt(v.x, v.z);
    this.flight = { rampId: r?.id ?? '', x: v.x, z: v.z, t: w.time, maxY: v.y };
    const g = this.config.gravity;
    const air = (v.vy + Math.sqrt(Math.max(0, v.vy * v.vy + 2 * g * v.y))) / g;
    const speed = Math.hypot(v.vx, v.vz);
    w.events.push({ type: 'jumpTakeoff', vehicleId: v.id, rampId: r?.id ?? '', air, speed, x: v.x, z: v.z });
  }

  private land(v: Vehicle, s: number): void {
    const w = this.world;
    const cfg = this.config;
    const impact = -v.vy;
    v.airborne = false;
    v.y = s;
    // Touching down on a slope: carry on at the slope's own vertical speed, so the car
    // rolls down it instead of bouncing off it.
    v.vy = s > 0 ? Math.min(0, (this.surface(v.x + v.vx / 60, v.z + v.vz / 60) - s) * 60) : 0;
    this.setGroups(v, false);
    const keep = cfg.landing.speedKeep;
    v.vx *= keep;
    v.vz *= keep;
    v.body?.setLinvel({ x: v.vx, y: 0, z: v.vz }, true);
    if (impact > cfg.landing.hardSpeed) w.damageVehicle(v, (impact - cfg.landing.hardSpeed) * cfg.landing.damagePerMs);
    const f = this.flightOf(v);
    if (!f) {
      w.events.push({ type: 'jumpLanded', vehicleId: v.id, rampId: '', distance: 0, air: 0, height: 0, reward: 0, unique: false, impact, best: false, byPlayer: false, x: v.x, z: v.z });
      return;
    }
    this.flight = null;
    const distance = Math.hypot(v.x - f.x, v.z - f.z);
    const air = w.time - f.t;
    let reward = 0;
    let unique = false;
    let best = false;
    const r = f.rampId ? this.ramps.find((q) => q.id === f.rampId) : undefined;
    if (r && !v.destroyed && distance >= cfg.reward.minDistance) {
      reward = Math.round(cfg.reward.base + cfg.reward.perMetre * distance + cfg.reward.perAirSecond * air);
      const p = this.progress();
      const rec = (p.jumps[r.id] ??= { best: 0, unique: false });
      if (distance > rec.best) {
        best = rec.best > 0;
        rec.best = Math.round(distance * 10) / 10;
      }
      if (!rec.unique && distance >= r.target) {
        rec.unique = true;
        unique = true;
        reward += cfg.reward.unique;
      }
      w.score.credits += reward;
    }
    this.last = { rampId: f.rampId, distance, air, height: f.maxY, reward, unique };
    w.events.push({ type: 'jumpLanded', vehicleId: v.id, rampId: f.rampId, distance, air, height: f.maxY, reward, unique, impact, best, byPlayer: true, x: v.x, z: v.z });
  }

  /** The player left the car (or it was swapped) mid-flight: forget the measurement. */
  reset(): void {
    this.flight = null;
  }
}
