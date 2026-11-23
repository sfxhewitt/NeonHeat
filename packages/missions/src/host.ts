import { forwardSpeed, type Actor, type Vehicle, type World } from '@neonheat/sim';
import { laneYaw, markerPos, resolveActorDef, resolveSpawnDef, splitRef, type Pos } from './refs';
import type { DriveCommand, MissionHost } from './runner';
import type { Dialogue, Mission, Squads } from './schema';

interface VehicleSnap {
  ref: string;
  variant: string;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  locked: boolean;
  destroyed: boolean;
}

interface ActorSnap {
  ref: string;
  x: number;
  z: number;
  hp: number;
  dead: boolean;
  riding: boolean;
  aggro: boolean;
}

interface Checkpoint {
  px: number;
  pz: number;
  facing: number;
  drivingRef: string | null;
  vehicles: VehicleSnap[];
  actors: ActorSnap[];
  gone: string[];
  heat: number;
  trace: number;
}

/** MissionHost implemented over the simulation world. */
/** Police and squad cars this close to a checkpoint are removed when it is restored (m). */
const RETRY_CLEAR_RADIUS = 150;

export class WorldMissionHost implements MissionHost {
  /** The mission whose spawns and actors refs resolve against. */
  mission: Mission | null = null;
  /** spawn ref -> vehicle id for mission vehicles. */
  readonly spawned = new Map<string, number>();
  /** Spawn refs whose vehicle is wrecked or gone for good this run. */
  private readonly gone = new Set<string>();
  /** actor ref -> actor pool slot. */
  readonly actorSlots = new Map<string, number>();
  private readonly deadActors = new Set<string>();
  readonly squadVehicles: number[] = [];
  private readonly terminals = new Map<string, Pos>();
  /** Mission vehicles that have moved under their own power (player or driver) this run. */
  private readonly moved = new Set<string>();
  /** Dialogue lines played, in order (for tests and the log). */
  readonly dialogueLog: string[] = [];
  readonly hintLog: string[] = [];
  onDialogue: ((speaker: string, text: string, lineId: string) => void) | null = null;
  onHint: ((text: string, desktop: string | null, seconds: number) => void) | null = null;

  constructor(
    readonly world: World,
    readonly squads: Squads,
    readonly lines: Dialogue,
  ) {}

  setMission(m: Mission | null): void {
    this.mission = m;
  }

  private marker(id: string): Pos | null {
    return markerPos(this.world.content.map, id);
  }

  private vehicle(ref: string): Vehicle | null {
    const id = this.spawned.get(ref);
    if (id === undefined) return null;
    const v = this.world.vehicles[id]!;
    return v.active ? v : null;
  }

  private actor(ref: string): Actor | null {
    const slot = this.actorSlots.get(ref);
    if (slot === undefined) return null;
    const a = this.world.actors.actors[slot]!;
    return a.active ? a : null;
  }

  private spawnVehicleFor(ref: string, x?: number, z?: number, yaw?: number): Vehicle | null {
    const def = resolveSpawnDef(this.world.content.map, this.mission, ref);
    if (!def) throw new Error(`Unknown spawn "${ref}"`);
    const px = x ?? def.x;
    const pz = z ?? def.z;
    const heading = yaw ?? def.yaw ?? laneYaw(this.world.roads, px, pz);
    const v = this.world.spawnVehicle(def.variant, px, pz, heading, 'parked');
    if (!v) return null;
    v.locked = def.locked;
    v.hackable = def.hackable;
    v.persistent = true;
    this.spawned.set(ref, v.id);
    return v;
  }

  ensureVehicle(ref: string): number {
    if (this.gone.has(ref)) return this.spawned.get(ref) ?? -1;
    const existing = this.spawned.get(ref);
    if (existing !== undefined) {
      const v = this.world.vehicles[existing]!;
      if (v.active) return existing;
      this.gone.add(ref);
      return existing;
    }
    const v = this.spawnVehicleFor(ref);
    if (!v) throw new Error(`No free vehicle slot for "${ref}"`);
    return v.id;
  }

