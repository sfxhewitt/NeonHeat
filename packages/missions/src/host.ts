import { forwardSpeed, type Vehicle, type World } from '@neonheat/sim';
import type { MissionHost } from './runner';
import type { Dialogue, Squads } from './schema';

interface VehicleSnap {
  ref: string;
  variant: string;
  x: number;
  z: number;
  yaw: number;
  hp: number;
}

interface Checkpoint {
  px: number;
  pz: number;
  facing: number;
  drivingRef: string | null;
  vehicles: VehicleSnap[];
  heat: number;
  trace: number;
}

/** MissionHost implemented over the simulation world. */
export class WorldMissionHost implements MissionHost {
  /** spawn ref -> vehicle id for mission vehicles. */
  readonly spawned = new Map<string, number>();
  readonly squadVehicles: number[] = [];
  /** Dialogue lines played, in order (for tests and the log). */
  readonly dialogueLog: string[] = [];
  onDialogue: ((speaker: string, text: string, lineId: string) => void) | null = null;

  constructor(
    readonly world: World,
    readonly squads: Squads,
    readonly lines: Dialogue,
  ) {}

  private spawnDef(ref: string) {
    const id = ref.slice('spawn:'.length);
    const s = this.world.content.map.spawns[id];
    if (!s) throw new Error(`Unknown spawn "${ref}"`);
    return s;
  }

  private vehicle(ref: string): Vehicle | null {
    const id = this.spawned.get(ref);
    if (id === undefined) return null;
    const v = this.world.vehicles[id]!;
    return v.active ? v : null;
  }

  ensureVehicle(ref: string): number {
    const existing = this.vehicle(ref);
    if (existing) return existing.id;
    const s = this.spawnDef(ref);
    const v = this.world.spawnVehicle(s.variant, s.pos[0], s.pos[2], s.yaw, 'parked');
    if (!v) throw new Error(`No free vehicle slot for "${ref}"`);
    v.locked = s.locked;
    v.persistent = true;
    this.spawned.set(ref, v.id);
    return v.id;
  }

  /** Remove mission vehicles left from an earlier run so a new run starts clean. */
  resetVehicles(): void {
    for (const [ref, id] of this.spawned) {
      const v = this.world.vehicles[id]!;
      if (!v.active) continue;
      if (this.world.player.vehicle === v) this.world.playerCtl.exit();
      this.world.despawnVehicle(v);
      this.spawned.delete(ref);
    }
  }

  resolve(ref: string): { x: number; z: number } | null {
    if (ref.startsWith('marker:')) {
      const m = this.world.content.map.markers[ref.slice('marker:'.length)];
      return m ? { x: m.pos[0], z: m.pos[2] } : null;
    }
    const v = this.vehicle(ref);
    if (v) return { x: v.x, z: v.z };
    const s = this.spawnDef(ref);
    return { x: s.pos[0], z: s.pos[2] };
  }

  vehicleHealth(id: number): number {
    return this.world.vehicleHealth(this.world.vehicles[id]!);
  }

  vehicleDestroyed(id: number): boolean {
    const v = this.world.vehicles[id]!;
    return !v.active || v.destroyed;
  }

  playerVehicle(): number {
    return this.world.player.vehicle?.id ?? -1;
  }

  playerPos(): { x: number; z: number } {
    return { x: this.world.player.x, z: this.world.player.z };
  }

  setHackable(id: number, on: boolean): void {
    this.world.vehicles[id]!.hackable = on;
  }

  setLocked(id: number, on: boolean): void {
    this.world.vehicles[id]!.locked = on;
  }

  dialogue(line: string): void {
    this.dialogueLog.push(line);
    const l = this.lines[line];
    this.onDialogue?.(l?.speaker ?? '', l?.text ?? line, line);
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

  cleanup(): void {
    const w = this.world;
    for (const id of this.squadVehicles) {
      const v = w.vehicles[id]!;
      if (v.active && v.role === 'squad') w.despawnVehicle(v);
    }
    this.squadVehicles.length = 0;
    for (const id of this.spawned.values()) {
      const v = w.vehicles[id]!;
      if (v.active) v.hackable = false;
    }
  }

  captureCheckpoint(): Checkpoint {
    const w = this.world;
    let drivingRef: string | null = null;
    const vehicles: VehicleSnap[] = [];
    for (const [ref, id] of this.spawned) {
      const v = w.vehicles[id]!;
      if (!v.active) continue;
      if (w.player.vehicle === v) drivingRef = ref;
      vehicles.push({ ref, variant: v.variantId, x: v.x, z: v.z, yaw: v.yaw, hp: v.hp });
    }
    return { px: w.player.x, pz: w.player.z, facing: w.playerCtl.facing, drivingRef, vehicles, heat: w.heat.level, trace: w.trace };
  }

  restoreCheckpoint(raw: unknown): void {
    const cp = raw as Checkpoint;
    const w = this.world;
    const pc = w.playerCtl;
    if (pc.dead) pc.respawn();
    if (pc.mode === 'driving') pc.exit();
    for (const snap of cp.vehicles) {
      let v = this.vehicle(snap.ref);
      if (v && v.destroyed) {
        w.despawnVehicle(v);
        v = null;
      }
      if (!v) {
        v = w.spawnVehicle(snap.variant, snap.x, snap.z, snap.yaw, 'parked');
        if (!v) continue;
        v.persistent = true;
        this.spawned.set(snap.ref, v.id);
      }
      w.teleportVehicle(v, snap.x, snap.z, snap.yaw);
      // A retry hands back a sound car: a checkpoint taken on a damaged car could never be passed.
      v.hp = v.params.maxHealth;
      v.role = 'parked';
    }
    pc.hp = pc.maxHp;
    const driving = cp.drivingRef ? this.vehicle(cp.drivingRef) : null;
    if (driving) pc.enter(driving);
    else {
      // Do not land on top of a car that has since been parked there.
      pc.teleport(cp.px, cp.pz);
      pc.facing = pc.prevFacing = cp.facing;
    }
    w.heat.clear();
    if (cp.heat > 0) w.heat.setLevel(cp.heat, cp.px, cp.pz);
    w.trace = cp.trace;
  }

  /** Speed of the player's car (for bots and UI). */
  playerSpeed(): number {
    const v = this.world.player.vehicle;
    return v ? forwardSpeed(v) : 0;
  }
}
