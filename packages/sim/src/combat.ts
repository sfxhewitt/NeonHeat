import type RAPIER_NS from '@dimforge/rapier3d-simd-compat';
import type { WeaponDef, WeaponsConfig } from './content';
import type { Intents } from './intents';
import { Groups, interactionGroups, wrapAngle } from './physics';
import type { Vehicle, World } from './world';

export type TargetKind = 'vehicle' | 'officer' | 'ped';

/** A grenade in flight (pooled). */
export interface Projectile {
  active: boolean;
  x: number;
  y: number;
  z: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds since launch. */
  age: number;
  fuse: number;
  byPlayer: boolean;
  weapon: string;
}

interface Target {
  kind: TargetKind;
  id: number;
  x: number;
  z: number;
}

const DEG = Math.PI / 180;
const SHOT_GROUPS = interactionGroups(0xffff, Groups.static | Groups.vehicle | Groups.ped);
/** Police rounds can also hit the player. */
const POLICE_SHOT_GROUPS = interactionGroups(0xffff, Groups.static | Groups.vehicle | Groups.player);
/** Seconds after a player hit during which a vehicle's destruction is the player's doing. */
const BLAME_SEC = 4;

/**
 * Weapons and damage: the player's inventory and every way of hurting things
 * (fists and bat combos, hitscan guns with spread and pellets, arcing grenades,
 * the chaining arc caster, drive-bys), plus explosions. Pure sim: emits events
 * the renderer draws.
 */
export class CombatSystem {
  readonly order: readonly string[];
  readonly owned: boolean[];
  readonly ammo: number[];
  /** Index into `order` of the weapon in hand. */
  current = 0;
  fireCooldown = 0;
  comboIndex = 0;
  comboTimer = 0;
  /** Soft-lock target for the HUD and renderer. */
  aimKind: TargetKind | null = null;
  aimId = -1;
  aimX = 0;
  aimZ = 0;
  /** Seconds since the player last pulled the trigger (for the aiming pose). */
  sinceFired = 10;
  readonly projectiles: Projectile[] = [];
  /** Remaining flip time per vehicle id: an explosion throws cars over (the renderer rolls them). */
  readonly flip: Float32Array;
  /** Pending blast per vehicle id (seconds until a wreck goes up), or -1. */
  private readonly blastTimer: Float32Array;
  /** Last time the player damaged each vehicle. */
  private readonly playerHitTime: Float64Array;
  private readonly ray: RAPIER_NS.Ray;
  private readonly tmpTarget: Target = { kind: 'ped', id: -1, x: 0, z: 0 };
  private readonly visited: Target[] = [];