  /** The director reports each car the player gets into. */
  noteEntered(vehicleId: number): void {
    for (const [ref, id] of this.spawned) if (id === vehicleId) this.moved.add(ref);
  }

  /** Remove mission vehicles left from an earlier run so a new run starts clean. */
  resetVehicles(): void {
    this.moved.clear();
    for (const [ref, id] of this.spawned) {
      const v = this.world.vehicles[id]!;
      if (v.active) {
        if (this.world.player.vehicle === v) this.releaseVehicle(v);
        else this.world.despawnVehicle(v);
      }
      this.spawned.delete(ref);
    }
    this.gone.clear();
  }

  /** The job is over: mission cars become ordinary cars (recycled once abandoned). */
  releaseAll(): void {
    for (const id of this.spawned.values()) {
      const v = this.world.vehicles[id]!;
      if (v.active) this.releaseVehicle(v);
    }
    this.spawned.clear();
    this.gone.clear();
    this.moved.clear();
    this.actorSlots.clear();
    this.deadActors.clear();
  }

  private releaseVehicle(v: Vehicle): void {
    this.world.actors.stopDriving(v.id);
    v.persistent = false;
    v.locked = false;
    v.hackable = false;
  }

  /** Called every director tick: notice mission vehicles that have left the world. */
  update(): void {
    for (const [ref, id] of this.spawned) if (!this.world.vehicles[id]!.active) this.gone.add(ref);
    for (const [ref, slot] of this.actorSlots) if (this.world.actors.actors[slot]!.dead) this.deadActors.add(ref);
  }

  resolve(ref: string): Pos | null {
    const [kind, id] = splitRef(ref);
    if (kind === 'marker') return this.marker(id);
    if (kind === 'actor') {
      const a = this.actor(ref);
      if (a) return { x: a.x, z: a.z };
      const d = resolveActorDef(this.world.content.map, this.mission, ref);
      return d ? { x: d.x, z: d.z } : null;
    }
    const v = this.vehicle(ref);
    if (v) return { x: v.x, z: v.z };
    const s = resolveSpawnDef(this.world.content.map, this.mission, ref);
    return s ? { x: s.x, z: s.z } : null;
  }

  vehicleHealth(ref: string): number {
    if (this.gone.has(ref)) return 0;
    const v = this.vehicle(ref);
    return v ? this.world.vehicleHealth(v) : 1;
  }

  vehicleDestroyed(ref: string): boolean {
    if (this.gone.has(ref)) return true;
    const id = this.spawned.get(ref);
    if (id === undefined) return false;
    const v = this.world.vehicles[id]!;
    return !v.active || v.destroyed;
  }

  vehicleVariant(id: number): string {
    const v = this.world.vehicles[id];
    return v && v.active ? v.variantId : '';
  }

  variantName(variant: string): string {
    return this.world.content.vehicles.variants[variant]?.name ?? variant;
  }

  nearestVehicleOf(variants: readonly string[], x: number, z: number): number {
    let best = -1;
    let bd = Infinity;
    for (const v of this.world.vehicles) {
      if (!v.active || v.destroyed || !variants.includes(v.variantId)) continue;
      if (v.role !== 'parked' && v.role !== 'traffic' && v.role !== 'player') continue;
      const d = Math.hypot(v.x - x, v.z - z);
      if (d < bd) {
        bd = d;
        best = v.id;
      }
    }
    return best;
  }

  vehiclePos(id: number): Pos | null {
    const v = this.world.vehicles[id];
    return v && v.active ? { x: v.x, z: v.z } : null;
  }

  ensureActor(ref: string): boolean {
    if (this.deadActors.has(ref) || this.actor(ref)) return true;
    return this.spawnActorFor(ref) !== null;
  }

