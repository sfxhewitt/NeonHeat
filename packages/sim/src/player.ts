import type RAPIER_NS from '@dimforge/rapier3d-simd-compat';
import type { Intents } from './intents';
import { Groups, clamp, interactionGroups } from './physics';
import { forwardSpeed } from './vehicle';
import type { Vehicle, World } from './world';

export type PlayerMode = 'foot' | 'driving';

export type ContextKind = 'steal' | 'enter' | 'exit' | 'hack' | 'locked' | 'interact';

export interface ContextAction {
  kind: ContextKind;
  /** Player-facing label for the context button. */
  label: string;
  vehicleId: number;
  interactableId: string;
}

/** Something a mission placed in the world that the context button can use. */
export interface Interactable {
  id: string;
  x: number;
  z: number;
  radius: number;
  label: string;
}

const FOOT_GROUPS = interactionGroups(Groups.player, Groups.static | Groups.vehicle | Groups.ped);
const NO_GROUPS = interactionGroups(Groups.ghost, 0);

/**
 * The player: on foot (floating-stick movement, dodge roll, weapons through
 * the combat system) or driving (drive-bys). Owns entering, stealing and
 * leaving vehicles, health and armour.
 */
export class PlayerController {
  mode: PlayerMode = 'foot';
  x = 0;
  z = 0;
  prevX = 0;
  prevZ = 0;
  vx = 0;
  vz = 0;
  facing = Math.PI;
  prevFacing = Math.PI;
  hp: number;
  /** Body armour: soaks damage before health does. */
  armour: number;
  dead = false;
  deadTime = 0;
  /** Cuffed: frozen until the respawn at the precinct. */
  busted = false;
  dodgeTime = 0;
  dodgeCooldown = 0;
  context: ContextAction | null = null;
  body: RAPIER_NS.RigidBody;
  collider: RAPIER_NS.Collider;
  private readonly ctx: ContextAction = { kind: 'exit', label: '', vehicleId: -1, interactableId: '' };

