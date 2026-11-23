import type RAPIER_NS from '@dimforge/rapier3d-simd-compat';
import type { OfficerConfig } from './heat';
import { Groups, interactionGroups } from './physics';
import type { Vehicle, World } from './world';

export type OfficerState = 'chase' | 'return' | 'stunned' | 'down';

/** A police officer on foot (pooled). */
export interface Officer {
  id: number;
  active: boolean;
  state: OfficerState;
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  vx: number;
  vz: number;
  facing: number;
  prevFacing: number;
  hp: number;
  /** Tactical unit: armoured, rifle. */
  tactical: boolean;
  /** The car they came in (vehicle id), or -1. */
  carId: number;
  timer: number;
  fireCooldown: number;
  /** Seconds with the player in sight (the first shot waits for firstShotDelaySec). */
  aimTime: number;
  sees: boolean;
  /** Last time this officer fired (for the renderer's muzzle pose). */
  firedAt: number;
  /** Where the officer is running to. */
  targetX: number;
  targetZ: number;
  /** Should hold position and shoot rather than close in. */
  holding: boolean;
  body: RAPIER_NS.RigidBody | null;
  collider: RAPIER_NS.Collider | null;
}

const LIVE_GROUPS = interactionGroups(Groups.ped, Groups.static | Groups.vehicle | Groups.ped | Groups.player);
const DOWN_GROUPS = interactionGroups(Groups.ghost, Groups.static);
const DEG = Math.PI / 180;

/**
 * Officers on foot: they get out of a stopped patrol car near the player, run
 * them down and cuff them (BOOKED) if they are slow or stopped. From HEAT 3
 * they shoot at an on-foot player instead (hitscan with spread that grows with
 * range and target speed). They go back to the car when the player gets away.
 */
export class OfficerSystem {
  readonly officers: Officer[] = [];

  constructor(
    private readonly world: World,
    public config: OfficerConfig,
  ) {
    for (let i = 0; i < config.pool; i++) {
      this.officers.push({
        id: i,
        active: false,
        state: 'chase',
        x: 0,
        z: 0,
        prevX: 0,
        prevZ: 0,
        vx: 0,
        vz: 0,
        facing: 0,
        prevFacing: 0,
        hp: 0,
        tactical: false,
        carId: -1,
        timer: 0,
        fireCooldown: 0,
        aimTime: 0,
        sees: false,
        firedAt: -10,
        targetX: 0,
        targetZ: 0,
        holding: false,
        body: null,
        collider: null,
      });
    }
  }

  activeCount(): number {
    let n = 0;
    for (const o of this.officers) if (o.active) n++;
    return n;
  }

  /** Officers out of a given car (still standing). */
  countFor(carId: number): number {
    let n = 0;
    for (const o of this.officers) if (o.active && o.carId === carId && o.state !== 'down') n++;
    return n;
  }

  /** Put up to `count` officers on the street beside a car. Returns how many got out. */
  deploy(car: Vehicle, count: number, tactical: boolean): number {
    const w = this.world;
    let n = 0;
    for (let k = 0; k < count; k++) {
      const o = this.officers.find((q) => !q.active);
      if (!o) break;
      // Doors on alternate sides; fall back to behind the car if a wall is in the way.
      const side = k % 2 === 0 ? 1 : -1;
      const off = car.params.width / 2 + 0.9;
      let x = car.x + Math.cos(car.yaw) * off * side - Math.sin(car.yaw) * (k >> 1) * 1.2;
      let z = car.z - Math.sin(car.yaw) * off * side - Math.cos(car.yaw) * (k >> 1) * 1.2;
      if (w.insideBuilding(x, z, 0.5)) {
        x = car.x - Math.sin(car.yaw) * (car.params.length / 2 + 1 + k);
        z = car.z - Math.cos(car.yaw) * (car.params.length / 2 + 1 + k);
      }
      this.spawn(o, x, z, car.id, tactical);
      o.facing = o.prevFacing = Math.atan2(w.player.x - x, w.player.z - z);
      n++;
    }
    return n;
  }