  private spawnActorFor(ref: string, x?: number, z?: number): Actor | null {
    const d = resolveActorDef(this.world.content.map, this.mission, ref);
    if (!d) throw new Error(`Unknown actor "${ref}"`);
    const a = this.world.actors.spawnActor({
      x: x ?? d.x,
      z: z ?? d.z,
      facing: d.facing,
      faction: d.faction,
      hostile: d.hostile,
      armed: d.armed,
      behaviour: d.behaviour,
      hp: d.hp,
      group: d.group ? `${this.mission?.id ?? ''}:${d.group}` : `${this.mission?.id ?? ''}:${d.faction}`,
    });
    if (!a) return null;
    this.actorSlots.set(ref, a.id);
    this.deadActors.delete(ref);
    return a;
  }

  actorDead(ref: string): boolean {
    if (this.deadActors.has(ref)) return true;
    const a = this.actor(ref);
    if (a?.dead) {
      this.deadActors.add(ref);
      return true;
    }
    return false;
  }

  playerVehicle(): number {
    const v = this.world.player.vehicle;
    return v && !v.destroyed ? v.id : -1;
  }

  playerPos(): Pos {
    return { x: this.world.player.x, z: this.world.player.z };
  }

  playerSpeed(): number {
    const p = this.world.player;
    return p.vehicle ? Math.abs(forwardSpeed(p.vehicle)) : Math.hypot(p.vx, p.vz);
  }

  heatLevel(): number {
    return this.world.heat.level;
  }

  traceLevel(): number {
    return this.world.trace;
  }

  lineOfSight(a: Pos, b: Pos): boolean {
    return this.world.police.lineOfSight(a.x, a.z, b.x, b.z);
  }

  drive(ref: string, cmd: DriveCommand): void {
    const id = this.ensureVehicle(ref);
    const v = id >= 0 ? this.world.vehicles[id] : undefined;
    if (!v || !v.active || v.destroyed || this.world.player.vehicle === v) return;
    if (cmd.mode !== 'hold' && cmd.mode !== 'park') this.moved.add(ref);
    const A = this.world.actors;
    switch (cmd.mode) {
      case 'route':
        A.driveRoute(v, cmd.route ?? [], cmd.speed, { polite: cmd.polite, aggressive: cmd.aggressive, loop: cmd.loop });
        break;
      case 'flee':
        A.flee(v, cmd.speed);
        break;
      case 'ram':
        A.ram(v, cmd.targetVehicle ?? -1, cmd.speed);
        break;
      case 'hold':
        A.holdVehicle(v);
        break;
      case 'park':
        A.stopDriving(v.id);
        break;
    }
  }

  driverDone(ref: string): boolean {
    const id = this.spawned.get(ref);
    if (id === undefined) return false;
    const d = this.world.actors.driverFor(id);
    return d !== null && d.mode === 'route' && d.done;
  }

  setHackable(ref: string, on: boolean): void {
    const v = this.vehicle(ref);
    if (v) v.hackable = on;
  }

  setLocked(ref: string, on: boolean): void {
    const v = this.vehicle(ref);
    if (v) v.locked = on;
  }

  dialogue(line: string): void {
    this.dialogueLog.push(line);
    const l = this.lines[line];
    this.onDialogue?.(l?.speaker ?? '', l?.text ?? line, line);
  }

  hint(text: string, desktop: string | null, seconds: number): void {
    this.hintLog.push(text);
    this.onHint?.(text, desktop, seconds);
  }

  setHeat(level: number): void {
    this.world.heat.setLevel(level, this.world.player.x, this.world.player.z);
  }

  addTrace(value: number): void {
    this.world.addTrace(value);
  }

  spawnSquad(squad: string): void {
    const def = this.squads[squad];
    if (!def) throw new Error(`Unknown squad "${squad}"`);
    for (let i = 0; i < def.count; i++) {
      const v = this.world.police.spawnUnit('squad', def.variant);
      if (v) this.squadVehicles.push(v.id);
    }
  }

  spawn(ref: string): void {
    if (ref.startsWith('spawn:')) this.ensureVehicle(ref);
    else this.ensureActor(ref);
  }

  despawn(ref: string): void {
    if (ref.startsWith('spawn:')) {
      const v = this.vehicle(ref);
      if (v && this.world.player.vehicle !== v) {
        this.world.actors.stopDriving(v.id);
        this.world.despawnVehicle(v);
      }
      this.spawned.delete(ref);
      this.gone.delete(ref);
    } else {
      const a = this.actor(ref);
      if (a) this.world.actors.despawnActor(a);
      this.actorSlots.delete(ref);
    }
  }

