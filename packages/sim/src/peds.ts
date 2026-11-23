import type RAPIER_NS from '@dimforge/rapier3d-simd-compat';
import type { PedsConfig } from './content';
import { Groups, interactionGroups } from './physics';
import type { World } from './world';

export type PedState = 'wander' | 'flee' | 'cower' | 'down';

export interface Ped {
  id: number;
  active: boolean;
  state: PedState;
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  facing: number;
  prevFacing: number;
  vx: number;
  vz: number;
  timer: number;
  targetX: number;
  targetZ: number;
  threatX: number;
  threatZ: number;
  colour: number;
  hp: number;
  body: RAPIER_NS.RigidBody | null;
  collider: RAPIER_NS.Collider | null;
}

const PED_GROUPS = interactionGroups(Groups.ped, Groups.static | Groups.vehicle | Groups.ped | Groups.player);
const DOWN_GROUPS = interactionGroups(Groups.ghost, Groups.static);

/**
 * Pooled pedestrians: wander the pavements, flee from gunfire and crashes,
 * sometimes cower, and get knocked down by cars.
 */
export class PedSystem {
  readonly peds: Ped[] = [];
  /** Active cap (quality tiers lower it). */
  cap: number;

  constructor(
    private readonly world: World,
    public config: PedsConfig,
  ) {
    this.cap = config.count;
    for (let i = 0; i < Math.max(config.count, 40); i++) {
      this.peds.push({
        id: i,
        active: false,
        state: 'wander',
        x: 0,
        z: 0,
        prevX: 0,
        prevZ: 0,
        facing: 0,
        prevFacing: 0,
        vx: 0,
        vz: 0,
        timer: 0,
        targetX: 0,
        targetZ: 0,
        threatX: 0,
        threatZ: 0,
        colour: 0,
        hp: 0,
        body: null,
        collider: null,
      });
    }
  }

  populate(): void {
    for (let i = 0; i < this.cap; i++) this.spawnSomewhere(false);
  }

  /** A random walkable point: inside the map, outside buildings, off the road centre. */
  private randomPoint(nearX: number, nearZ: number, radius: number, out: { x: number; z: number }): boolean {
    const w = this.world;
    const half = w.content.map.size[0] / 2 - 3;
    for (let tries = 0; tries < 12; tries++) {
      const x = nearX + w.rng.range(-radius, radius);
      const z = nearZ + w.rng.range(-radius, radius);
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
      if (w.insideBuilding(x, z, 1)) continue;
      out.x = x;
      out.z = z;
      return true;
    }
    return false;
  }

  private readonly tmp = { x: 0, z: 0 };

  spawnSomewhere(awayFromPlayer: boolean): Ped | null {
    const p = this.peds.find((q) => !q.active);
    if (!p) return null;
    const w = this.world;
    for (let tries = 0; tries < 8; tries++) {
      if (!this.randomPoint(0, 0, w.content.map.size[0] / 2, this.tmp)) continue;
      if (awayFromPlayer && w.distToPlayer(this.tmp.x, this.tmp.z) < this.config.respawnMinDist) continue;
      this.spawnAt(p, this.tmp.x, this.tmp.z);
      return p;
    }
    return null;
  }

  /** Spawn a ped at an exact point (e.g. a driver thrown out of a car). */
  spawnPedAt(x: number, z: number): Ped | null {
    const p = this.peds.find((q) => !q.active);
    if (!p) return null;
    this.spawnAt(p, x, z);
    return p;
  }

