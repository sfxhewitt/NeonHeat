import type { Mission, MissionEvent, Objective } from './schema';

/** What the runner needs from the game world. Implemented over the sim by `WorldMissionHost`. */
export interface MissionHost {
  /** Resolve a `marker:`/`spawn:` reference to a ground position, spawning mission vehicles as needed. */
  resolve(ref: string): { x: number; z: number } | null;
  /** Vehicle id for a `spawn:` reference, spawning it if needed. */
  ensureVehicle(ref: string): number;
  vehicleHealth(id: number): number;
  vehicleDestroyed(id: number): boolean;
  /** Vehicle id the player is driving, or -1. */
  playerVehicle(): number;
  playerPos(): { x: number; z: number };
  setHackable(id: number, on: boolean): void;
  setLocked(id: number, on: boolean): void;
  dialogue(line: string): void;
  setHeat(level: number): void;
  addTrace(value: number): void;
  spawnSquad(squad: string): void;
  /** Remove squads and mission-only state when a run ends or rewinds. */
  cleanup(): void;
  captureCheckpoint(): unknown;
  restoreCheckpoint(cp: unknown): void;
}

export type RunnerState = 'idle' | 'running' | 'failed' | 'complete';

export interface ObjectiveView {
  id: string;
  type: Objective['type'];
  text: string;
  /** Seconds left on a time limit, or null. */
  timeLeft: number | null;
  /** Where the player should go, for markers and the edge arrow. */
  targetX: number;
  targetZ: number;
  /** Mission vehicle relevant to this objective, or -1. */
  vehicleId: number;
}

interface Scheduled {
  at: number;
  event: MissionEvent;
}

/**
 * MissionRunner v0: interprets a mission's objectives and events. Missions are
 * data; new missions never need new code paths.
 */
export class MissionRunner {
  state: RunnerState = 'idle';
  index = 0;
  /** Seconds since the mission started / the current objective started. */
  missionTime = 0;
  objectiveTime = 0;
  failReason = '';
  attempts = 0;
  readonly view: ObjectiveView = { id: '', type: 'reach', text: '', timeLeft: null, targetX: 0, targetZ: 0, vehicleId: -1 };
  private checkpoint: unknown = null;
  private firstCheckpoint: unknown = null;
  private scheduled: Scheduled[] = [];
  private hackDone = false;
  /** Consecutive failures within half a second of an objective (re)starting. */
  private instantFails = 0;
  /** Listeners for the app/director. */
  onObjectiveStart: ((o: Objective, index: number) => void) | null = null;
  onComplete: ((m: Mission) => void) | null = null;
  onFail: ((reason: string) => void) | null = null;

  constructor(
    readonly mission: Mission,
    private readonly host: MissionHost,
  ) {}

  get objective(): Objective | null {
    return this.mission.objectives[this.index] ?? null;
  }

  start(): void {
    this.state = 'running';
    this.index = 0;
    this.missionTime = 0;
    this.attempts = 1;
    this.beginObjective();
    this.firstCheckpoint = this.checkpoint;
  }

  /** Retry from the checkpoint taken at the start of the failed objective. */
  retry(): void {
    if (this.state !== 'failed') return;
    // A checkpoint that fails straight away can never be passed: fall back to a full restart.
    if (this.instantFails >= 2) return this.restart();
    this.host.cleanup();
    if (this.checkpoint !== null) this.host.restoreCheckpoint(this.checkpoint);
    this.state = 'running';
    this.attempts++;
    this.beginObjective(false);
  }

  /** Instant restart from the first objective. */
  restart(): void {
    this.instantFails = 0;
    this.host.cleanup();
    if (this.firstCheckpoint !== null) this.host.restoreCheckpoint(this.firstCheckpoint);
    this.state = 'running';
    this.index = 0;
    this.missionTime = 0;
    this.attempts++;
    this.beginObjective();
  }

  abandon(): void {
    this.host.cleanup();
    this.scheduled.length = 0;
    this.state = 'idle';
  }

  /** The hack minigame reports its result. */
  reportHack(success: boolean): void {
    const o = this.objective;
    if (this.state !== 'running' || !o || o.type !== 'hack') return;
    if (success) this.hackDone = true;
    else this.runEvents(o.onFail);
  }

  private beginObjective(takeCheckpoint = true): void {
    const o = this.objective;
    if (!o) return;
    this.objectiveTime = 0;
    this.hackDone = false;
    this.scheduled.length = 0;
    if (takeCheckpoint) this.checkpoint = this.host.captureCheckpoint();
    if (o.type === 'hack') {
      const id = this.host.ensureVehicle(o.target);
      this.host.setLocked(id, true);
      this.host.setHackable(id, true);
    } else if (o.type === 'deliverVehicle') {
      const id = this.host.ensureVehicle(o.vehicle);
      this.host.setLocked(id, false);
      this.host.setHackable(id, false);
    }
    this.runEvents(o.onStart);
    this.updateView();
    this.onObjectiveStart?.(o, this.index);
  }