  aggro(ref: string, target: string | null): void {
    if (!this.ensureActor(ref)) return;
    const a = this.actor(ref);
    if (!a || a.dead) return;
    if (target?.startsWith('actor:')) {
      this.ensureActor(target);
      this.world.actors.setAggro(a, true, { actor: this.actor(target) });
    } else if (target?.startsWith('spawn:')) {
      this.world.actors.setAggro(a, true, { vehicleId: this.ensureVehicle(target) });
    } else this.world.actors.setAggro(a, true);
  }

  board(ref: string): void {
    if (!this.ensureActor(ref)) return;
    const a = this.actor(ref);
    if (a) this.world.actors.board(a);
  }

  alight(ref: string, at: Pos | null): void {
    const a = this.actor(ref);
    if (!a || !a.riding) return;
    const p = this.world.player;
    // Out of the car on the pavement side, then off towards the drop.
    const x = p.x + Math.cos(p.vehicle?.yaw ?? 0) * 2.2;
    const z = p.z - Math.sin(p.vehicle?.yaw ?? 0) * 2.2;
    this.world.actors.alight(a, x, z);
    if (at) this.world.actors.goTo(a, at.x, at.z, false);
  }

  goTo(ref: string, to: Pos, run: boolean): void {
    if (!this.ensureActor(ref)) return;
    const a = this.actor(ref);
    if (a) this.world.actors.goTo(a, to.x, to.z, run);
  }