  private spawn(o: Officer, x: number, z: number, carId: number, tactical: boolean): void {
    const { R, physics } = this.world;
    const c = this.config;
    o.active = true;
    o.state = 'chase';
    o.x = o.prevX = o.targetX = x;
    o.z = o.prevZ = o.targetZ = z;
    o.vx = o.vz = 0;
    o.tactical = tactical;
    o.hp = tactical ? c.tacticalHp : c.hp;
    o.carId = carId;
    o.timer = 0;
    o.fireCooldown = 0;
    o.aimTime = 0;
    o.sees = false;
    o.holding = false;
    o.firedAt = -10;
    const body = physics.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, 0, z).enabledTranslations(true, false, true).lockRotations().setLinearDamping(0).setCanSleep(false));
    const collider = physics.createCollider(R.ColliderDesc.ball(c.radius).setTranslation(0, c.radius, 0).setMass(c.mass).setFriction(0).setCollisionGroups(LIVE_GROUPS), body);
    o.body = body;
    o.collider = collider;
    this.world.registerCollider(collider, 'officer', o.id);
  }

  /** Spawn an officer at an exact point (tests, missions). */
  spawnAt(x: number, z: number, tactical = false): Officer | null {
    const o = this.officers.find((q) => !q.active);
    if (!o) return null;
    this.spawn(o, x, z, -1, tactical);
    return o;
  }

  despawn(o: Officer): void {
    if (!o.active) return;
    if (o.collider) this.world.unregisterCollider(o.collider);
    if (o.body) this.world.physics.removeRigidBody(o.body);
    o.body = null;
    o.collider = null;
    o.active = false;
  }

  despawnAll(): void {
    for (const o of this.officers) this.despawn(o);
  }

  /** Returns true if this put the officer down. */
  damage(o: Officer, amount: number, kx: number, kz: number, byPlayer: boolean): boolean {
    if (!o.active || o.state === 'down') return false;
    o.hp -= amount;
    if (o.hp > 0) {
      // Flinch: a shove and a moment's pause before returning fire.
      o.body?.setLinvel({ x: kx, y: 0, z: kz }, true);
      o.fireCooldown = Math.max(o.fireCooldown, 0.35);
      return false;
    }
    o.hp = 0;
    o.state = 'down';
    o.timer = this.config.downSec;
    o.collider?.setCollisionGroups(DOWN_GROUPS);
    o.body?.setLinvel({ x: kx * 0.6, y: 0, z: kz * 0.6 }, true);
    o.vx = kx * 0.6;
    o.vz = kz * 0.6;
    this.world.events.push({ type: 'officerDown', officerId: o.id, x: o.x, z: o.z, byPlayer });
    return true;
  }

  stun(o: Officer, sec: number): void {
    if (!o.active || o.state === 'down') return;
    o.state = 'stunned';
    o.timer = sec;
    o.aimTime = 0;
  }

  /** Any standing officer currently sees the player. */
  anySees(): boolean {
    for (const o of this.officers) if (o.active && o.sees && o.state !== 'down' && o.state !== 'stunned') return true;
    return false;
  }

  /** Can a standing officer see (x, z) from where they are? */
  canSee(x: number, z: number): boolean {
    const w = this.world;
    for (const o of this.officers) {
      if (!o.active || o.state === 'down' || o.state === 'stunned') continue;
      if (Math.hypot(o.x - x, o.z - z) > this.config.sightRange) continue;
      if (w.police.lineOfSight(o.x, o.z, x, z)) return true;
    }
    return false;
  }

  /** Distance from the nearest standing (not stunned) officer to (x, z). */
  nearestDist(x: number, z: number): number {
    let bd = Infinity;
    for (const o of this.officers) {
      if (!o.active || o.state === 'down' || o.state === 'stunned' || o.state === 'return') continue;
      bd = Math.min(bd, Math.hypot(o.x - x, o.z - z));
    }
    return bd;
  }

  /** Pre-physics: decide and set velocities. */
  step(dt: number): void {
    const w = this.world;
    const c = this.config;
    const period = Math.max(1, Math.round(60 / w.content.heat.aiHz));
    const heatOn = w.heat.level > 0 && w.survival.alive;
    for (const o of this.officers) {
      if (!o.active || !o.body) continue;
      o.prevX = o.x;
      o.prevZ = o.z;
      o.prevFacing = o.facing;
      o.fireCooldown = Math.max(0, o.fireCooldown - dt);
      if (o.state === 'down') {
        const k = Math.exp(-4 * dt);
        o.vx *= k;
        o.vz *= k;
        o.body.setLinvel({ x: o.vx, y: 0, z: o.vz }, true);
        o.timer -= dt;
        if (o.timer <= 0 && w.distToPlayer(o.x, o.z) > 30) this.despawn(o);
        continue;
      }
      if (o.state === 'stunned') {
        o.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        o.vx = o.vz = 0;
        o.timer -= dt;
        if (o.timer <= 0) o.state = 'chase';
        continue;
      }
      if (!heatOn && o.state === 'chase') o.state = 'return';
      if ((w.tick + o.id) % period === 0) this.decide(o);
      if (!o.active || !o.body) continue;
      if (o.state === 'chase' && o.sees) {
        o.aimTime += dt;
        this.maybeShoot(o);
      } else o.aimTime = 0;
      // Run towards the target (stop when holding a firing position or right on top of it).
      const dx = o.targetX - o.x;
      const dz = o.targetZ - o.z;
      const d = Math.hypot(dx, dz);
      const speed = o.holding || d < 0.6 ? 0 : c.runSpeed;
      o.vx = d > 0.01 ? (dx / d) * speed : 0;
      o.vz = d > 0.01 ? (dz / d) * speed : 0;
      o.body.setLinvel({ x: o.vx, y: 0, z: o.vz }, true);
      const lookX = o.state === 'chase' && o.sees ? w.player.x - o.x : dx;
      const lookZ = o.state === 'chase' && o.sees ? w.player.z - o.z : dz;
      if (Math.hypot(lookX, lookZ) > 0.05) o.facing = Math.atan2(lookX, lookZ);
    }
  }

  private decide(o: Officer): void {
    const w = this.world;
    const c = this.config;
    const p = w.player;
    const pc = w.playerCtl;
    const d = Math.hypot(p.x - o.x, p.z - o.z);
    o.sees = d < c.sightRange && !pc.busted && !pc.dead && w.police.lineOfSight(o.x, o.z, p.x, p.z);
    o.holding = false;
    const car = o.carId >= 0 ? w.vehicles[o.carId]! : null;
    const carOk = !!car && car.active && !car.destroyed && car.role === 'police';
    if (o.state === 'chase') {
      const pv = p.vehicle;
      const escaping = pv && Math.hypot(pv.vx, pv.vz) > c.carArrestMaxSpeed * 3 && d > 10;
      if (d > c.returnDist || escaping) o.state = 'return';
    }
    if (o.state === 'return') {
      if (carOk) {
        this.moveTo(o, car.x, car.z);
        if (Math.hypot(car.x - o.x, car.z - o.z) < c.boardDist + car.params.width / 2) this.despawn(o);
      } else {
        // No car to go back to: walk off and vanish out of sight.
        if (w.distToPlayer(o.x, o.z) > c.despawnDist) this.despawn(o);
        else this.moveTo(o, o.x + (o.x - p.x), o.z + (o.z - p.z));
      }
      // Back on the case if the player comes back into reach.
      if (o.active && w.heat.level > 0 && w.survival.alive && d < c.returnDist * 0.5 && !(p.vehicle && Math.hypot(p.vehicle.vx, p.vehicle.vz) > c.carArrestMaxSpeed * 3)) o.state = 'chase';
      return;
    }
    const tx = o.sees ? p.x : w.heat.lastKnownX;
    const tz = o.sees ? p.z : w.heat.lastKnownZ;
    const shoot = w.heat.levelConfig.officersShoot && !p.vehicle;
    if (shoot && o.sees && d <= c.shootStandDist && d > c.arrestRange * 1.6) {
      o.holding = true;
      o.targetX = o.x;
      o.targetZ = o.z;
      return;
    }
    // Close in: to the player, or to a car's door.
    let gx = tx;
    let gz = tz;
    if (p.vehicle && o.sees) {
      const v = p.vehicle;
      const side = (o.x - v.x) * Math.cos(v.yaw) - (o.z - v.z) * Math.sin(v.yaw) >= 0 ? 1 : -1;
      gx = v.x + Math.cos(v.yaw) * (v.params.width / 2 + 0.7) * side;
      gz = v.z - Math.sin(v.yaw) * (v.params.width / 2 + 0.7) * side;
    }
    this.moveTo(o, gx, gz);
  }

  /** Head for (x, z): straight if clear, otherwise via the road graph. */
  private moveTo(o: Officer, x: number, z: number): void {
    const w = this.world;
    if (Math.hypot(x - o.x, z - o.z) < 6 || w.police.lineOfSight(o.x, o.z, x, z)) {
      o.targetX = x;
      o.targetZ = z;
      return;
    }
    const here = w.roads.nearest(o.x, o.z);
    const there = w.roads.nearest(x, z);
    const next = Math.hypot(here.x - o.x, here.z - o.z) > 4 ? here : w.roads.nodes[w.roads.nextHop(here.id, there.id)]!;
    o.targetX = next.x;
    o.targetZ = next.z;
  }

  private maybeShoot(o: Officer): void {
    const w = this.world;
    const c = this.config;
    const pc = w.playerCtl;
    if (!w.heat.levelConfig.officersShoot || w.player.vehicle || pc.dead || pc.busted) return;
    if (o.fireCooldown > 0 || o.aimTime < c.firstShotDelaySec) return;
    const d = Math.hypot(pc.x - o.x, pc.z - o.z);
    if (d > c.shootRange) return;
    o.fireCooldown = c.fireIntervalSec * (o.tactical ? 0.7 : 1) * w.rng.range(0.85, 1.2);
    o.firedAt = w.time;
    const spread = (c.spreadDeg + c.spreadPerMetreDeg * d + c.moveSpreadDeg * Math.hypot(pc.vx, pc.vz)) * (o.tactical ? 0.7 : 1);
    const ang = Math.atan2(pc.x - o.x, pc.z - o.z) + (w.rng.next() - 0.5) * spread * DEG;
    w.combat.hitscan(o.x, o.z, ang, c.shootRange + 4, o.tactical ? c.tacticalDamage : c.damage, 1, 0, false, o.collider);
  }

  /** Post-physics: read back and check for being run over. */
  postStep(): void {
    const w = this.world;
    const c = this.config;
    for (const o of this.officers) {
      if (!o.active || !o.body || !o.collider) continue;
      const t = o.body.translation();
      const walkVx = o.vx;
      const walkVz = o.vz;
      o.x = t.x;
      o.z = t.z;
      if (o.state === 'down') continue;
      let hitBy = -1;
      w.physics.contactPairsWith(o.collider, (h) => {
        const owner = w.colliderOwner(h.handle);
        if (owner && owner.kind === 'vehicle') hitBy = owner.id;
      });
      if (hitBy < 0) continue;
      const v = w.vehicles[hitBy]!;
      const rel = Math.hypot(v.setVx - walkVx, v.setVz - walkVz);
      if (rel < c.knockdownSpeed) continue;
      const byPlayer = v === w.player.vehicle;
      if (!byPlayer && v.role === 'police') continue; // colleagues nudge, they do not run you down
      w.combat.damageTarget('officer', o.id, (rel - c.knockdownSpeed) * c.hitDamagePerMs, v.vx, v.vz, byPlayer);
    }
  }
}