  private runEvents(events: MissionEvent[] | undefined): void {
    if (!events) return;
    for (const e of events) {
      if (e.delaySec && e.delaySec > 0) this.scheduled.push({ at: this.objectiveTime + e.delaySec, event: e });
      else this.apply(e);
    }
  }

  private apply(e: MissionEvent): void {
    const h = this.host;
    switch (e.do) {
      case 'dialogue':
        h.dialogue(e.line);
        break;
      case 'setHeat':
        h.setHeat(e.value);
        break;
      case 'spawnSquad':
        h.spawnSquad(e.squad);
        break;
      case 'addTrace':
        h.addTrace(e.value);
        break;
    }
  }

  private fail(reason: string): void {
    const o = this.objective;
    this.state = 'failed';
    this.failReason = reason;
    this.instantFails = this.objectiveTime < 0.5 ? this.instantFails + 1 : 0;
    this.scheduled.length = 0;
    this.runEvents(o?.onFail);
    this.onFail?.(reason);
  }

  private completeObjective(): void {
    const o = this.objective!;
    this.runEvents(o.onComplete);
    if (o.type === 'hack') this.host.setHackable(this.host.ensureVehicle(o.target), false);
    this.index++;
    if (this.index >= this.mission.objectives.length) {
      this.state = 'complete';
      this.scheduled.length = 0;
      this.host.cleanup();
      this.onComplete?.(this.mission);
      return;
    }
    this.beginObjective();
  }

  /** Advance by dt seconds of simulation time. Call once per sim step. */
  tick(dt: number): void {
    if (this.state !== 'running') return;
    const o = this.objective;
    if (!o) return;
    this.missionTime += dt;
    this.objectiveTime += dt;
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      const s = this.scheduled[i]!;
      if (this.objectiveTime >= s.at) {
        this.scheduled.splice(i, 1);
        this.apply(s.event);
      }
    }
    if (this.state !== 'running') return;
    const h = this.host;
    const p = h.playerPos();
    switch (o.type) {
      case 'reach': {
        const t = h.resolve(o.target);
        if (t && Math.hypot(p.x - t.x, p.z - t.z) <= o.radius) this.completeObjective();
        break;
      }
      case 'hack': {
        const id = h.ensureVehicle(o.target);
        if (h.vehicleDestroyed(id)) return this.fail('The target was destroyed');
        if (this.hackDone) this.completeObjective();
        break;
      }
      case 'deliverVehicle': {
        const id = h.ensureVehicle(o.vehicle);
        if (h.vehicleDestroyed(id)) return this.fail('The car was wrecked');
        if (h.vehicleHealth(id) < o.minHealth) return this.fail('The car is too damaged to sell');
        if (o.timeLimitSec !== undefined && this.objectiveTime > o.timeLimitSec) return this.fail('Out of time');
        const t = h.resolve(o.target);
        if (t && h.playerVehicle() === id && Math.hypot(p.x - t.x, p.z - t.z) <= o.radius) this.completeObjective();
        break;
      }
    }
    if (this.state === 'running') this.updateView();
  }

  private updateView(): void {
    const o = this.objective;
    const v = this.view;
    if (!o) return;
    const h = this.host;
    v.id = o.id;
    v.type = o.type;
    v.timeLeft = null;
    v.vehicleId = -1;
    if (o.type === 'reach') {
      const t = h.resolve(o.target);
      v.text = 'Get to the marker';
      v.targetX = t?.x ?? 0;
      v.targetZ = t?.z ?? 0;
    } else if (o.type === 'hack') {
      const id = h.ensureVehicle(o.target);
      const t = h.resolve(o.target);
      v.vehicleId = id;
      v.text = 'Hack the car';
      v.targetX = t?.x ?? 0;
      v.targetZ = t?.z ?? 0;
    } else {
      const id = h.ensureVehicle(o.vehicle);
      v.vehicleId = id;
      if (o.timeLimitSec !== undefined) v.timeLeft = Math.max(0, o.timeLimitSec - this.objectiveTime);
      const health = Math.round(o.minHealth * 100);
      if (h.playerVehicle() !== id) {
        const t = h.resolve(o.vehicle);
        v.text = 'Get in the car';
        v.targetX = t?.x ?? 0;
        v.targetZ = t?.z ?? 0;
      } else {
        const t = h.resolve(o.target);
        v.text = health > 0 ? `Deliver the car (keep it above ${health}%)` : 'Deliver the car';
        v.targetX = t?.x ?? 0;
        v.targetZ = t?.z ?? 0;
      }
    }
  }
}
