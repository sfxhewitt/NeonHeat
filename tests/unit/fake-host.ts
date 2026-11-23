import type { DriveCommand, MissionHost, Pos } from '@neonheat/missions';

/** A scriptable fake world for pure MissionRunner tests. Every ref has a position you can move. */
export class FakeHost implements MissionHost {
  player: Pos = { x: 0, z: 0 };
  speed = 0;
  /** Vehicle id the player drives, or -1. */
  driving = -1;
  heat = 0;
  trace = 0;
  los = true;
  readonly pos = new Map<string, Pos>();
  readonly ids = new Map<string, number>();
  readonly health = new Map<string, number>();
  readonly destroyed = new Set<string>();
  readonly dead = new Set<string>();
  readonly done = new Set<string>();
  readonly variants = new Map<number, string>();
  readonly drives = new Map<string, DriveCommand>();
  readonly hackable = new Set<string>();
  readonly locked = new Set<string>();
  readonly terminals = new Map<string, Pos | null>();
  readonly log: string[] = [];
  readonly hints: string[] = [];
  readonly spawned: string[] = [];
  readonly boarded = new Set<string>();
  squads = 0;
  checkpoints = 0;
  restored = 0;
  cleanups = 0;
  lostPassengers = false;
  private nextId = 10;

  at(ref: string, x: number, z: number): this {
    this.pos.set(ref, { x, z });
    return this;
  }

  /** Put the player at a ref's position (optionally driving its vehicle). */
  put(ref: string, drive = false): void {
    const p = this.resolve(ref)!;
    this.player = { x: p.x, z: p.z };
    if (drive) this.driving = this.ensureVehicle(ref);
  }

  resolve(ref: string): Pos | null {
    return this.pos.get(ref) ?? null;
  }
  ensureVehicle(ref: string): number {
    let id = this.ids.get(ref);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(ref, id);
      this.variants.set(id, 'kestrel');
    }
    return id;
  }
  vehicleHealth(ref: string): number {
    return this.health.get(ref) ?? 1;
  }
  vehicleDestroyed(ref: string): boolean {
    return this.destroyed.has(ref);
  }
  vehicleVariant(id: number): string {
    return this.variants.get(id) ?? '';
  }
  variantName(v: string): string {
    return v[0]!.toUpperCase() + v.slice(1);
  }
  nearestVehicleOf(variants: readonly string[]): number {
    for (const [id, v] of this.variants) if (variants.includes(v)) return id;
    return -1;
  }
  vehiclePos(): Pos | null {
    return { x: 0, z: 0 };
  }
  ensureActor(ref: string): boolean {
    this.spawned.push(ref);
    return true;
  }
  actorDead(ref: string): boolean {
    return this.dead.has(ref);
  }
  playerVehicle(): number {
    return this.driving;
  }
  playerPos(): Pos {
    return this.player;
  }
  playerSpeed(): number {
    return this.speed;
  }
  heatLevel(): number {
    return this.heat;
  }
  traceLevel(): number {
    return this.trace;
  }
  lineOfSight(): boolean {
    return this.los;
  }
  drive(ref: string, cmd: DriveCommand): void {
    this.drives.set(ref, cmd);
  }
  driverDone(ref: string): boolean {
    return this.done.has(ref);
  }
  setHackable(ref: string, on: boolean): void {
    if (on) this.hackable.add(ref);
    else this.hackable.delete(ref);
  }
  setLocked(ref: string, on: boolean): void {
    if (on) this.locked.add(ref);
    else this.locked.delete(ref);
  }
  dialogue(line: string): void {
    this.log.push(line);
  }
  hint(text: string): void {
    this.hints.push(text);
  }
  setHeat(v: number): void {
    this.heat = v;
  }
  addTrace(v: number): void {
    this.trace += v;
  }
  spawnSquad(): void {
    this.squads++;
  }
  spawn(ref: string): void {
    this.spawned.push(ref);
  }
  despawn(): void {}
  aggro(): void {}
  board(ref: string): void {
    this.boarded.add(ref);
  }
  alight(ref: string): void {
    this.boarded.delete(ref);
  }
  goTo(): void {}
  placeTerminal(key: string, at: Pos | null): void {
    this.terminals.set(key, at);
  }
  passengersLost(): boolean {
    return this.lostPassengers;
  }
  cleanup(): void {
    this.cleanups++;
  }
  captureCheckpoint(): unknown {
    return ++this.checkpoints;
  }
  restoreCheckpoint(): void {
    this.restored++;
  }
}