  constructor(
    private readonly world: World,
    public config: WeaponsConfig,
  ) {
    this.order = config.order;
    this.owned = config.order.map(() => false);
    this.ammo = config.order.map(() => 0);
    const n = world.vehicles.length;
    this.flip = new Float32Array(n);
    this.blastTimer = new Float32Array(n).fill(-1);
    this.playerHitTime = new Float64Array(n).fill(-1e9);
    let pool = 0;
    for (const w of Object.values(config.weapons)) pool = Math.max(pool, w.projectile?.pool ?? 0);
    for (let i = 0; i < pool; i++) {
      this.projectiles.push({ active: false, x: 0, y: 0, z: 0, prevX: 0, prevY: 0, prevZ: 0, vx: 0, vy: 0, vz: 0, age: 0, fuse: 0, byPlayer: true, weapon: '' });
    }
    for (let i = 0; i < 4; i++) this.visited.push({ kind: 'ped', id: -1, x: 0, z: 0 });
    this.ray = new world.R.Ray({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
    this.resetLoadout(config.startLoadout);
  }

  get weaponId(): string {
    return this.order[this.current]!;
  }

  get weapon(): WeaponDef {
    return this.config.weapons[this.weaponId]!;
  }

  /** Ammo for the weapon in hand, or -1 when it needs none. */
  get currentAmmo(): number {
    return this.weapon.ammoMax > 0 ? this.ammo[this.current]! : -1;
  }

  ammoOf(id: string): number {
    const i = this.order.indexOf(id);
    return i < 0 ? 0 : this.ammo[i]!;
  }

  has(id: string): boolean {
    const i = this.order.indexOf(id);
    return i >= 0 && this.owned[i]!;
  }

  /** Replace the inventory (start of game, after FLATLINED or BOOKED). */
  resetLoadout(loadout: Record<string, number>): void {
    this.owned.fill(false);
    this.ammo.fill(0);
    for (const [id, n] of Object.entries(loadout)) {
      const i = this.order.indexOf(id);
      if (i < 0) continue;
      this.owned[i] = true;
      this.ammo[i] = Math.min(n, this.config.weapons[id]!.ammoMax);
    }
    // Hold the best gun given, else the first weapon.
    this.current = 0;
    for (let i = this.order.length - 1; i >= 0; i--) {
      if (this.owned[i] && this.usable(i)) {
        this.current = i;
        break;
      }
    }
    this.comboIndex = 0;
  }

  private usable(i: number): boolean {
    const d = this.config.weapons[this.order[i]!]!;
    return this.owned[i]! && (d.ammoMax === 0 || this.ammo[i]! > 0);
  }

  /** Add a weapon and/or ammo. False if nothing changed (already full). */
  give(id: string, ammo: number): boolean {
    const i = this.order.indexOf(id);
    if (i < 0) return false;
    const d = this.config.weapons[id]!;
    const had = this.owned[i]!;
    const before = this.ammo[i]!;
    this.owned[i] = true;
    if (d.ammoMax > 0) this.ammo[i] = Math.min(d.ammoMax, before + ammo);
    const changed = !had || this.ammo[i] !== before;
    // Picking up a new gun puts it in hand, as does finding ammo while holding something weaker.
    if (changed && (!had || !this.usable(this.current) || this.weapon.kind === 'melee')) this.select(i);
    return changed;
  }

  private select(i: number): void {
    if (i === this.current) return;
    this.current = i;
    this.comboIndex = 0;
    this.comboTimer = 0;
    this.fireCooldown = Math.max(this.fireCooldown, 0.15);
    this.world.events.push({ type: 'weaponSwitched', weapon: this.weaponId });
  }

  /** Cycle to the next owned weapon that can fire. */
  nextWeapon(): void {
    const n = this.order.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.current + k) % n;
      if (this.usable(i)) {
        this.select(i);
        return;
      }
    }
  }

  /** On foot: aim, switch and fire. Returns the facing to turn to (the target), or null. */
  footStep(intents: Intents, x: number, z: number, facing: number, dt: number, canFire: boolean): number | null {
    this.tickTimers(dt);
    if (intents.nextWeapon) this.nextWeapon();
    const wp = this.weapon;
    const t = this.findTarget(x, z, facing, wp, wp.kind === 'melee');
    let turn: number | null = null;
    if (t && intents.fire && canFire) turn = Math.atan2(t.x - x, t.z - z);
    if (intents.fire && canFire && this.fireCooldown <= 0) {
      const ang = turn ?? facing;
      this.fire(x, z, ang, t, -1);
    }
    return turn;
  }

  /** Driving: switch weapons, and fire a drive-by weapon sideways. */
  driveStep(intents: Intents, v: Vehicle, dt: number): void {
    this.tickTimers(dt);
    if (intents.nextWeapon) this.nextWeapon();
    const wp = this.weapon;
    this.aimKind = null;
    this.aimId = -1;
    if (!wp.driveBy) return;
    // Look out of both side windows; left (driver's side) first.
    const left = v.yaw + Math.PI / 2;
    const right = v.yaw - Math.PI / 2;
    const cone = this.config.driveByConeDeg;
    let t = this.findHostile(v.x, v.z, left, wp.range, cone, v);
    let side = left;
    if (!t) {
      t = this.findHostile(v.x, v.z, right, wp.range, cone, v);
      if (t) side = right;
    }
    if (t) this.setAim(t);
    if (!intents.fire || this.fireCooldown > 0) return;
    const ang = t ? Math.atan2(t.x - v.x, t.z - v.z) : side;
    const ox = v.x + Math.sin(ang) * (v.params.width / 2 + 0.3);
    const oz = v.z + Math.cos(ang) * (v.params.width / 2 + 0.3);
    this.fire(ox, oz, ang, t, v.id);
  }

  private tickTimers(dt: number): void {
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.comboTimer = Math.max(0, this.comboTimer - dt);
    this.sinceFired += dt;
  }