  placeTerminal(key: string, at: Pos | null): void {
    const list = this.world.interactables;
    const id = `terminal:${key}`;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.id === id) list.splice(i, 1);
    this.terminals.delete(key);
    if (!at) return;
    this.terminals.set(key, at);
    list.push({ id, x: at.x, z: at.z, radius: 2.5, label: 'HACK' });
  }

  terminalPos(key: string): Pos | null {
    return this.terminals.get(key) ?? null;
  }

  passengersLost(): boolean {
    const v = this.world.player.vehicle;
    if (!v || !v.destroyed) return false;
    for (const slot of this.actorSlots.values()) {
      const a = this.world.actors.actors[slot]!;
      if (a.active && a.riding) return true;
    }
    return false;
  }

  cleanup(): void {
    const w = this.world;
    for (const id of this.squadVehicles) {
      const v = w.vehicles[id]!;
      if (v.active && v.role === 'squad') w.despawnVehicle(v);
    }
    this.squadVehicles.length = 0;
    for (const id of this.spawned.values()) {
      const v = w.vehicles[id]!;
      if (!v.active) continue;
      v.hackable = false;
      w.actors.stopDriving(id);
    }
    for (const key of [...this.terminals.keys()]) this.placeTerminal(key, null);
    // People: the living leave; the fallen stay down.
    for (const [ref, slot] of this.actorSlots) {
      const a = w.actors.actors[slot]!;
      if (a.dead) this.deadActors.add(ref);
      if (a.active) w.actors.despawnActor(a);
    }
    this.actorSlots.clear();
  }

  captureCheckpoint(): Checkpoint {
    const w = this.world;
    let drivingRef: string | null = null;
    const vehicles: VehicleSnap[] = [];
    for (const [ref, id] of this.spawned) {
      const v = w.vehicles[id]!;
      if (!v.active || this.gone.has(ref)) continue;
      if (w.player.vehicle === v) drivingRef = ref;
      // A parked car nobody has driven yet goes back to its own spot, so a police car shunting a
      // locked target into a corner cannot make every retry start wedged.
      const def = !this.moved.has(ref) && drivingRef !== ref ? resolveSpawnDef(w.content.map, this.mission, ref) : null;
      const x = def ? def.x : v.x;
      const z = def ? def.z : v.z;
      const yaw = def ? (def.yaw ?? laneYaw(w.roads, def.x, def.z)) : v.yaw;
      vehicles.push({ ref, variant: v.variantId, x, z, yaw, hp: v.hp, locked: v.locked, destroyed: v.destroyed });
    }
    const actors: ActorSnap[] = [];
    for (const [ref, slot] of this.actorSlots) {
      const a = w.actors.actors[slot]!;
      if (!a.active) continue;
      actors.push({ ref, x: a.x, z: a.z, hp: a.hp, dead: a.dead, riding: a.riding, aggro: a.aggro });
    }
    for (const ref of this.deadActors) if (!this.actorSlots.has(ref)) actors.push({ ref, x: 0, z: 0, hp: 0, dead: true, riding: false, aggro: false });
    return { px: w.player.x, pz: w.player.z, facing: w.playerCtl.facing, drivingRef, vehicles, actors, gone: [...this.gone], heat: w.heat.level, trace: w.trace };
  }

  restoreCheckpoint(raw: unknown): void {
    const cp = raw as Checkpoint;
    const w = this.world;
    const pc = w.playerCtl;
    if (pc.dead || pc.busted) pc.respawn();
    if (pc.mode === 'driving') pc.exit();
    // Vehicles spawned after the checkpoint go, so they come back fresh at their spawn point.
    const keep = new Set(cp.vehicles.map((s) => s.ref));
    for (const [ref, id] of [...this.spawned]) {
      if (keep.has(ref)) continue;
      const v = w.vehicles[id]!;
      if (v.active) {
        w.actors.stopDriving(id);
        w.despawnVehicle(v);
      }
      this.spawned.delete(ref);
    }
    this.gone.clear();
    for (const ref of cp.gone) this.gone.add(ref);
    for (const snap of cp.vehicles) {
      let v = this.vehicle(snap.ref);
      if (v && v.destroyed && !snap.destroyed) {
        w.despawnVehicle(v);
        v = null;
      }
      if (!v) {
        v = this.spawnVehicleFor(snap.ref, snap.x, snap.z, snap.yaw);
        if (!v) continue;
      }
      w.actors.stopDriving(v.id);
      w.teleportVehicle(v, snap.x, snap.z, snap.yaw);
      // A retry hands back a sound car: a checkpoint taken on a damaged car could never be passed.
      if (!snap.destroyed) v.hp = v.params.maxHealth;
      v.role = 'parked';
      v.locked = snap.locked;
    }
    // People: everyone back where they stood; the fallen stay fallen.
    for (const slot of this.actorSlots.values()) {
      const a = w.actors.actors[slot]!;
      if (a.active) w.actors.despawnActor(a);
    }
    this.actorSlots.clear();
    this.deadActors.clear();
    for (const s of cp.actors) {
      if (s.dead) {
        this.deadActors.add(s.ref);
        continue;
      }
      const a = this.spawnActorFor(s.ref, s.x, s.z);
      if (!a) continue;
      if (s.riding) w.actors.board(a);
      if (s.aggro) w.actors.setAggro(a, true);
    }
    pc.hp = pc.maxHp;
    const driving = cp.drivingRef ? this.vehicle(cp.drivingRef) : null;
    if (driving) pc.enter(driving);
    else {
      pc.teleport(cp.px, cp.pz);
      pc.facing = pc.prevFacing = cp.facing;
    }
    // A retry is a fresh go: patrols already on top of the restart point are sent away
    // (they come back from a distance if HEAT is still up), so a retry cannot start in a death loop.
    for (const v of w.vehicles) {
      if (!v.active || v.destroyed || (v.role !== 'police' && v.role !== 'squad')) continue;
      if (Math.hypot(v.x - cp.px, v.z - cp.pz) < RETRY_CLEAR_RADIUS) w.despawnVehicle(v);
    }
    w.heat.clear();
    if (cp.heat > 0) w.heat.setLevel(cp.heat, cp.px, cp.pz);
    w.trace = cp.trace;
  }

  /** Speed of the player's car (for bots and UI). */
  playerCarSpeed(): number {
    const v = this.world.player.vehicle;
    return v ? forwardSpeed(v) : 0;
  }
}
