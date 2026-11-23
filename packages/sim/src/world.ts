import { WeatherSystem } from './weather';
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
import { PedSystem } from './peds';
import { PropSystem } from './props';
import { Cell, cityGrid, kerbAngle, onPavement } from './street';
import { PlayerController, type Interactable } from './player';
import { ActorSystem } from './actors';
import { CombatSystem } from './combat';
import { OfficerSystem } from './officers';
import { PickupSystem } from './pickups';
import { ScoreSystem } from './score';
import { SurvivalSystem } from './survival';
import { EconomySystem } from './economy';
import { ServicesSystem } from './services';
import { GangSystem } from './gangs';
import { CrowdSystem } from './crowds';
import { ActivitySystem } from './activities';
import { VEHICLE_GROUND_GROUPS } from './activities/jumps';

/**
 * `mission`: driven by a mission actor (see actors.ts); traffic and police leave it alone.
 * `service`: an ambulance or fire tender on a call (see services.ts).
 */
export type VehicleRole = 'parked' | 'player' | 'traffic' | 'police' | 'squad' | 'mission' | 'service';

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
  /** A mission has made this vehicle hackable: the context button offers HACK. */
  hackable: boolean;
  /** Map and mission vehicles are never recycled; abandoned stolen cars are. */
  persistent: boolean;
  /** Seconds this car has sat abandoned out of the player's range. */
  abandonedTime: number;
  controls: DriveControls;
  body: RAPIER_NS.RigidBody | null;
  collider: RAPIER_NS.Collider | null;
  /** Velocity we asked physics for, used to measure impacts. */
  setVx: number;
  setVz: number;
  /** Seconds since the last impact this vehicle took. */
  sinceImpact: number;
  /** Front and rear axles up on the pavement (the renderer lifts and pitches the body). */
  kerbFront: boolean;
  kerbRear: boolean;
  /** Seed for this car's paint (`paintFor`); a respray changes it. */
  paintSeed: number;
  /** Beacons flashing (emergency vehicles on a call; police show theirs whenever they are out). */
  beacons: boolean;
  /** Siren sounding: traffic ahead pulls over. */
  siren: boolean;
  /** Height above the road (stunt ramps and jumps) and vertical speed. */
  y: number;
  prevY: number;
  vy: number;
  /** Off the ground: no steering, no grip. */
  airborne: boolean;
  /** High enough to pass over traffic and people (collision groups switched). */
  airHigh: boolean;
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
  /** TRACE: 0-100 % net trace. Phase 0 only raises it from failed hacks. */
  trace = 0;
  readonly vehicles: Vehicle[] = [];
  readonly events: SimEvent[] = [];
  readonly player: PlayerState = { vehicle: null, x: 0, z: 0, vx: 0, vz: 0 };
  readonly roads: RoadGraph;
  readonly traffic: TrafficSystem;
  readonly weather: WeatherSystem;
  readonly police: PoliceSystem;
  readonly peds: PedSystem;
  readonly props: PropSystem;
  /** Mission actors: scripted people and drivers. */
  readonly actors: ActorSystem;
  /** The on-foot player and the enter/exit/fire logic. */
  readonly playerCtl: PlayerController;
  /** Mission-placed things the context button can use. */
  readonly interactables: Interactable[] = [];
  /** Combat layer: weapons and damage, police on foot, pickups, street score, FLATLINED/BOOKED. */
  readonly combat: CombatSystem;
  readonly officers: OfficerSystem;
  readonly pickups: PickupSystem;
  readonly score: ScoreSystem;
  readonly survival: SurvivalSystem;
  /** Shops, resprays, safehouses, cyberware and the export list. */
  readonly economy: EconomySystem;
  /** Living city: ambulances and fire tenders, street crews, crowds. */
  readonly services: ServicesSystem;
  readonly gangs: GangSystem;
  readonly crowds: CrowdSystem;
  /** Side activities: rampages, stunt jumps, data shards, fares, street races. */
  readonly activities: ActivitySystem;
  private readonly owners = new Map<number, ColliderOwner>();
  private readonly ctl = emptyControls();
  /** Counts spawns, so each new car rolls its own paint without drawing from the RNG. */
  private spawnSerial = 0;

  constructor(options: WorldOptions) {
    this.seed = options.seed;
    this.rng = new Rng(options.seed);
    this.content = options.content;
    this.R = options.rapier;
    this.physics = new this.R.World({ x: 0, y: 0, z: 0 });
    this.physics.timestep = SIM_DT;
    const pool = options.maxVehicles ?? 96;
    for (let i = 0; i < pool; i++) this.vehicles.push(makeVehicle(i, this.content.vehicles.variants[this.content.vehicles.player]!));
    this.roads = new RoadGraph(this.content.map);
    this.traffic = new TrafficSystem(this, this.content.traffic);
    this.weather = new WeatherSystem(this.content.weather, this.rng);
    this.police = new PoliceSystem(this, this.content.heat);
    this.peds = new PedSystem(this, this.content.peds);
    this.actors = new ActorSystem(this);
    this.services = new ServicesSystem(this);
    this.gangs = new GangSystem(this);
    this.crowds = new CrowdSystem(this);
    this.buildStatics();
    this.props = new PropSystem(this, this.content.props);
    const start = this.content.map.markers['player_start']?.pos ?? [0, 0, 0];
    this.playerCtl = new PlayerController(this, start[0], start[2]);
    this.score = new ScoreSystem(this);
    this.survival = new SurvivalSystem(this, this.content.survival);
    this.officers = new OfficerSystem(this, this.content.heat.officers);
    this.combat = new CombatSystem(this, this.content.weapons);
    this.pickups = new PickupSystem(this, this.content.pickups);
    this.economy = new EconomySystem(this, this.content.economy);
    this.activities = new ActivitySystem(this, this.content.activities);
    this.spawnInitial();
    this.syncPlayer();
    this.traffic.populate();
    this.peds.populate();
  }

  registerCollider(c: RAPIER_NS.Collider, kind: ImpactOther, id: number): void {
    this.owners.set(c.handle, { kind, id });
  }

  unregisterCollider(c: RAPIER_NS.Collider): void {
    this.owners.delete(c.handle);
  }

  colliderOwner(handle: number): ColliderOwner | undefined {
    return this.owners.get(handle);
  }

  /** True if (x, z) is inside (or within `margin` of) a building footprint. */
  insideBuilding(x: number, z: number, margin = 0): boolean {
    const g = cityGrid(this.content.map);
    const solid = Cell.building | Cell.water;
    if (g.at(x, z) & solid) return true;
    if (margin <= 0) return false;
    return ((g.at(x - margin, z - margin) | g.at(x + margin, z - margin) | g.at(x - margin, z + margin) | g.at(x + margin, z + margin)) & solid) !== 0;
  }

  addTrace(v: number): void {
    this.trace = clamp(this.trace + v, 0, 100);
  }

  /** Move a vehicle instantly (checkpoints), stopping it. */
  teleportVehicle(v: Vehicle, x: number, z: number, yaw: number): void {
    v.x = v.prevX = x;
    v.z = v.prevZ = z;
    v.yaw = v.prevYaw = yaw;
    v.vx = v.vz = v.yawRate = 0;
    v.y = v.prevY = v.vy = 0;
    v.airborne = false;
    v.body?.setTranslation({ x, y: 0, z }, true);
    v.body?.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    v.body?.setLinvel({ x: 0, y: 0, z: 0 }, true);
    v.body?.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.settleKerbs(v);
  }

  /** Match the kerb flags to where the car now stands, so a teleport or spawn makes no bump. */
  private settleKerbs(v: Vehicle): void {
    const axle = v.params.length * 0.32;
    const fx = Math.sin(v.yaw) * axle;
    const fz = Math.cos(v.yaw) * axle;
    v.kerbFront = onPavement(this.content.map, v.x + fx, v.z + fz);
    v.kerbRear = onPavement(this.content.map, v.x - fx, v.z - fz);
  }

  /** Apply damage to a vehicle; handles the destroyed transition. */
  damageVehicle(v: Vehicle, amount: number): void {
    if (v.destroyed || amount <= 0) return;
    v.hp -= amount;
    if (v.hp <= 0) {
      v.hp = 0;
      v.destroyed = true;
      v.destroyedTime = this.time;
      this.events.push({ type: 'vehicleDestroyed', vehicleId: v.id, x: v.x, z: v.z });
    }
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
    } else {
      const c = this.playerCtl;
      p.x = c.x;
      p.z = c.z;
      p.vx = c.vx;
      p.vz = c.vz;
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
      // A parked car is passed if the bodies clear (a brush is fine); moving cars use the lane width.
      const parked = o.role === 'parked' && Math.abs(o.vx) + Math.abs(o.vz) < 0.5;
      if (lat > (parked ? v.params.width / 2 + o.params.width / 2 - 0.15 : laneHalfWidth + o.params.width / 2)) continue;
      const gap = ahead - half - o.params.length / 2;
      if (gap < best) best = gap;
    }
    const consider = (x: number, z: number): void => {
      const dx = x - v.x;
      const dz = z - v.z;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 0 || ahead > range) return;
      if (Math.abs(dx * fz - dz * fx) > laneHalfWidth + 0.5) return;
      const gap = ahead - half - 0.5;
      if (gap < best) best = gap;
    };
    for (const p of this.peds.peds) if (p.active && p.state !== 'down') consider(p.x, p.z);
    if (!this.player.vehicle && !this.playerCtl.dead) consider(this.playerCtl.x, this.playerCtl.z);
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
    // The river: cars and people stop at the bank (bridges are gaps between the water slabs).
    for (const wtr of map.water) walls.push([wtr.x, wtr.z, wtr.w / 2, wtr.d / 2]);
    // Bridge railings.
    for (const sg of map.roads.segments) {
      if (sg.kind !== 'bridge') continue;
      const hw = sg.width / 2 + 0.3;
      const cz = (sg.z0 + sg.z1) / 2;
      const hz = (sg.z1 - sg.z0) / 2 + 4;
      walls.push([sg.x0 - hw, cz, 0.3, hz], [sg.x0 + hw, cz, 0.3, hz]);
    }
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
      if (v) {
        v.locked = s.locked;
        v.persistent = true;
      }
    }
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
    v.paintSeed = (v.id * 7919 + ++this.spawnSerial * 104729) | 0;
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
        .setCollisionGroups(VEHICLE_GROUND_GROUPS),
      body,
    );
    v.body = body;
    v.collider = collider;
    this.owners.set(collider.handle, { kind: 'vehicle', id: v.id });
    this.settleKerbs(v);
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
    this.playerCtl.preStep(intents, SIM_DT);
    this.weather.step(SIM_DT);
    const player = this.player.vehicle;
    this.traffic.step(SIM_DT);
    this.police.step(SIM_DT);
    this.peds.step(SIM_DT);
    this.officers.step(SIM_DT);
    this.combat.preStep(SIM_DT);
    // After combat, so mission actors hear and take this step's player shots.
    this.actors.step(SIM_DT);
    this.services.step(SIM_DT);
    this.gangs.step(SIM_DT);
    this.crowds.step(SIM_DT);
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
        // Direction steering may flick the handbrake itself for a hairpin.
        c.handbrake = intents.handbrake || (intents.scheme === 'direction' && c.handbrake);
      } else if (v.role === 'parked' || v.destroyed) {
        c.steer = 0;
        c.throttle = 0;
        // No foot brake: at a standstill the brake pedal means reverse.
        c.brake = 0;
        c.handbrake = true;
      }
      // In the air: no steering and no grip, the car keeps the line it left on.
      if (v.airborne) this.activities.jumps.air(v, SIM_DT);
      else stepArcade(v, v.params, c, SIM_DT);
      v.setVx = v.vx;
      v.setVz = v.vz;
      v.body?.setLinvel({ x: v.vx, y: 0, z: v.vz }, true);
      v.body?.setAngvel({ x: 0, y: v.yawRate, z: 0 }, true);
    }

    this.activities.preStep();
    this.props.step(SIM_DT);
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
      this.activities.jumps.vertical(v, SIM_DT);
      this.detectImpact(v);
      this.kerbs(v);
    }
    this.peds.postStep();
    this.actors.postStep();
    this.services.postStep();
    this.crowds.postStep();
    this.playerCtl.postStep();
    this.officers.postStep();
    this.combat.postStep();
    this.syncPlayer();
    this.pickups.step(SIM_DT);
    this.police.postStep(SIM_DT);
    this.survival.step(SIM_DT);
    this.economy.step(SIM_DT);
    this.score.step(SIM_DT);
    this.activities.step(SIM_DT, intents);
    if (this.trace > 0) this.trace = Math.max(0, this.trace - this.content.heat.traceDecayPerSec * SIM_DT);
    this.handlePlayerWreck();
    this.tick++;
    this.time = this.tick * SIM_DT;
  }

  /**
   * Kerbs are bumps, not walls: each axle that rides up onto (or drops off) the
   * pavement costs a little speed, more for a square-on hit than a glancing one,
   * and raises an event for the jolt and haptics.
   */
  private kerbs(v: Vehicle): void {
    const map = this.content.map;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    const axle = v.params.length * 0.32;
    const front = onPavement(map, v.x + fx * axle, v.z + fz * axle);
    const rear = onPavement(map, v.x - fx * axle, v.z - fz * axle);
    if (front === v.kerbFront && rear === v.kerbRear) return;
    if (v.y > 0.05) {
      // Flying over (or riding a ramp across) the kerb: no bump.
      v.kerbFront = front;
      v.kerbRear = rear;
      return;
    }
    const cfg = this.content.vehicles.kerb;
    const speed = Math.hypot(v.vx, v.vz);
    let crossings = 0;
    let up = false;
    let perp = 0;
    for (const [now, was, ax, az] of [
      [front, v.kerbFront, v.x + fx * axle, v.z + fz * axle],
      [rear, v.kerbRear, v.x - fx * axle, v.z - fz * axle],
    ] as const) {
      if (now === was) continue;
      crossings++;
      up ||= now;
      perp = Math.max(perp, kerbAngle(map, ax, az, v.vx, v.vz, speed));
    }
    v.kerbFront = front;
    v.kerbRear = rear;
    if (speed < 0.5) return;
    // Up is a thump on the tyres; down is gentler.
    const loss = cfg.speedLoss * (0.3 + 0.7 * perp) * (up ? 0.5 : 0.2) * crossings;
    v.vx *= 1 - loss;
    v.vz *= 1 - loss;
    v.body?.setLinvel({ x: v.vx, y: 0, z: v.vz }, true);
    if (speed < cfg.minBumpSpeed) return;
    this.events.push({ type: 'kerb', vehicleId: v.id, x: v.x, z: v.z, strength: speed * (0.4 + 0.6 * perp), up, byPlayer: v === this.player.vehicle });
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
    if (other.kind === 'ped' || other.kind === 'player' || other.kind === 'officer') return; // people are handled by their own systems
    if (dv > dmg.impactThreshold) this.damageVehicle(v, this.police.scaleImpactDamage(v, other, ((dv - dmg.impactThreshold) * dmg.damagePerMs) / v.params.armour));
    if (v.sinceImpact < 0.12) return; // debounce continuous scraping
    v.sinceImpact = 0;
    if (dv > this.content.peds.crashAlertStrength) this.peds.alarm(v.x, v.z, this.content.peds.crashAlertRadius);
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
    if (o.role === 'police' && strength > heat.config.ramMinStrength) this.police.crime('ramPolice', pv.x, pv.z);
    else if ((o.role === 'traffic' || o.role === 'parked') && heat.civCarHit(this.time)) this.police.crime('hitCivCar', pv.x, pv.z);
  }

  /** A wrecked player car throws the player out after a short pause. */
  private handlePlayerWreck(): void {
    const v = this.player.vehicle;
    if (!v || !v.destroyed) return;
    if (this.time - v.destroyedTime < this.content.vehicles.damage.destroyedEjectSec) return;
    this.playerCtl.exit();
    this.playerCtl.hurt(15, v.id);
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
      parts.push(v.id, v.x, v.z, v.yaw, v.vx, v.vz, v.hp, v.y);
    }
    parts.push(this.trace, this.heat.level, this.heat.points, this.police.drone.x, this.police.drone.z);
    const pc = this.playerCtl;
    parts.push(pc.x, pc.z, pc.hp, pc.armour, pc.facing, this.combat.current, this.score.pending);
    for (const o of this.officers.officers) if (o.active) parts.push(o.id, o.x, o.z, o.hp);
    for (const p of this.peds.peds) if (p.active) parts.push(p.id, p.x, p.z);
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
    hackable: false,
    persistent: false,
    abandonedTime: 0,
    controls: emptyControls(),
    body: null,
    collider: null,
    setVx: 0,
    setVz: 0,
    sinceImpact: 10,
    kerbFront: false,
    kerbRear: false,
    paintSeed: 0,
    beacons: false,
    siren: false,
    y: 0,
    prevY: 0,
    vy: 0,
    airborne: false,
    airHigh: false,
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
  v.persistent = false;
  v.abandonedTime = 0;
  v.hackable = false;
  v.setVx = v.setVz = 0;
  v.sinceImpact = 10;
  v.kerbFront = v.kerbRear = false;
  v.beacons = v.siren = false;
  v.y = v.prevY = v.vy = 0;
  v.airborne = v.airHigh = false;
  const c = v.controls;
  c.steer = c.throttle = c.brake = 0;
  c.handbrake = false;
}