  private setAim(t: Target | null): void {
    this.aimKind = t ? t.kind : null;
    this.aimId = t ? t.id : -1;
    if (t) {
      this.aimX = t.x;
      this.aimZ = t.z;
    }
  }

  /** Soft-lock: nearest hostile in the weapon's cone; melee also takes the nearest person in reach. */
  private findTarget(x: number, z: number, facing: number, wp: WeaponDef, anyone: boolean): Target | null {
    let t: Target | null;
    if (anyone) t = this.findPerson(x, z, facing, wp.range + 0.6, wp.lockConeDeg);
    else t = this.findHostile(x, z, facing, wp.range, wp.lockConeDeg, null);
    this.setAim(t);
    return t;
  }

  /** Officers and police/squad vehicles in a cone. */
  findHostile(x: number, z: number, facing: number, range: number, coneDeg: number, exclude: Vehicle | null): Target | null {
    const w = this.world;
    const half = (coneDeg * DEG) / 2;
    let bd = Infinity;
    let found = false;
    const out = this.tmpTarget;
    const consider = (kind: TargetKind, id: number, tx: number, tz: number, bias: number): void => {
      const dx = tx - x;
      const dz = tz - z;
      const d = Math.hypot(dx, dz);
      if (d > range || d < 0.01) return;
      if (Math.abs(wrapAngle(Math.atan2(dx, dz) - facing)) > half) return;
      const score = d + bias;
      if (score < bd) {
        bd = score;
        found = true;
        out.kind = kind;
        out.id = id;
        out.x = tx;
        out.z = tz;
      }
    };
    // People with guns first: an officer a little further away still wins over a car.
    for (const o of w.officers.officers) if (o.active && o.state !== 'down') consider('officer', o.id, o.x, o.z, -4);
    for (const v of w.vehicles) {
      if (!v.active || v.destroyed || v === exclude || v === w.player.vehicle) continue;
      if (v.role !== 'police' && v.role !== 'squad') continue;
      consider('vehicle', v.id, v.x, v.z, 0);
    }
    return found ? out : null;
  }

  /** Nearest standing person (officer or pedestrian) in reach and cone. */
  private findPerson(x: number, z: number, facing: number, range: number, coneDeg: number): Target | null {
    const w = this.world;
    const half = (coneDeg * DEG) / 2;
    let bd = Infinity;
    let found = false;
    const out = this.tmpTarget;
    const consider = (kind: TargetKind, id: number, tx: number, tz: number): void => {
      const dx = tx - x;
      const dz = tz - z;
      const d = Math.hypot(dx, dz);
      if (d > range || d < 0.01 || d >= bd) return;
      if (Math.abs(wrapAngle(Math.atan2(dx, dz) - facing)) > half) return;
      bd = d;
      found = true;
      out.kind = kind;
      out.id = id;
      out.x = tx;
      out.z = tz;
    };
    for (const o of w.officers.officers) if (o.active && o.state !== 'down') consider('officer', o.id, o.x, o.z);
    for (const p of w.peds.peds) if (p.active && p.state !== 'down') consider('ped', p.id, p.x, p.z);
    return found ? out : null;
  }

  /** Pull the trigger once for the weapon in hand. `fromVehicle` is the drive-by car (or -1). */
  private fire(x: number, z: number, ang: number, target: Target | null, fromVehicle: number): void {
    const w = this.world;
    const wp = this.weapon;
    const i = this.current;
    if (wp.ammoMax > 0) {
      if (this.ammo[i]! <= 0) {
        this.nextWeapon();
        return;
      }
      this.ammo[i]! -= 1;
    }
    this.fireCooldown = wp.fireIntervalSec;
    this.sinceFired = 0;
    const exclude = fromVehicle >= 0 ? w.vehicles[fromVehicle]!.collider : w.playerCtl.collider;
    if (wp.kind === 'melee') this.melee(x, z, ang, wp, target);
    else if (wp.kind === 'hitscan') {
      for (let k = 0; k < wp.pellets; k++) {
        const spread = (w.rng.next() - 0.5) * wp.spreadDeg * DEG;
        this.hitscan(x, z, ang + spread, wp.range, wp.damagePed, wp.damageVehicle, wp.knockback, true, exclude);
      }
    } else if (wp.kind === 'projectile') this.launch(x, z, ang, wp, target);
    else this.arcCast(x, z, ang, wp, target);
    if (wp.kind !== 'melee') {
      w.police.crime('gunfire', w.player.x, w.player.z);
      if (wp.noiseRadius > 0) w.peds.alarm(x, z, wp.noiseRadius);
    }
    // Out of rounds: drop to the next usable weapon.
    if (wp.ammoMax > 0 && this.ammo[i]! <= 0) this.nextWeapon();
  }

