import type { Pos } from './refs';
import type { FailCondition, Mission, MissionEvent, Objective, ObjectiveType, PerformAction, VehicleReq } from './schema';

export interface DriveCommand {
  mode: 'route' | 'flee' | 'ram' | 'hold' | 'park';
  route?: Pos[];
  /** Ram target vehicle id; -1 is the player. */
  targetVehicle?: number;
  speed?: number;
  loop?: boolean;
  /** Keep a gap behind traffic (couriers, escorts) rather than shunting through it. */
  polite?: boolean;
  aggressive?: boolean;
}

/**
 * What the runner needs from the game world. Implemented over the sim by
 * `WorldMissionHost`, and by a scriptable fake in unit tests. Vehicle and
 * actor queries take references (`spawn:<id>`, `actor:<id>`).
 */
export interface MissionHost {
  /** Ground position of a marker, a mission vehicle or a mission person. */
  resolve(ref: string): Pos | null;
  /** Vehicle id for a `spawn:` reference, spawning it if needed; -1 once it is gone for good. */
  ensureVehicle(ref: string): number;
  /** Let auto-aim lock on to this mission vehicle (a target to wreck). */
  markAimTarget?(ref: string): void;
  vehicleHealth(ref: string): number;
  vehicleDestroyed(ref: string): boolean;
  /** Variant id of a vehicle by id ('' if none). */
  vehicleVariant(id: number): string;
  /** Player-facing name of a vehicle variant. */
  variantName(variant: string): string;
  /** Nearest usable vehicle of one of these variants to a point, or -1. */
  nearestVehicleOf(variants: readonly string[], x: number, z: number): number;
  vehiclePos(id: number): Pos | null;
  /** Spawn a mission person if needed. False if it cannot be placed. */
  ensureActor(ref: string): boolean;
  actorDead(ref: string): boolean;
  /** Vehicle id the player is driving, or -1. */
  playerVehicle(): number;
  playerPos(): Pos;
  /** Speed of the player (car or on foot), m/s. */
  playerSpeed(): number;
  heatLevel(): number;
  traceLevel(): number;
  lineOfSight(a: Pos, b: Pos): boolean;
  drive(ref: string, cmd: DriveCommand): void;
  /** A route driver has reached the end of its route. */
  driverDone(ref: string): boolean;
  setHackable(ref: string, on: boolean): void;
  setLocked(ref: string, on: boolean): void;
  dialogue(line: string): void;
  hint(text: string, desktop: string | null, seconds: number): void;
  setHeat(level: number): void;
  addTrace(value: number): void;
  spawnSquad(squad: string): void;
  spawn(ref: string): void;
  despawn(ref: string): void;
  /** Start a hostile fighting; it goes after the player unless a target (spawn or actor) is given. */
  aggro(ref: string, target: string | null): void;
  board(ref: string): void;
  alight(ref: string, at: Pos | null): void;
  goTo(ref: string, to: Pos, run: boolean): void;
  /** Show (or with null, remove) a hackable terminal for a marker-target hack objective. */
  placeTerminal(key: string, at: Pos | null): void;
  /** Riding passengers whose car has been wrecked. */
  passengersLost(): boolean;
  /** Remove squads and mission-only state when a run ends or rewinds. */
  cleanup(): void;
  captureCheckpoint(): unknown;
  restoreCheckpoint(cp: unknown): void;
}

export type RunnerState = 'idle' | 'running' | 'failed' | 'complete';

const MAX_MARKERS = 16;

export interface ObjectiveView {
  id: string;
  type: ObjectiveType;
  text: string;
  /** Seconds left on a time limit, or null. */
  timeLeft: number | null;
  /** Where the player should go, for markers and the edge arrow. */
  targetX: number;
  targetZ: number;
  /** Radius of the target zone (m). */
  radius: number;
  /** Mission vehicle relevant to this objective, or -1. */
  vehicleId: number;
  /** Count so far, e.g. "2/4", or null. */
  progress: string | null;
  /** A 0..1 meter (wait, photograph, tail distance), or null. */
  meter: number | null;
  /** A warning line ("Too close!"), or null. */
  warning: string | null;
  /** Extra points to mark (remaining pickups, targets, next checkpoint); only the first markerCount are live. */
  readonly markers: Pos[];
  markerCount: number;
}

