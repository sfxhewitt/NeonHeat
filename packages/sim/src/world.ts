import type RAPIER_NS from '@dimforge/rapier3d-simd-compat';
import { Rng } from './rng';
import { SIM_DT } from './loop';
import type { Intents } from './intents';
import type { SimContent, VehicleParams } from './content';
import { Groups, clamp, interactionGroups, yawFromQuat, type Rapier } from './physics';
import { type ArcadeState, type DriveControls, directionToControls, emptyControls, forwardSpeed, stepArcade } from './vehicle';
import type { ImpactOther, SimEvent } from './events';
import { type AiState, makeAiState } from './ai';
import { RoadGraph } from './nav';
import { TrafficSystem } from './traffic';
import { PoliceSystem } from './police';

export type VehicleRole = 'parked' | 'player' | 'traffic' | 'police' | 'squad';

export interface Vehicle extends ArcadeState {
  id: number;
  active: boolean;
  variantId: string;
  params: VehicleParams;
  role: VehicleRole;
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  prevYaw: number;
  /** Hit points; health fraction is hp / params.maxHealth. */
  hp: number;
  destroyed: boolean;
  destroyedTime: number;
  locked: boolean;
  controls: DriveControls;
  body: RAPIER_NS.RigidBody | null;
  collider: RAPIER_NS.Collider | null;
  /** Velocity we asked physics for, used to measure impacts. */
  setVx: number;
  setVz: number;
  /** Seconds since the last impact this vehicle took. */
  sinceImpact: number;
  ai: AiState;
}

export interface PlayerState {
  vehicle: Vehicle | null;
  /** Interpolation-free current position and velocity, whatever the player is in. */
  x: number;
  z: number;
  vx: number;
  vz: number;
}

export interface WorldOptions {
  seed: number;
  content: SimContent;
  rapier: Rapier;
  /** Size of the vehicle pool. */
  maxVehicles?: number;
}

interface ColliderOwner {
  kind: ImpactOther;
  id: number;
}

/**
 * The deterministic simulation world. Pure TypeScript: no Three.js, no DOM.
 * Rendering reads its state; it never owns it.
 */
export class World {
  readonly rng: Rng;
  readonly seed: number;
  readonly content: SimContent;
  readonly R: Rapier;
  readonly physics: RAPIER_NS.World;
  tick = 0;
  time = 0;
  readonly vehicles: Vehicle[] = [];
  readonly events: SimEvent[] = [];
  readonly player: PlayerState = { vehicle: null, x: 0, z: 0, vx: 0, vz: 0 };
  readonly roads: RoadGraph;
  readonly traffic: TrafficSystem;
  readonly police: PoliceSystem;
  private readonly owners = new Map<number, ColliderOwner>();
  private readonly ctl = emptyControls();

  constructor(options: WorldOptions) {
    this.seed = options.seed;
    this.rng = new Rng(options.seed);
    this.content = options.content;
    this.R = options.rapier;
    this.physics = new this.R.World({ x: 0, y: 0, z: 0 });
    this.physics.timestep = SIM_DT;
    const pool = options.maxVehicles ?? 40;
    for (let i = 0; i < pool; i++) this.vehicles.push(makeVehicle(i, this.content.vehicles.variants[this.content.vehicles.player]!));
    this.roads = new RoadGraph(this.content.map);
    this.traffic = new TrafficSystem(this, this.content.traffic);
    this.police = new PoliceSystem(this, this.content.heat);
    this.buildStatics();
    this.spawnInitial();
    this.syncPlayer();
    this.traffic.populate();
  }

  get heat(): PoliceSystem['heat'] {
    return this.police.heat;
  }

  distToPlayer(x: number, z: number): number {
    return Math.hypot(x - this.player.x, z - this.player.z);
  }

  private syncPlayer(): void {
    const p = this.player;
    const v = p.vehicle;
    if (v) {
      p.x = v.x;
      p.z = v.z;
      p.vx = v.vx;
      p.vz = v.vz;
    }
  }