  /**
   * One hitscan round. Returns what it hit. Shared by player guns and police fire.
   */
  hitscan(
    x: number,
    z: number,
    ang: number,
    range: number,
    dmgPed: number,
    dmgVehicle: number,
    knockback: number,
    byPlayer: boolean,
    exclude: RAPIER_NS.Collider | null,
  ): 'none' | 'static' | 'vehicle' | 'ped' | 'player' | 'officer' {
    const w = this.world;
    const dx = Math.sin(ang);
    const dz = Math.cos(ang);
    const r = this.ray;
    r.origin.x = x + dx * 0.6;
    r.origin.y = 1.0;
    r.origin.z = z + dz * 0.6;
    r.dir.x = dx;
    r.dir.y = 0;
    r.dir.z = dz;
    const hit = w.physics.castRay(r, range, true, undefined, byPlayer ? SHOT_GROUPS : POLICE_SHOT_GROUPS, exclude ?? undefined);
    let kind: 'none' | 'static' | 'vehicle' | 'ped' | 'player' | 'officer' = 'none';
    let dist = range;
    if (hit) {
      dist = hit.timeOfImpact;
      const owner = w.colliderOwner(hit.collider.handle);
      if (owner && (owner.kind === 'vehicle' || owner.kind === 'ped' || owner.kind === 'officer' || owner.kind === 'player')) {
        kind = owner.kind;
        this.damageTarget(owner.kind, owner.id, owner.kind === 'vehicle' ? dmgVehicle : dmgPed, dx * knockback, dz * knockback, byPlayer);
      } else kind = 'static';
    }
    w.events.push({ type: 'shot', x: x + dx * 0.6, z: z + dz * 0.6, hx: x + dx * dist, hz: z + dz * dist, hit: kind, byPlayer });
    return kind;
  }

  /**
   * Damage one thing. Player-caused damage reports the matching crime.
   * Returns true if it put the target down (or destroyed it).
   */
  damageTarget(kind: TargetKind | 'player', id: number, amount: number, kx: number, kz: number, byPlayer: boolean): boolean {
    const w = this.world;
    if (amount <= 0 && kind !== 'ped') return false;
    const px = w.player.x;
    const pz = w.player.z;
    if (kind === 'vehicle') {
      const v = w.vehicles[id]!;
      if (!v.active || v.destroyed || v === w.player.vehicle) return false;
      if (byPlayer) this.playerHitTime[id] = w.time;
      w.damageVehicle(v, amount);
      if (byPlayer) {
        const police = v.role === 'police';
        if (v.destroyed) w.police.crime(police ? 'destroyPolice' : 'destroyVehicle', px, pz);
        else if (police) w.police.crime('shootPolice', px, pz);
      }
      return v.destroyed;
    }
    if (kind === 'ped') {
      const p = w.peds.peds[id]!;
      const down = w.peds.damage(p, amount, kx, kz, byPlayer);
      if (byPlayer) w.police.crime(down ? 'killPed' : 'assault', px, pz);
      return down;
    }
    if (kind === 'officer') {
      const o = w.officers.officers[id]!;
      const down = w.officers.damage(o, amount, kx, kz, byPlayer);
      if (byPlayer) w.police.crime(down ? 'killCop' : 'shootPolice', px, pz);
      return down;
    }
    w.playerCtl.hurt(amount, -1);
    return w.playerCtl.dead;
  }