  constructor(
    private readonly world: World,
    x: number,
    z: number,
  ) {
    const cfg = world.content.peds.player;
    this.hp = cfg.maxHealth;
    this.armour = world.content.survival.player.startArmour;
    const { R, physics } = world;
    this.body = physics.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(x, 0, z).enabledTranslations(true, false, true).lockRotations().setCanSleep(false).setCcdEnabled(true),
    );
    this.collider = physics.createCollider(
      R.ColliderDesc.ball(cfg.radius).setTranslation(0, cfg.radius, 0).setMass(cfg.mass).setFriction(0).setCollisionGroups(FOOT_GROUPS),
      this.body,
    );
    world.registerCollider(this.collider, 'player', 0);
    this.x = this.prevX = x;
    this.z = this.prevZ = z;
  }

  get maxHp(): number {
    return this.world.content.peds.player.maxHealth;
  }

  /** Armour capacity: the survival base plus Plating cyberware. */
  get maxArmour(): number {
    return this.world.content.survival.player.maxArmour + this.world.economy.armourBonus;
  }

  /** Flatlined or booked: no control until the respawn. */
  get incapacitated(): boolean {
    return this.dead || this.busted;
  }

  get vehicle(): Vehicle | null {
    return this.world.player.vehicle;
  }

  /** Put the player in a vehicle (ejecting any AI driver). */
  enter(v: Vehicle): void {
    const w = this.world;
    if (v.role === 'traffic' || v.role === 'police' || v.role === 'squad' || v.role === 'service') {
      // Carjacking: the driver is thrown out and runs.
      const side = this.sidePoint(v, 1);
      const ped = w.peds.spawnPedAt(side.x, side.z);
      if (ped) {
        ped.state = 'flee';
        ped.timer = 6;
        ped.threatX = v.x;
        ped.threatZ = v.z;
      }
      w.police.crime(v.role === 'police' ? 'carjackPolice' : 'carjack', w.player.x, w.player.z);
    }
    this.mode = 'driving';
    this.collider.setCollisionGroups(NO_GROUPS);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    w.setPlayerVehicle(v);
    v.ai.mode = 'idle';
    this.dodgeTime = 0;
    w.police.onPlayerEnteredVehicle(v);
    w.events.push({ type: 'enteredVehicle', x: v.x, z: v.z, vehicleId: v.id, amount: 0 });
  }

  /** Leave the current vehicle on the driver's side (or the other side if blocked). */
  exit(): void {
    const w = this.world;
    const v = w.player.vehicle;
    if (!v) return;
    let p = this.sidePoint(v, 1);
    if (w.insideBuilding(p.x, p.z, 0.6) || !this.clearOfVehicles(p.x, p.z, v)) p = this.sidePoint(v, -1);
    if (w.insideBuilding(p.x, p.z, 0.6)) p = { x: v.x - Math.sin(v.yaw) * (v.params.length / 2 + 1), z: v.z - Math.cos(v.yaw) * (v.params.length / 2 + 1) };
    w.setPlayerVehicle(null);
    v.role = 'parked';
    this.mode = 'foot';
    this.teleport(p.x, p.z);
    this.facing = this.prevFacing = v.yaw;
    this.collider.setCollisionGroups(FOOT_GROUPS);
    w.events.push({ type: 'exitedVehicle', x: p.x, z: p.z, vehicleId: v.id, amount: 0 });
  }

  teleport(x: number, z: number): void {
    this.body.setTranslation({ x, y: 0, z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.x = this.prevX = x;
    this.z = this.prevZ = z;
    this.vx = this.vz = 0;
  }

  private sidePoint(v: Vehicle, side: 1 | -1): { x: number; z: number } {
    // Local +X is the car's left (driver's side).
    const off = (v.params.width / 2 + 1.0) * side;
    return { x: v.x + Math.cos(v.yaw) * off, z: v.z - Math.sin(v.yaw) * off };
  }

  private clearOfVehicles(x: number, z: number, except: Vehicle): boolean {
    for (const o of this.world.vehicles) {
      if (!o.active || o === except) continue;
      if (Math.hypot(o.x - x, o.z - z) < Math.max(o.params.length, o.params.width) / 2 + 0.6) return false;
    }
    return true;
  }

  /** Work out what the context button would do right now. */
  updateContext(): void {
    const w = this.world;
    const c = this.ctx;
    this.context = null;
    if (this.incapacitated) return;
    if (this.mode === 'driving') {
      const v = w.player.vehicle;
      if (v && Math.abs(forwardSpeed(v)) <= w.content.peds.player.exitMaxSpeed) {
        c.kind = 'exit';
        c.label = 'EXIT';
        c.vehicleId = v.id;
        this.context = c;
      }
      return;
    }
    for (const it of w.interactables) {
      if (Math.hypot(it.x - this.x, it.z - this.z) <= it.radius) {
        c.kind = 'interact';
        c.label = it.label;
        c.interactableId = it.id;
        c.vehicleId = -1;
        this.context = c;
        return;
      }
    }
    const v = this.nearestVehicle();
    if (!v) return;
    c.vehicleId = v.id;
    c.interactableId = '';
    if (v.hackable) {
      c.kind = 'hack';
      c.label = 'HACK';
    } else if (v.locked) {
      c.kind = 'locked';
      c.label = 'LOCKED';
    } else if (v.role === 'parked') {
      c.kind = 'enter';
      c.label = 'ENTER';
    } else {
      c.kind = 'steal';
      c.label = 'STEAL';
    }
    this.context = c;
  }

  private nearestVehicle(): Vehicle | null {
    const range = this.world.content.peds.player.enterRange;
    let best: Vehicle | null = null;
    let bd = Infinity;
    for (const v of this.world.vehicles) {
      if (!v.active || v.destroyed) continue;
      // Distance to the car's footprint, not its centre.
      const dx = this.x - v.x;
      const dz = this.z - v.z;
      const lx = Math.abs(dx * Math.cos(v.yaw) - dz * Math.sin(v.yaw)) - v.params.width / 2;
      const lz = Math.abs(dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw)) - v.params.length / 2;
      const d = Math.hypot(Math.max(0, lx), Math.max(0, lz));
      if (d < range && d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  /** Pre-physics: context action, movement, dodge and firing. */
  preStep(intents: Intents, dt: number): void {
    const w = this.world;
    const cfg = w.content.peds.player;
    this.prevX = this.x;
    this.prevZ = this.z;
    this.prevFacing = this.facing;
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);

    if (this.incapacitated) {
      // The survival system respawns the player after the fate card.
      this.vx = this.vz = 0;
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }

    this.updateContext();
    if (intents.interact && this.context) {
      const c = this.context;
      if (c.kind === 'exit') this.exit();
      else if (c.kind === 'enter' || c.kind === 'steal') this.enter(w.vehicles[c.vehicleId]!);
      else if (c.kind === 'hack') w.events.push({ type: 'hackRequested', vehicleId: c.vehicleId });
      else if (c.kind === 'interact') w.events.push({ type: 'interact', id: c.interactableId });
      this.updateContext();
    }

    if (this.mode === 'driving') {
      const v = w.player.vehicle;
      if (v) {
        this.body.setTranslation({ x: v.x, y: -5, z: v.z }, false);
        this.x = this.prevX = v.x;
        this.z = this.prevZ = v.z;
        this.facing = this.prevFacing = v.yaw;
        w.combat.driveStep(intents, v, dt);
      }
      return;
    }

    // Floating stick: magnitude sets speed, direction is world space (stick up = north).
    const mx = clamp(intents.moveX, -1, 1);
    const my = clamp(intents.moveY, -1, 1);
    const mag = Math.min(1, Math.hypot(mx, my));
    let dirX = mag > 0.12 ? mx / mag : 0;
    let dirZ = mag > 0.12 ? -my / mag : 0;

    if (intents.dodge && this.dodgeCooldown <= 0 && this.dodgeTime <= 0) {
      if (dirX === 0 && dirZ === 0) {
        dirX = Math.sin(this.facing);
        dirZ = Math.cos(this.facing);
      }
      this.dodgeTime = cfg.dodgeSec;
      this.dodgeCooldown = cfg.dodgeSec + cfg.dodgeCooldownSec;
      this.vx = dirX * cfg.dodgeSpeed;
      this.vz = dirZ * cfg.dodgeSpeed;
      this.facing = Math.atan2(dirX, dirZ);
      w.events.push({ type: 'dodge', x: this.x, z: this.z, vehicleId: -1, amount: 0 });
      w.economy.onDodge();
    }

    if (this.dodgeTime > 0) {
      this.dodgeTime -= dt;
    } else {
      const speed = mag > 0.12 ? cfg.moveSpeed * Math.min(1, (mag - 0.12) / 0.6 + 0.35) : 0;
      this.vx = dirX * speed;
      this.vz = dirZ * speed;
      // Turn quickly but not instantly, so the body swings round rather than snapping.
      if (speed > 0) {
        const want = Math.atan2(dirX, dirZ);
        const d = Math.atan2(Math.sin(want - this.facing), Math.cos(want - this.facing));
        const maxTurn = 16 * dt;
        this.facing += Math.max(-maxTurn, Math.min(maxTurn, d));
      }
    }

    // Weapons: soft-lock, switching and firing live in the combat system; it turns us to face the target.
    const turn = w.combat.footStep(intents, this.x, this.z, this.facing, dt, this.dodgeTime <= 0);
    if (turn !== null && this.dodgeTime <= 0) this.facing = turn;
    this.body.setLinvel({ x: this.vx, y: 0, z: this.vz }, true);
  }

  /** Post-physics: read back position and check for being run over. */
  postStep(): void {
    const w = this.world;
    if (this.mode === 'driving') return;
    const t = this.body.translation();
    this.x = t.x;
    this.z = t.z;
    if (this.incapacitated || this.dodgeTime > 0) return;
    const cfg = w.content.peds.player;
    let hitBy: Vehicle | null = null;
    w.physics.contactPairsWith(this.collider, (c) => {
      const o = w.colliderOwner(c.handle);
      if (o?.kind === 'vehicle') hitBy = w.vehicles[o.id]!;
    });
    const v = hitBy as Vehicle | null;
    if (!v) return;
    const rel = Math.hypot(v.setVx - this.vx, v.setVz - this.vz);
    if (rel < cfg.hitMinSpeed) return;
    // Police drivers brake for you: a clip from a patrol car hurts far less than being run down.
    const mul = v.role === 'police' ? w.content.heat.footHitMul : 1;
    const dmg = (rel - cfg.hitMinSpeed) * cfg.hitDamagePerMs * mul;
    this.hurt(dmg, v.id);
    this.body.setLinvel({ x: v.setVx * 0.8, y: 0, z: v.setVz * 0.8 }, true);
  }

  /** Take damage: armour soaks its share first. */
  hurt(amount: number, by: number): void {
    if (this.incapacitated || amount <= 0) return;
    const w = this.world;
    // Reflex cyberware: untouchable for a moment from the start of a dodge.
    if (w.economy.invulnerable) return;
    const soak = Math.min(this.armour, amount * w.content.survival.player.armourAbsorb);
    this.armour -= soak;
    this.hp = Math.max(0, this.hp - (amount - soak));
    w.events.push({ type: 'playerHurt', x: this.x, z: this.z, vehicleId: by, amount });
    if (this.hp <= 0) {
      this.dead = true;
      this.deadTime = w.time;
      w.events.push({ type: 'playerDied', x: this.x, z: this.z, vehicleId: by, amount: 0 });
      w.survival.flatline();
    }
  }

  /** Respawn now (mission checkpoints call this after a death). */
  respawn(): void {
    if (!this.world.survival.alive) this.world.survival.respawn();
    else this.respawnAt(this.world.content.survival.flatlined.marker);
  }

  /** Back on your feet at the nearest marker whose id starts with `prefix` (or at `spot`), HEAT cleared. */
  respawnAt(prefix: string, spot?: { x: number; z: number } | null): void {
    const w = this.world;
    if (this.mode === 'driving') this.exit();
    const at = spot ?? w.survival.nearestMarker(prefix, this.x, this.z);
    this.dead = false;
    this.busted = false;
    this.hp = this.maxHp;
    this.armour = w.content.survival.player.startArmour;
    this.dodgeTime = 0;
    this.teleport(at.x, at.z);
    this.collider.setCollisionGroups(FOOT_GROUPS);
    w.police.clearHeat('clear');
    w.events.push({ type: 'playerRespawned', x: this.x, z: this.z, vehicleId: -1, amount: 0 });
  }
}