  private spawnAt(p: Ped, x: number, z: number): void {
    const { R, physics, rng } = this.world;
    p.active = true;
    p.state = 'wander';
    p.x = p.prevX = p.targetX = x;
    p.z = p.prevZ = p.targetZ = z;
    p.vx = p.vz = 0;
    p.timer = rng.range(0, 2);
    p.facing = p.prevFacing = rng.range(-Math.PI, Math.PI);
    p.colour = rng.int(0, this.config.colours.length - 1);
    p.hp = this.config.hp;
    const body = physics.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(x, 0, z)
        .enabledTranslations(true, false, true)
        .lockRotations()
        .setLinearDamping(0)
        .setCanSleep(false),
    );
    const collider = physics.createCollider(
      R.ColliderDesc.ball(this.config.radius).setTranslation(0, this.config.radius, 0).setMass(this.config.mass).setFriction(0).setCollisionGroups(PED_GROUPS),
      body,
    );
    p.body = body;
    p.collider = collider;
    this.world.registerCollider(collider, 'ped', p.id);
  }

  despawn(p: Ped): void {
    if (!p.active) return;
    if (p.collider) this.world.unregisterCollider(p.collider);
    if (p.body) this.world.physics.removeRigidBody(p.body);
    p.body = null;
    p.collider = null;
    p.active = false;
  }

  activeCount(): number {
    let n = 0;
    for (const p of this.peds) if (p.active) n++;
    return n;
  }

  /** Make every ped within `radius` of (x, z) react to a threat there. */
  alarm(x: number, z: number, radius: number): void {
    const w = this.world;
    for (const p of this.peds) {
      if (!p.active || p.state === 'down') continue;
      if (Math.hypot(p.x - x, p.z - z) > radius) continue;
      p.threatX = x;
      p.threatZ = z;
      if (p.state !== 'flee' && p.state !== 'cower' && w.rng.chance(this.config.cowerChance) && Math.hypot(p.x - x, p.z - z) < radius * 0.4) {
        p.state = 'cower';
        p.timer = this.config.cowerSec;
      } else if (p.state !== 'cower') {
        p.state = 'flee';
        p.timer = w.rng.range(this.config.fleeSecMin, this.config.fleeSecMax);
      }
    }
  }

  /**
   * Knock a ped flat (hit by a car, shot dead). A car hit by the player is a
   * crime; weapons report their own crimes, so they pass `carHit` false.
   */
  knockDown(p: Ped, vx: number, vz: number, byPlayer: boolean, carHit = true): void {
    if (p.state === 'down') return;
    const w = this.world;
    p.state = 'down';
    p.hp = 0;
    p.timer = this.config.downSec;
    p.collider?.setCollisionGroups(DOWN_GROUPS);
    p.body?.setLinvel({ x: vx * 0.6, y: 0, z: vz * 0.6 }, true);
    w.events.push({ type: 'pedHit', pedId: p.id, x: p.x, z: p.z, byPlayer });
    if (byPlayer && carHit && w.heat.pedHit(w.time)) w.police.crime('hitPed', w.player.x, w.player.z);
    this.alarm(p.x, p.z, this.config.crashAlertRadius);
  }

  /** Weapon or fist damage. Returns true if this put the ped down. */
  damage(p: Ped, amount: number, kx: number, kz: number, byPlayer: boolean): boolean {
    if (!p.active || p.state === 'down') return false;
    p.hp -= amount;
    if (p.hp <= 0) {
      this.knockDown(p, kx, kz, byPlayer, false);
      return true;
    }
    // Hurt: stagger back, then run from whoever did it.
    p.body?.setLinvel({ x: kx, y: 0, z: kz }, true);
    p.state = 'flee';
    p.timer = this.world.rng.range(this.config.fleeSecMin, this.config.fleeSecMax);
    p.threatX = this.world.player.x;
    p.threatZ = this.world.player.z;
    return false;
  }

  /** Arc caster: rooted to the spot, twitching, for `sec`. */
  stun(p: Ped, sec: number): void {
    if (!p.active || p.state === 'down') return;
    p.state = 'cower';
    p.timer = sec;
    p.threatX = this.world.player.x;
    p.threatZ = this.world.player.z;
  }

  /** Pre-physics: decide and set velocities. */
  step(dt: number): void {
    const w = this.world;
    const cfg = this.config;
    const period = Math.max(1, Math.round(60 / cfg.aiHz));
    for (const p of this.peds) {
      if (!p.active || !p.body) continue;
      p.prevX = p.x;
      p.prevZ = p.z;
      p.prevFacing = p.facing;
      p.timer -= dt;
      if (p.state === 'down') {
        // Slide to a stop.
        const k = Math.exp(-4 * dt);
        p.body.setLinvel({ x: p.vx * k, y: 0, z: p.vz * k }, true);
        if (p.timer <= 0 && w.distToPlayer(p.x, p.z) > 30) {
          this.despawn(p);
        }
        continue;
      }
      if ((w.tick + p.id) % period === 0) this.decide(p);
      let speed = 0;
      let dx = 0;
      let dz = 0;
      if (p.state === 'wander') {
        dx = p.targetX - p.x;
        dz = p.targetZ - p.z;
        speed = cfg.walkSpeed;
        if (Math.hypot(dx, dz) < 1 || p.timer < -12) speed = 0;
      } else if (p.state === 'flee') {
        dx = p.x - p.threatX;
        dz = p.z - p.threatZ;
        speed = cfg.runSpeed;
      }
      const len = Math.hypot(dx, dz);
      const vx = len > 0.01 ? (dx / len) * speed : 0;
      const vz = len > 0.01 ? (dz / len) * speed : 0;
      p.body.setLinvel({ x: vx, y: 0, z: vz }, true);
      p.vx = vx;
      p.vz = vz;
      if (speed > 0 && len > 0.01) p.facing = Math.atan2(dx, dz);
    }
    // Top up the population away from the player.
    if (w.tick % 30 === 0 && this.activeCount() < this.cap) this.spawnSomewhere(true);
    while (this.activeCount() > this.cap) {
      const far = this.peds.find((p) => p.active && w.distToPlayer(p.x, p.z) > cfg.respawnMinDist);
      if (!far) break;
      this.despawn(far);
    }
  }

  private decide(p: Ped): void {
    const w = this.world;
    const cfg = this.config;
    if ((p.state === 'flee' || p.state === 'cower') && p.timer <= 0) {
      p.state = 'wander';
      p.timer = 0;
    }
    // Dive away from fast cars bearing down.
    for (const v of w.vehicles) {
      if (!v.active || v.destroyed) continue;
      const sp = Math.hypot(v.vx, v.vz);
      if (sp < cfg.carDangerSpeed) continue;
      const dx = p.x - v.x;
      const dz = p.z - v.z;
      const d = Math.hypot(dx, dz);
      if (d > cfg.carDangerDist + sp * 0.4) continue;
      if ((dx * v.vx + dz * v.vz) / (d * sp + 1e-6) < 0.7) continue;
      p.state = 'flee';
      p.timer = 1.2;
      // Flee sideways from the car's path.
      const side = dx * v.vz - dz * v.vx > 0 ? 1 : -1;
      p.threatX = p.x - (v.vz / sp) * side * 5;
      p.threatZ = p.z + (v.vx / sp) * side * 5;
      return;
    }
    if (p.state === 'wander' && (p.timer <= 0 || Math.hypot(p.targetX - p.x, p.targetZ - p.z) < 1.2)) {
      if (this.randomPoint(p.x, p.z, cfg.wanderRadius, this.tmp)) {
        p.targetX = this.tmp.x;
        p.targetZ = this.tmp.z;
      }
      p.timer = w.rng.range(4, 10);
    }
  }

  /** Post-physics: read back and check for cars hitting peds. */
  postStep(): void {
    const w = this.world;
    for (const p of this.peds) {
      if (!p.active || !p.body || !p.collider) continue;
      const t = p.body.translation();
      const lv = p.body.linvel();
      // Velocity we walked with this step, before contacts shoved us.
      const walkVx = p.vx;
      const walkVz = p.vz;
      p.x = t.x;
      p.z = t.z;
      p.vx = lv.x;
      p.vz = lv.z;
      if (p.state === 'down') continue;
      let hitBy = -1;
      w.physics.contactPairsWith(p.collider, (c) => {
        const o = w.colliderOwner(c.handle);
        if (o && o.kind === 'vehicle') hitBy = o.id;
      });
      if (hitBy < 0) continue;
      const v = w.vehicles[hitBy]!;
      const rel = Math.hypot(v.setVx - walkVx, v.setVz - walkVz);
      if (rel > this.config.knockdownSpeed) this.knockDown(p, v.vx, v.vz, v === w.player.vehicle);
    }
  }
}