  private melee(x: number, z: number, ang: number, wp: WeaponDef, target: Target | null): void {
    const w = this.world;
    const combo = this.comboTimer > 0 ? (this.comboIndex + 1) % wp.comboDamage.length : 0;
    this.comboIndex = combo;
    this.comboTimer = wp.comboWindowSec;
    const dmg = wp.comboDamage[combo]!;
    const last = combo === wp.comboDamage.length - 1;
    const kb = wp.knockback * (last ? 1.8 : 1);
    const dx = Math.sin(ang);
    const dz = Math.cos(ang);
    let hit = false;
    let hx = x + dx * wp.range;
    let hz = z + dz * wp.range;
    if (target && (target.kind === 'ped' || target.kind === 'officer')) {
      hit = true;
      hx = target.x;
      hz = target.z;
      this.damageTarget(target.kind, target.id, dmg, dx * kb, dz * kb, true);
    } else if (wp.damageVehicle > 0) {
      // A bat on a car: dents, alarms and HEAT if it is a police car.
      for (const v of w.vehicles) {
        if (!v.active || v.destroyed || v === w.player.vehicle) continue;
        if (footprintDist(v, hx, hz) > 0.6) continue;
        hit = true;
        this.damageTarget('vehicle', v.id, wp.damageVehicle, 0, 0, true);
        if (v.role === 'traffic') {
          v.ai.mode = 'stunned';
          v.ai.timer = 1;
        }
        break;
      }
    }
    if (wp.noiseRadius > 0 && hit) w.peds.alarm(x, z, wp.noiseRadius);
    w.events.push({ type: 'melee', x, z, hx, hz, hit, combo });
  }

  private launch(x: number, z: number, ang: number, wp: WeaponDef, target: Target | null): void {
    const w = this.world;
    const pc = wp.projectile!;
    const p = this.projectiles.find((q) => !q.active);
    if (!p) return;
    let d = wp.range;
    if (target) d = Math.min(wp.range, Math.hypot(target.x - x, target.z - z));
    d = Math.max(5, d);
    const spread = (w.rng.next() - 0.5) * wp.spreadDeg * DEG;
    const a = ang + spread;
    const t = d / pc.speed;
    p.active = true;
    p.x = p.prevX = x + Math.sin(a) * 0.8;
    p.y = p.prevY = 1.3;
    p.z = p.prevZ = z + Math.cos(a) * 0.8;
    p.vx = Math.sin(a) * pc.speed;
    p.vz = Math.cos(a) * pc.speed;
    // Land at the target: rise and fall over the flight time (starting 1.3 m up).
    p.vy = (pc.gravity * t) / 2 - 1.3 / t;
    p.age = 0;
    p.fuse = pc.fuseSec;
    p.byPlayer = true;
    p.weapon = this.weaponId;
    w.events.push({ type: 'launch', x: p.x, z: p.z });
  }

  private arcCast(x: number, z: number, ang: number, wp: WeaponDef, target: Target | null): void {
    const w = this.world;
    const arc = wp.arc!;
    const pts: number[] = [x, z];
    let first: Target | null = target;
    if (!first) {
      // Not locked on to a hostile: the arc jumps to anyone (or any car) in reach.
      first = this.findPerson(x, z, ang, wp.range, wp.lockConeDeg);
      if (!first) first = this.nearestVehicleInCone(x, z, ang, wp.range, wp.lockConeDeg);
    }
    if (!first) {
      pts.push(x + Math.sin(ang) * wp.range * 0.6, z + Math.cos(ang) * wp.range * 0.6);
      w.events.push({ type: 'arc', points: pts, n: 2 });
      return;
    }
    let n = 0;
    let cur: Target = first;
    for (;;) {
      const slot = this.visited[n]!;
      slot.kind = cur.kind;
      slot.id = cur.id;
      slot.x = cur.x;
      slot.z = cur.z;
      n++;
      pts.push(cur.x, cur.z);
      this.shock(slot, wp, arc.stunSec);
      if (n > arc.chain) break;
      const next = this.nearestUnvisited(slot.x, slot.z, arc.chainRange, n);
      if (!next) break;
      cur = next;
    }
    w.events.push({ type: 'arc', points: pts, n: n + 1 });
  }