  /**
   * Distance to the nearest obstacle in `v`'s lane ahead (bumper to bumper),
   * or Infinity. Used for car-following.
   */
  gapAhead(v: Vehicle, range: number, laneHalfWidth: number): number {
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    let best = Infinity;
    const half = v.params.length / 2;
    for (const o of this.vehicles) {
      if (!o.active || o === v) continue;
      const dx = o.x - v.x;
      const dz = o.z - v.z;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 0 || ahead > range) continue;
      const lat = Math.abs(dx * fz - dz * fx);
      if (lat > laneHalfWidth + o.params.width / 2) continue;
      const gap = ahead - half - o.params.length / 2;
      if (gap < best) best = gap;
    }
    return best;
  }

  private buildStatics(): void {
    const { R, physics } = this;
    const map = this.content.map;
    const groups = interactionGroups(Groups.static, 0xffff);
    for (const b of map.buildings) {
      const c = physics.createCollider(
        R.ColliderDesc.cuboid(b.w / 2, b.h / 2, b.d / 2).setTranslation(b.x, b.h / 2, b.z).setCollisionGroups(groups).setFriction(0.1),
      );
      this.owners.set(c.handle, { kind: 'static', id: -1 });
    }
    const [sx, sz] = map.size;
    const t = map.wallThickness;
    const walls: [number, number, number, number][] = [
      [0, -sz / 2 - t / 2, sx / 2 + t, t / 2],
      [0, sz / 2 + t / 2, sx / 2 + t, t / 2],
      [-sx / 2 - t / 2, 0, t / 2, sz / 2 + t],
      [sx / 2 + t / 2, 0, t / 2, sz / 2 + t],
    ];
    for (const [x, z, hx, hz] of walls) {
      const c = physics.createCollider(
        R.ColliderDesc.cuboid(hx, 4, hz).setTranslation(x, 4, z).setCollisionGroups(groups).setFriction(0.1),
      );
      this.owners.set(c.handle, { kind: 'static', id: -1 });
    }
  }

  private spawnInitial(): void {
    for (const s of Object.values(this.content.map.spawns)) {
      if (s.variant === 'prototype') continue; // mission vehicles are spawned by missions
      const v = this.spawnVehicle(s.variant, s.pos[0], s.pos[2], s.yaw, 'parked');
      if (v) v.locked = s.locked;
    }
    const start = this.content.map.spawns['starter_car'];
    const car = start ? this.vehicles.find((v) => v.active && v.x === start.pos[0] && v.z === start.pos[2]) : undefined;
    if (car) this.setPlayerVehicle(car);
  }

  setPlayerVehicle(v: Vehicle | null): void {
    if (this.player.vehicle) this.player.vehicle.role = 'parked';
    this.player.vehicle = v;
    if (v) {
      v.role = 'player';
      v.body?.enableCcd(true);
    }
  }

  spawnVehicle(variantId: string, x: number, z: number, yaw: number, role: VehicleRole): Vehicle | null {
    const params = this.content.vehicles.variants[variantId];
    if (!params) throw new Error(`Unknown vehicle variant "${variantId}"`);
    const v = this.vehicles.find((c) => !c.active);
    if (!v) return null;
    const { R, physics } = this;
    resetVehicle(v, variantId, params, role, x, z, yaw);
    const body = physics.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(x, 0, z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .enabledTranslations(true, false, true)
        .enabledRotations(false, true, false)
        .setLinearDamping(0)
        .setAngularDamping(0)
        .setCanSleep(false),
    );
    const collider = physics.createCollider(
      R.ColliderDesc.cuboid(params.width / 2, params.height / 2, params.length / 2)
        .setTranslation(0, params.height / 2, 0)
        .setMass(params.mass)
        .setFriction(0.15)
        .setRestitution(0.2)
        .setCollisionGroups(interactionGroups(Groups.vehicle, Groups.static | Groups.vehicle | Groups.ped | Groups.player)),
      body,
    );
    v.body = body;
    v.collider = collider;
    this.owners.set(collider.handle, { kind: 'vehicle', id: v.id });
    return v;
  }

  despawnVehicle(v: Vehicle): void {
    if (!v.active) return;
    if (this.player.vehicle === v) this.player.vehicle = null;
    if (v.collider) this.owners.delete(v.collider.handle);
    if (v.body) this.physics.removeRigidBody(v.body);
    v.body = null;
    v.collider = null;
    v.active = false;
  }

  vehicleHealth(v: Vehicle): number {
    return clamp(v.hp / v.params.maxHealth, 0, 1);
  }

  step(intents: Intents): void {
    this.events.length = 0;
    const player = this.player.vehicle;
    this.traffic.step(SIM_DT);
    this.police.step(SIM_DT);
    for (const v of this.vehicles) {
      if (!v.active) continue;
      v.prevX = v.x;
      v.prevZ = v.z;
      v.prevYaw = v.yaw;
      const c = v.controls;
      if (v === player && !v.destroyed) {
        if (intents.scheme === 'direction') directionToControls(v, intents.moveX, intents.moveY, c);
        else {
          c.steer = intents.steer;
          c.throttle = intents.throttle;
          c.brake = intents.brake;
        }
        c.handbrake = intents.handbrake;
      } else if (v.role === 'parked' || v.destroyed) {
        c.steer = 0;
        c.throttle = 0;
        c.brake = 1;
        c.handbrake = true;
      }
      stepArcade(v, v.params, c, SIM_DT);
      v.setVx = v.vx;
      v.setVz = v.vz;
      v.body?.setLinvel({ x: v.vx, y: 0, z: v.vz }, true);
      v.body?.setAngvel({ x: 0, y: v.yawRate, z: 0 }, true);
    }

    this.physics.step();

    for (const v of this.vehicles) {
      if (!v.active || !v.body) continue;
      const t = v.body.translation();
      const r = v.body.rotation();
      const lv = v.body.linvel();
      const av = v.body.angvel();
      v.x = t.x;
      v.z = t.z;
      v.yaw = yawFromQuat(r);
      v.vx = lv.x;
      v.vz = lv.z;
      v.yawRate = av.y;
      v.sinceImpact += SIM_DT;
      this.detectImpact(v);
    }
    this.syncPlayer();
    this.police.postStep(SIM_DT);
    this.handlePlayerWreck();
    this.tick++;
    this.time = this.tick * SIM_DT;
  }

  private detectImpact(v: Vehicle): void {
    const dvx = v.vx - v.setVx;
    const dvz = v.vz - v.setVz;
    const dv = Math.hypot(dvx, dvz);
    const dmg = this.content.vehicles.damage;
    if (dv < 1.5 || !v.collider) return;
    let other: ColliderOwner | undefined;
    this.physics.contactPairsWith(v.collider, (c) => {
      other ??= this.owners.get(c.handle);
    });
    if (!other) return;
    if (dv > dmg.impactThreshold && !v.destroyed) {
      v.hp -= ((dv - dmg.impactThreshold) * dmg.damagePerMs) / v.params.armour;
      if (v.hp <= 0) {
        v.hp = 0;
        v.destroyed = true;
        v.destroyedTime = this.time;
        this.events.push({ type: 'vehicleDestroyed', vehicleId: v.id, x: v.x, z: v.z });
      }
    }
    if (v.sinceImpact < 0.12) return; // debounce continuous scraping
    v.sinceImpact = 0;
    if (v.role === 'traffic' && dv > 6 && !v.destroyed) {
      v.ai.mode = 'stunned';
      v.ai.timer = 1.2;
    } else if ((v.role === 'police' || v.role === 'squad') && dv > 11 && !v.destroyed && v.ai.mode !== 'leave') {
      v.ai.mode = 'stunned';
      v.ai.timer = 0.7;
    }
    if (v === this.player.vehicle && other.kind === 'vehicle') this.playerHitVehicle(v, this.vehicles[other.id]!, dv);
    const inv = 1 / dv;
    const half = v.params.width / 2;
    const isPlayer = v === this.player.vehicle || (other.kind === 'vehicle' && this.vehicles[other.id] === this.player.vehicle);
    this.events.push({
      type: 'impact',
      x: v.x - dvx * inv * half,
      z: v.z - dvz * inv * half,
      strength: dv,
      vehicleId: v.id,
      other: other.kind,
      otherId: other.id,
      involvesPlayer: isPlayer,
    });
  }

  /** Crimes from the player's car hitting another vehicle. */
  private playerHitVehicle(pv: Vehicle, o: Vehicle, strength: number): void {
    const heat = this.heat;
    const dx = o.x - pv.x;
    const dz = o.z - pv.z;
    const len = Math.hypot(dx, dz) || 1;
    // Who was the aggressor? Compare approach speeds before the contact resolved.
    const mine = (pv.setVx * dx + pv.setVz * dz) / len;
    const theirs = -(o.setVx * dx + o.setVz * dz) / len;
    const rammed = mine > 3 && mine > theirs;
    if (!rammed) return;
    if (o.role === 'police' && strength > heat.config.ramMinStrength) heat.addPoints(heat.config.points.ramPolice, pv.x, pv.z);
    else if (o.role === 'traffic' || o.role === 'parked') heat.civCarHit(this.time, pv.x, pv.z);
  }

  /** M3: a wrecked player car respawns at the start after a pause. */
  private handlePlayerWreck(): void {
    const v = this.player.vehicle;
    if (!v || !v.destroyed) return;
    if (this.time - v.destroyedTime < this.content.vehicles.damage.destroyedEjectSec + 1.5) return;
    const start = this.content.map.spawns['starter_car'];
    this.setPlayerVehicle(null);
    v.role = 'parked';
    if (start) {
      const nv = this.spawnVehicle(start.variant, start.pos[0], start.pos[2], start.yaw, 'player');
      this.setPlayerVehicle(nv);
    }
    this.heat.clear();
    this.syncPlayer();
  }

  /** Speed of the player's vehicle along its heading, m/s. */
  playerSpeed(): number {
    const v = this.player.vehicle;
    return v ? forwardSpeed(v) : 0;
  }

  /** A compact, exact fingerprint of dynamic state, for determinism tests. */
  stateHash(): string {
    const parts: number[] = [this.tick];
    for (const v of this.vehicles) {
      if (!v.active) continue;
      parts.push(v.id, v.x, v.z, v.yaw, v.vx, v.vz, v.hp);
    }
    parts.push(this.heat.level, this.heat.points, this.police.drone.x, this.police.drone.z);
    return parts.join(',');
  }

  dispose(): void {
    this.physics.free();
  }
}