interface Scheduled {
  at: number;
  event: MissionEvent;
  /** Objective-scoped events are dropped when the objective ends. */
  objective: boolean;
}

/** Per-objective scratch state. */
interface ObjectiveState {
  count: number;
  /** General-purpose timers. */
  t1: number;
  t2: number;
  idx: number;
  done: boolean[];
  tooFar: number[];
  /** Chase: the target has been disabled. */
  disabled: boolean;
  /** Tail: the player has had the target in range at least once (no "lost them" before that). */
  acquired: boolean;
  hackDone: boolean;
}

const VEHICLE_TEXT: Record<'any' | 'none', string> = { any: ' in a car', none: ' on foot' };

/**
 * MissionRunner: interprets a mission's objectives and events. Missions are
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
  readonly view: ObjectiveView = {
    id: '',
    type: 'reach',
    text: '',
    timeLeft: null,
    targetX: 0,
    targetZ: 0,
    radius: 6,
    vehicleId: -1,
    progress: null,
    meter: null,
    warning: null,
    markers: Array.from({ length: MAX_MARKERS }, () => ({ x: 0, z: 0 })),
    markerCount: 0,
  };
  private checkpoint: unknown = null;
  private firstCheckpoint: unknown = null;
  private readonly scheduled: Scheduled[] = [];
  private readonly os: ObjectiveState = { count: 0, t1: 0, t2: 0, idx: 0, done: [], tooFar: [], disabled: false, acquired: false, hackDone: false };
  private readonly actions: Record<PerformAction, number> = { dodge: 0, fire: 0, enter: 0, exit: 0 };
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
    this.scheduled.length = 0;
    this.runEvents(this.mission.onStart, false);
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
    this.scheduled.length = 0;
    this.runEvents(this.mission.onStart, false);
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
    if (success) this.os.hackDone = true;
    else this.runEvents(o.onFail, true);
  }

  /** Fail the job from outside (the player went down, for example). */
  failWith(reason: string): void {
    if (this.state === 'running') this.fail(reason);
  }

  /** The director reports player actions (for `perform` objectives). */
  noteAction(action: PerformAction): void {
    this.actions[action]++;
  }

  private beginObjective(takeCheckpoint = true): void {
    const o = this.objective;
    if (!o) return;
    const h = this.host;
    this.objectiveTime = 0;
    const s = this.os;
    s.count = 0;
    s.t1 = 0;
    s.t2 = 0;
    s.idx = 0;
    s.done.length = 0;
    s.tooFar.length = 0;
    s.disabled = false;
    s.acquired = false;
    s.hackDone = false;
    for (const k of Object.keys(this.actions) as PerformAction[]) this.actions[k] = 0;
    for (let i = this.scheduled.length - 1; i >= 0; i--) if (this.scheduled[i]!.objective) this.scheduled.splice(i, 1);
    if (takeCheckpoint) this.checkpoint = h.captureCheckpoint();
    switch (o.type) {
      case 'hack':
        if (o.target.startsWith('spawn:')) {
          h.ensureVehicle(o.target);
          h.setLocked(o.target, true);
          h.setHackable(o.target, true);
        } else h.placeTerminal(o.id, h.resolve(o.target));
        break;
      case 'deliverVehicle':
        h.ensureVehicle(o.vehicle);
        h.setLocked(o.vehicle, false);
        h.setHackable(o.vehicle, false);
        break;
      case 'stealVehicle':
        if (o.vehicle) {
          h.ensureVehicle(o.vehicle);
          h.setLocked(o.vehicle, false);
        }
        break;
      case 'destroyVehicle':
        for (const t of o.targets) h.ensureVehicle(t);
        break;
      case 'eliminate':
        for (const t of o.targets) h.ensureActor(t);
        break;
      case 'protect':
        if (o.target.startsWith('spawn:')) {
          h.ensureVehicle(o.target);
          if (o.destination) {
            const dest = h.resolve(o.destination);
            if (dest) h.drive(o.target, { mode: 'route', route: [dest], speed: o.speed, polite: true });
          }
        } else h.ensureActor(o.target);
        break;
      case 'tail': {
        h.ensureVehicle(o.target);
        h.setLocked(o.target, true);
        const route = o.route.map((r) => h.resolve(r)).filter((p): p is Pos => p !== null);
        h.drive(o.target, { mode: 'route', route, speed: o.speed, polite: true });
        break;
      }
      case 'chase':
        h.ensureVehicle(o.target);
        h.setLocked(o.target, true);
        h.drive(o.target, { mode: 'flee', speed: o.speed });
        break;
      case 'race':
        if (typeof o.vehicle === 'string' && o.vehicle.startsWith('spawn:')) h.ensureVehicle(o.vehicle);
        if (o.opponents) {
          const route = o.checkpoints.map((r) => h.resolve(r)).filter((p): p is Pos => p !== null);
          for (const r of o.opponents) {
            h.ensureVehicle(r);
            h.setLocked(r, true);
            h.drive(r, { mode: 'route', route, speed: o.opponentSpeed, polite: false, aggressive: true });
          }
        }
        break;
      case 'dropOff':
        if (o.vehicle.startsWith('spawn:')) h.ensureVehicle(o.vehicle);
        break;
      case 'photograph':
        if (o.target.startsWith('spawn:')) h.ensureVehicle(o.target);
        else h.ensureActor(o.target);
        break;
      default:
        break;
    }
    this.runEvents(o.onStart, true);
    this.updateView();
    this.onObjectiveStart?.(o, this.index);
  }

  private runEvents(events: MissionEvent[] | undefined, objective: boolean): void {
    if (!events) return;
    for (const e of events) {
      if (e.delaySec && e.delaySec > 0) this.scheduled.push({ at: this.missionTime + e.delaySec, event: e, objective });
      else this.apply(e);
    }
  }

  private apply(e: MissionEvent): void {
    const h = this.host;
    switch (e.do) {
      case 'dialogue':
        h.dialogue(e.line);
        break;
      case 'hint':
        h.hint(e.text, e.desktop ?? null, e.durationSec ?? 5);
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
      case 'spawn':
        for (const r of e.refs) h.spawn(r);
        break;
      case 'despawn':
        for (const r of e.refs) h.despawn(r);
        break;
      case 'aggro':
        for (const r of e.refs) h.aggro(r, e.target && e.target !== 'player' ? e.target : null);
        break;
      case 'drive': {
        const route = e.route?.map((r) => h.resolve(r)).filter((p): p is Pos => p !== null);
        const targetVehicle = e.target === undefined || e.target === 'player' ? -1 : h.ensureVehicle(e.target);
        h.drive(e.vehicle, { mode: e.mode, route, targetVehicle, speed: e.speed, loop: e.loop, polite: e.mode === 'route' });
        break;
      }
      case 'board':
        for (const r of e.actors) h.board(r);
        break;
      case 'alight': {
        const at = e.at ? h.resolve(e.at) : null;
        for (const r of e.actors) h.alight(r, at);
        break;
      }
      case 'goTo': {
        const to = h.resolve(e.to);
        if (to) h.goTo(e.actor, to, e.run ?? false);
        break;
      }
      case 'lock':
        h.setLocked(e.vehicle, e.value);
        break;
    }
  }

  private fail(reason: string): void {
    const o = this.objective;
    this.state = 'failed';
    this.failReason = reason;
    this.instantFails = this.objectiveTime < 0.5 ? this.instantFails + 1 : 0;
    // The objective's pending events go; mission-level ones wait for the retry.
    for (let i = this.scheduled.length - 1; i >= 0; i--) if (this.scheduled[i]!.objective) this.scheduled.splice(i, 1);
    if (o?.type === 'hack' && o.target.startsWith('marker:')) this.host.placeTerminal(o.id, null);
    this.runEvents(o?.onFail, true);
    this.onFail?.(reason);
  }

  private completeObjective(): void {
    const o = this.objective!;
    const h = this.host;
    this.runEvents(o.onComplete, false);
    if (o.type === 'hack') {
      if (o.target.startsWith('spawn:')) h.setHackable(o.target, false);
      else h.placeTerminal(o.id, null);
    } else if (o.type === 'dropOff' && o.passengers) {
      const at = h.resolve(o.target);
      for (const p of o.passengers) h.alight(p, at);
    }
    this.index++;
    if (this.index >= this.mission.objectives.length) {
      this.runEvents(this.mission.onComplete, false);
      // Anything still scheduled is dropped: the job is over.
      this.state = 'complete';
      this.scheduled.length = 0;
      this.host.cleanup();
      this.onComplete?.(this.mission);
      return;
    }
    this.beginObjective();
  }

  /** True when the player meets a vehicle requirement. */
  private inVehicle(req: VehicleReq | undefined): boolean {
    const h = this.host;
    if (req === undefined) return true;
    const pv = h.playerVehicle();
    if (req === 'any') return pv >= 0;
    if (req === 'none') return pv < 0;
    return pv >= 0 && pv === h.ensureVehicle(req) && !h.vehicleDestroyed(req);
  }

  /** Fail and report "not done", for objective checks. */
  private failed(reason: string): false {
    this.fail(reason);
    return false;
  }

  private dist(a: Pos | null, b: Pos | null): number {
    return a && b ? Math.hypot(a.x - b.x, a.z - b.z) : Infinity;
  }

  /** Check the objective's extra fail conditions. Returns a reason or null. */
  private failCondition(conds: FailCondition[] | undefined, dt: number): string | null {
    if (!conds) return null;
    const h = this.host;
    for (let i = 0; i < conds.length; i++) {
      const c = conds[i]!;
      switch (c.if) {
        case 'vehicleDestroyed':
          if (h.vehicleDestroyed(c.target)) return c.message ?? 'The car was wrecked';
          break;
        case 'actorKilled':
          if (h.actorDead(c.target)) return c.message ?? 'They were killed';
          break;
        case 'heatAtLeast':
          if (h.heatLevel() >= c.value) return c.message ?? 'Too much HEAT';
          break;
        case 'traceAtLeast':
          if (h.traceLevel() >= c.value) return c.message ?? 'You were traced';
          break;
        case 'onFoot':
          if (h.playerVehicle() < 0) return c.message ?? 'You left the car';
          break;
        case 'tooFar': {
          const far = this.dist(h.playerPos(), h.resolve(c.target)) > c.distance;
          const t = far ? (this.os.tooFar[i] ?? 0) + dt : 0;
          this.os.tooFar[i] = t;
          if (far && t > c.graceSec) return c.message ?? 'You left them behind';
          break;
        }
      }
    }
    return null;
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
      if (this.missionTime >= s.at) {
        this.scheduled.splice(i, 1);
        this.apply(s.event);
      }
    }
    if (this.state !== 'running') return;
    const h = this.host;
    if (o.timeLimitSec !== undefined && this.objectiveTime > o.timeLimitSec) return this.fail('Out of time');
    if (h.passengersLost()) return this.fail("Your passengers didn't make it");
    const why = this.failCondition(o.failOn, dt);
    if (why) return this.fail(why);
    if (this.check(o, dt)) this.completeObjective();
    else if (this.state === 'running') this.updateView();
  }

  /** Objective-specific progress. Returns true when the objective is done (and may fail it instead). */
  private check(o: Objective, dt: number): boolean {
    const h = this.host;
    const s = this.os;
    const p = h.playerPos();
    switch (o.type) {
      case 'reach':
        return this.inVehicle(o.vehicle) && this.dist(p, h.resolve(o.target)) <= o.radius;
      case 'hack':
        if (o.target.startsWith('spawn:') && h.vehicleDestroyed(o.target)) return this.failed('The target was destroyed');
        return s.hackDone;
      case 'deliverVehicle': {
        if (h.vehicleDestroyed(o.vehicle)) return this.failed('The car was wrecked');
        if (h.vehicleHealth(o.vehicle) < o.minHealth) return this.failed('The car is too damaged to sell');
        return this.inVehicle(o.vehicle) && this.dist(p, h.resolve(o.target)) <= o.radius;
      }
      case 'stealVehicle': {
        if (o.vehicle) {
          if (h.vehicleDestroyed(o.vehicle)) return this.failed('The car was wrecked');
          return this.inVehicle(o.vehicle);
        }
        const pv = h.playerVehicle();
        return pv >= 0 && o.variants!.includes(h.vehicleVariant(pv));
      }
      case 'destroyVehicle': {
        let n = 0;
        const escape = o.escapeAt ? h.resolve(o.escapeAt) : null;
        for (const t of o.targets) {
          if (h.vehicleDestroyed(t)) n++;
          else if (escape && this.dist(h.resolve(t), escape) < o.escapeRadius) return this.failed('A target got away');
        }
        s.count = n;
        return n >= (o.count ?? o.targets.length);
      }
      case 'eliminate': {
        let n = 0;
        for (const t of o.targets) if (h.actorDead(t)) n++;
        s.count = n;
        return n >= (o.count ?? o.targets.length);
      }
      case 'protect': {
        const vehicle = o.target.startsWith('spawn:');
        if (vehicle ? h.vehicleDestroyed(o.target) : h.actorDead(o.target)) return this.failed(vehicle ? 'They wrecked it' : 'They were killed');
        if (o.durationSec !== undefined) return this.objectiveTime >= o.durationSec;
        return this.dist(h.resolve(o.target), h.resolve(o.destination!)) <= o.radius;
      }
      case 'tail': {
        if (h.vehicleDestroyed(o.target)) return this.failed('The target was wrecked');
        const d = this.dist(p, h.resolve(o.target));
        s.t1 = d < o.minRange ? s.t1 + dt : Math.max(0, s.t1 - dt * 0.5);
        if (d <= o.maxRange) s.acquired = true;
        // No "lost them" until the player first closes in (e.g. just after a retry); after that, falling back loses them.
        s.t2 = d > o.maxRange && s.acquired ? s.t2 + dt : 0;
        if (s.t1 > o.tooCloseSec) return this.failed('They spotted you');
        if (s.t2 > o.lostSec) return this.failed('You lost them');
        return h.driverDone(o.target);
      }
      case 'chase': {
        const wrecked = h.vehicleDestroyed(o.target);
        if (wrecked) return true;
        if (o.catch === 'disable' && h.vehicleHealth(o.target) <= o.disableHealth) {
          if (!s.disabled) {
            s.disabled = true;
            h.drive(o.target, { mode: 'hold' });
          }
          return true;
        }
        const d = this.dist(p, h.resolve(o.target));
        s.t1 = d > o.escapeDistance ? s.t1 + dt : 0;
        if (s.t1 > o.escapeSec) return this.failed('They got away');
        return false;
      }
      case 'escape':
        return this.objectiveTime >= 1 && h.heatLevel() === 0;
      case 'race': {
        if (o.opponents) for (const r of o.opponents) if (!h.vehicleDestroyed(r) && h.driverDone(r)) return this.failed('Beaten to the line');
        const cp = h.resolve(o.checkpoints[s.idx]!);
        if (this.inVehicle(o.vehicle) && this.dist(p, cp) <= o.radius) s.idx++;
        return s.idx >= o.checkpoints.length;
      }
      case 'collect': {
        if (!this.inVehicle(o.vehicle)) return false;
        for (let i = 0; i < o.pickups.length; i++) {
          if (s.done[i]) continue;
          if (this.dist(p, h.resolve(o.pickups[i]!)) <= o.radius) {
            s.done[i] = true;
            s.count++;
          }
        }
        return s.count >= (o.count ?? o.pickups.length);
      }
      case 'wait': {
        const inside = this.inVehicle(o.vehicle) && this.dist(p, h.resolve(o.target)) <= o.radius;
        if (inside) s.t1 += dt;
        else if (o.resetOnLeave) s.t1 = 0;
        return s.t1 >= o.durationSec;
      }
      case 'dropOff':
        return this.inVehicle(o.vehicle) && this.dist(p, h.resolve(o.target)) <= o.radius && h.playerSpeed() <= o.maxSpeed;
      case 'photograph': {
        const vehicle = o.target.startsWith('spawn:');
        if (vehicle ? h.vehicleDestroyed(o.target) : h.actorDead(o.target)) return this.failed('The target is gone');
        const t = h.resolve(o.target);
        const ok = this.dist(p, t) <= o.range && t !== null && h.lineOfSight(p, t);
        s.t1 = ok ? s.t1 + dt : Math.max(0, s.t1 - dt);
        return s.t1 >= o.holdSec;
      }
      case 'perform':
        s.count = this.actions[o.action];
        return s.count >= o.count;
    }
  }

  private setTarget(pos: Pos | null, radius: number): void {
    this.view.targetX = pos?.x ?? 0;
    this.view.targetZ = pos?.z ?? 0;
    this.view.radius = radius;
  }

  private mark(pos: Pos | null): void {
    const v = this.view;
    if (!pos || v.markerCount >= MAX_MARKERS) return;
    const m = v.markers[v.markerCount++]!;
    m.x = pos.x;
    m.z = pos.z;
  }

  private updateView(): void {
    const o = this.objective;
    const v = this.view;
    if (!o) return;
    const h = this.host;
    const s = this.os;
    const p = h.playerPos();
    v.id = o.id;
    v.type = o.type;
    v.timeLeft = o.timeLimitSec !== undefined ? Math.max(0, o.timeLimitSec - this.objectiveTime) : null;
    v.vehicleId = -1;
    v.progress = null;
    v.meter = null;
    v.warning = null;
    v.markerCount = 0;
    let text = '';
    switch (o.type) {
      case 'reach':
        text = 'Get to the marker' + (o.vehicle === 'any' || o.vehicle === 'none' ? VEHICLE_TEXT[o.vehicle] : '');
        if (o.vehicle && !this.inVehicle(o.vehicle)) text = o.vehicle === 'none' ? 'Get out and go on foot' : o.vehicle === 'any' ? 'Get a car' : 'Get back in the car';
        if (o.vehicle?.startsWith('spawn:') && !this.inVehicle(o.vehicle)) this.setTarget(h.resolve(o.vehicle), 3);
        else this.setTarget(h.resolve(o.target), o.radius);
        break;
      case 'hack':
        text = o.target.startsWith('spawn:') ? 'Hack the car' : 'Hack the terminal';
        if (o.target.startsWith('spawn:')) v.vehicleId = h.ensureVehicle(o.target);
        this.setTarget(h.resolve(o.target), 3);
        break;
      case 'deliverVehicle': {
        v.vehicleId = h.ensureVehicle(o.vehicle);
        const health = Math.round(o.minHealth * 100);
        if (!this.inVehicle(o.vehicle)) {
          text = 'Get in the car';
          this.setTarget(h.resolve(o.vehicle), 3);
        } else {
          text = health > 0 ? `Deliver the car (keep it above ${health}%)` : 'Deliver the car';
          this.setTarget(h.resolve(o.target), o.radius);
        }
        break;
      }
      case 'stealVehicle':
        if (o.vehicle) {
          v.vehicleId = h.ensureVehicle(o.vehicle);
          text = 'Steal the car';
          this.setTarget(h.resolve(o.vehicle), 3);
        } else {
          const names = [...new Set(o.variants!.map((x) => h.variantName(x)))];
          text = `Steal a ${names.join(' or ')}`;
          const id = h.nearestVehicleOf(o.variants!, p.x, p.z);
          v.vehicleId = id;
          this.setTarget(id >= 0 ? h.vehiclePos(id) : null, 3);
        }
        break;
      case 'destroyVehicle': {
        const need = o.count ?? o.targets.length;
        text = need === 1 ? 'Wreck the target' : 'Wreck the targets';
        v.progress = need > 1 ? `${s.count}/${need}` : null;
        let best: Pos | null = null;
        for (const t of o.targets) {
          if (h.vehicleDestroyed(t)) continue;
          const tp = h.resolve(t);
          this.mark(tp);
          h.markAimTarget?.(t);
          if (this.dist(p, tp) < this.dist(p, best)) best = tp;
          if (v.vehicleId < 0) v.vehicleId = h.ensureVehicle(t);
        }
        this.setTarget(best, 4);
        break;
      }
      case 'eliminate': {
        const need = o.count ?? o.targets.length;
        text = need === 1 ? 'Take out the target' : 'Take out the targets';
        v.progress = need > 1 ? `${s.count}/${need}` : null;
        let best: Pos | null = null;
        for (const t of o.targets) {
          if (h.actorDead(t)) continue;
          const tp = h.resolve(t);
          this.mark(tp);
          if (this.dist(p, tp) < this.dist(p, best)) best = tp;
        }
        this.setTarget(best, 2);
        break;
      }
      case 'protect': {
        const vehicle = o.target.startsWith('spawn:');
        if (vehicle) {
          v.vehicleId = h.ensureVehicle(o.target);
          v.meter = h.vehicleHealth(o.target);
        }
        if (o.durationSec !== undefined) {
          text = vehicle ? 'Keep the car in one piece' : 'Keep them alive';
          v.timeLeft = Math.max(0, o.durationSec - this.objectiveTime);
          this.setTarget(h.resolve(o.target), 4);
        } else {
          text = 'Escort them to the drop';
          this.mark(h.resolve(o.destination!));
          this.setTarget(h.resolve(o.target), 4);
        }
        break;
      }
      case 'tail': {
        v.vehicleId = h.ensureVehicle(o.target);
        const d = this.dist(p, h.resolve(o.target));
        text = 'Tail the car. Keep your distance';
        v.meter = Math.max(0, Math.min(1, (d - o.minRange) / (o.maxRange - o.minRange)));
        if (d < o.minRange) v.warning = 'Too close!';
        else if (d > o.maxRange) v.warning = 'You are losing them';
        this.setTarget(h.resolve(o.target), 4);
        break;
      }
      case 'chase':
        v.vehicleId = h.ensureVehicle(o.target);
        h.markAimTarget?.(o.target);
        text = o.catch === 'wreck' ? 'Wreck the car' : 'Run them off the road';
        v.meter = h.vehicleHealth(o.target);
        if (s.t1 > 0) v.warning = 'They are getting away';
        this.setTarget(h.resolve(o.target), 4);
        break;
      case 'escape':
        text = 'Lose the HEAT';
        this.setTarget(null, 0);
        v.targetX = p.x;
        v.targetZ = p.z;
        break;
      case 'race': {
        const n = o.checkpoints.length;
        const i = Math.min(s.idx, n - 1);
        text = i === n - 1 ? 'Final checkpoint' : 'Next checkpoint';
        if (!this.inVehicle(o.vehicle)) text = 'Get a car';
        v.progress = `${s.idx}/${n}`;
        this.setTarget(h.resolve(o.checkpoints[i]!), o.radius);
        if (i + 1 < n) this.mark(h.resolve(o.checkpoints[i + 1]!));
        break;
      }
      case 'collect': {
        const need = o.count ?? o.pickups.length;
        text = 'Collect the drops';
        if (o.vehicle && !this.inVehicle(o.vehicle)) text = o.vehicle === 'none' ? 'Collect them on foot' : 'Get back in the car';
        v.progress = `${s.count}/${need}`;
        let best: Pos | null = null;
        for (let i = 0; i < o.pickups.length; i++) {
          if (s.done[i]) continue;
          const pp = h.resolve(o.pickups[i]!);
          this.mark(pp);
          if (this.dist(p, pp) < this.dist(p, best)) best = pp;
        }
        this.setTarget(best, o.radius);
        break;
      }
      case 'wait': {
        const left = Math.max(0, o.durationSec - s.t1);
        text = this.dist(p, h.resolve(o.target)) <= o.radius ? 'Hold here' : 'Get to the marker and wait';
        if (o.vehicle && !this.inVehicle(o.vehicle)) text = o.vehicle === 'none' ? 'Wait on foot' : 'Wait in the car';
        v.meter = s.t1 / o.durationSec;
        v.progress = `${Math.ceil(left)} s`;
        this.setTarget(h.resolve(o.target), o.radius);
        break;
      }
      case 'dropOff':
        text = this.inVehicle(o.vehicle) ? 'Drop them off' : 'Get back in the car';
        if (this.inVehicle(o.vehicle) && this.dist(p, h.resolve(o.target)) <= o.radius && h.playerSpeed() > o.maxSpeed) v.warning = 'Slow down';
        this.setTarget(h.resolve(o.target), o.radius);
        break;
      case 'photograph': {
        text = 'Get a clear shot of them';
        v.meter = s.t1 / o.holdSec;
        const t = h.resolve(o.target);
        if (this.dist(p, t) > o.range) v.warning = 'Get closer';
        this.setTarget(t, 3);
        break;
      }
      case 'perform': {
        const labels: Record<PerformAction, string> = { dodge: 'Dodge', fire: 'Fire', enter: 'Get in a car', exit: 'Get out of the car' };
        text = labels[o.action];
        if (o.count > 1) v.progress = `${s.count}/${o.count}`;
        this.setTarget(null, 0);
        v.targetX = p.x;
        v.targetZ = p.z;
        break;
      }
    }
    v.text = o.text ?? text;
  }
}