  private shock(t: Target, wp: WeaponDef, stunSec: number): void {
    const w = this.world;
    if (t.kind === 'ped') {
      const p = w.peds.peds[t.id]!;
      this.damageTarget('ped', t.id, wp.damagePed, 0, 0, true);
      if (p.state !== 'down') w.peds.stun(p, stunSec);
    } else if (t.kind === 'officer') {
      const o = w.officers.officers[t.id]!;
      this.damageTarget('officer', t.id, wp.damagePed, 0, 0, true);
      if (o.state !== 'down') w.officers.stun(o, stunSec);
    } else {
      const v = w.vehicles[t.id]!;
      this.damageTarget('vehicle', t.id, wp.damageVehicle, 0, 0, true);
      if (!v.destroyed && v !== w.player.vehicle && v.role !== 'parked') {
        v.ai.mode = 'stunned';
        v.ai.timer = stunSec;
      }
    }
  }

  private nearestVehicleInCone(x: number, z: number, facing: number, range: number, coneDeg: number): Target | null {
    const w = this.world;
    const half = (coneDeg * DEG) / 2;
    let bd = Infinity;
    let found = false;
    const out = this.tmpTarget;
    for (const v of w.vehicles) {
      if (!v.active || v.destroyed || v === w.player.vehicle) continue;
      const dx = v.x - x;
      const dz = v.z - z;
      const d = footprintDist(v, x, z);
      if (d > range || d >= bd) continue;
      if (Math.abs(wrapAngle(Math.atan2(dx, dz) - facing)) > half) continue;
      bd = d;
      found = true;
      out.kind = 'vehicle';
      out.id = v.id;
      out.x = v.x;
      out.z = v.z;
    }
    return found ? out : null;
  }

  private nearestUnvisited(x: number, z: number, range: number, n: number): Target | null {
    const w = this.world;
    let bd = range;
    let found = false;
    const out = this.tmpTarget;
    const seen = (kind: TargetKind, id: number): boolean => {
      for (let i = 0; i < n; i++) if (this.visited[i]!.kind === kind && this.visited[i]!.id === id) return true;
      return false;
    };
    const consider = (kind: TargetKind, id: number, tx: number, tz: number, d: number): void => {
      if (d >= bd || seen(kind, id)) return;
      bd = d;
      found = true;
      out.kind = kind;
      out.id = id;
      out.x = tx;
      out.z = tz;
    };
    for (const o of w.officers.officers) if (o.active && o.state !== 'down') consider('officer', o.id, o.x, o.z, Math.hypot(o.x - x, o.z - z));
    for (const p of w.peds.peds) if (p.active && p.state !== 'down') consider('ped', p.id, p.x, p.z, Math.hypot(p.x - x, p.z - z));
    for (const v of w.vehicles) {
      if (!v.active || v.destroyed || v === w.player.vehicle) continue;
      consider('vehicle', v.id, v.x, v.z, footprintDist(v, x, z));
    }
    return found ? out : null;
  }