function makeVehicle(id: number, params: VehicleParams): Vehicle {
  return {
    id,
    active: false,
    variantId: '',
    params,
    role: 'parked',
    x: 0,
    z: 0,
    prevX: 0,
    prevZ: 0,
    yaw: 0,
    prevYaw: 0,
    vx: 0,
    vz: 0,
    yawRate: 0,
    drifting: false,
    hp: 0,
    destroyed: false,
    destroyedTime: 0,
    locked: false,
    controls: emptyControls(),
    body: null,
    collider: null,
    setVx: 0,
    setVz: 0,
    sinceImpact: 10,
    ai: makeAiState(),
  };
}

function resetVehicle(v: Vehicle, variantId: string, params: VehicleParams, role: VehicleRole, x: number, z: number, yaw: number): void {
  v.active = true;
  v.variantId = variantId;
  v.params = params;
  v.role = role;
  v.x = v.prevX = x;
  v.z = v.prevZ = z;
  v.yaw = v.prevYaw = yaw;
  v.vx = v.vz = v.yawRate = 0;
  v.drifting = false;
  v.hp = params.maxHealth;
  v.destroyed = false;
  v.destroyedTime = 0;
  v.locked = false;
  v.setVx = v.setVz = 0;
  v.sinceImpact = 10;
  const c = v.controls;
  c.steer = c.throttle = c.brake = 0;
  c.handbrake = false;
}