  /**
   * An explosion: damage falls off with distance; cars are shoved, spun and
   * thrown over; people are knocked flat. `source` is a vehicle not to damage again.
   */
  explode(x: number, z: number, radius: number, dmgPed: number, dmgVehicle: number, byPlayer: boolean, source = -1): void {
    const w = this.world;
    const ex = this.config.explosion;
    w.events.push({ type: 'explosion', x, z, radius });
    for (const v of w.vehicles) {
      if (!v.active || v.id === source) continue;
      const d = footprintDist(v, x, z);
      if (d > radius) continue;
      const f = 1 - d / radius;
      const dx = v.x - x;
      const dz = v.z - z;
      const len = Math.hypot(dx, dz) || 1;
      const push = (ex.impulse * f * 1500) / v.params.mass;
      v.vx += (dx / len) * push;
      v.vz += (dz / len) * push;
      v.yawRate += ex.spin * f * (w.rng.next() < 0.5 ? -1 : 1);
      v.body?.setLinvel({ x: v.vx, y: 0, z: v.vz }, true);
      v.body?.setAngvel({ x: 0, y: v.yawRate, z: 0 }, true);
      if (f > 0.35) this.flip[v.id] = ex.flipSec;
      if (v !== w.player.vehicle) {
        if (!v.destroyed && v.role !== 'parked') {
          v.ai.mode = 'stunned';
          v.ai.timer = 1.5;
        }
        this.damageTarget('vehicle', v.id, dmgVehicle * f, 0, 0, byPlayer);
      } else w.damageVehicle(v, dmgVehicle * f * 0.6);
    }
    for (const p of w.peds.peds) {
      if (!p.active || p.state === 'down') continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > radius) continue;
      const f = 1 - d / radius;
      const len = d || 1;
      this.damageTarget('ped', p.id, dmgPed * f, ((p.x - x) / len) * 9 * f, ((p.z - z) / len) * 9 * f, byPlayer);
    }
    for (const o of w.officers.officers) {
      if (!o.active || o.state === 'down') continue;
      const d = Math.hypot(o.x - x, o.z - z);
      if (d > radius) continue;
      const f = 1 - d / radius;
      const len = d || 1;
      this.damageTarget('officer', o.id, dmgPed * f, ((o.x - x) / len) * 9 * f, ((o.z - z) / len) * 9 * f, byPlayer);
    }
    const pc = w.playerCtl;
    if (pc.mode === 'foot' && !pc.dead) {
      const d = Math.hypot(pc.x - x, pc.z - z);
      if (d < radius) pc.hurt(dmgPed * (1 - d / radius) * 0.7, -1);
    }
    w.peds.alarm(x, z, ex.pedAlarmRadius);
  }

  /** Pre-physics: grenades in flight, wrecks about to go up, flip timers. */
  preStep(dt: number): void {
    const w = this.world;
    for (let i = 0; i < this.flip.length; i++) if (this.flip[i]! > 0) this.flip[i] = Math.max(0, this.flip[i]! - dt);
    for (let i = 0; i < this.blastTimer.length; i++) {
      if (this.blastTimer[i]! < 0) continue;
      this.blastTimer[i]! -= dt;
      if (this.blastTimer[i]! > 0) continue;
      this.blastTimer[i] = -1;
      const v = w.vehicles[i]!;
      if (!v.active) continue;
      const ex = this.config.explosion;
      const blame = w.time - this.playerHitTime[i]! < BLAME_SEC;
      this.flip[i] = ex.flipSec;
      this.explode(v.x, v.z, ex.vehicleRadius, ex.vehicleDamagePed, ex.vehicleDamageVehicle, blame, v.id);
    }
    for (const p of this.projectiles) {
      if (!p.active) continue;
      const pc = this.config.weapons[p.weapon]!.projectile!;
      p.prevX = p.x;
      p.prevY = p.y;
      p.prevZ = p.z;
      p.vy -= pc.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.age += dt;
      if (this.grenadeHit(p, pc.radius) || p.age >= p.fuse) {
        p.active = false;
        const wp = this.config.weapons[p.weapon]!;
        this.explode(p.x, p.z, pc.blastRadius, wp.damagePed, wp.damageVehicle, p.byPlayer);
      }
    }
  }

  private grenadeHit(p: Projectile, r: number): boolean {
    const w = this.world;
    if (p.y <= r) {
      p.y = r;
      return true;
    }
    if (p.y < 8 && w.insideBuilding(p.x, p.z, 0)) return true;
    if (p.y > 2.2 || p.age < 0.12) return false;
    for (const v of w.vehicles) if (v.active && v !== w.player.vehicle && footprintDist(v, p.x, p.z) < r) return true;
    for (const o of w.officers.officers) if (o.active && o.state !== 'down' && Math.hypot(o.x - p.x, o.z - p.z) < 0.7) return true;
    return false;
  }

  /** Post-physics: wrecks destroyed this step go up a moment later. */
  postStep(): void {
    const w = this.world;
    for (const e of w.events) {
      if (e.type !== 'vehicleDestroyed') continue;
      if (this.blastTimer[e.vehicleId]! < 0) this.blastTimer[e.vehicleId] = 0.25;
    }
  }

  /** How long ago the player damaged a vehicle (seconds). */
  sincePlayerHit(id: number): number {
    return this.world.time - this.playerHitTime[id]!;
  }
}

/** Distance from (x, z) to a vehicle's footprint (0 inside it). */
export function footprintDist(v: Vehicle, x: number, z: number): number {
  const dx = x - v.x;
  const dz = z - v.z;
  const c = Math.cos(v.yaw);
  const s = Math.sin(v.yaw);
  const lx = Math.abs(dx * c - dz * s) - v.params.width / 2;
  const lz = Math.abs(dx * s + dz * c) - v.params.length / 2;
  return Math.hypot(Math.max(0, lx), Math.max(0, lz));
}
