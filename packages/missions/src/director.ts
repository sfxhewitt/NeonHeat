import type { World } from '@neonheat/sim';
import { HackSession } from './hack';
import { WorldMissionHost } from './host';
import { markerPos, splitRef } from './refs';
import { MissionRunner } from './runner';
import type { Crews, Dialogue, Mission, Squads } from './schema';

export interface DirectorOptions {
  /** Retry from checkpoint automatically after a failure (bots and soak tests). */
  autoRetry?: boolean;
  giverRadius?: number;
  /** Crew colours and names, for the payphones. */
  crews?: Crews;
}

/** What the player has done so far: drives which payphones ring. */
export interface MissionProgress {
  completed: readonly string[];
  /** Respect with each crew. */
  respect: Readonly<Record<string, number>>;
}

/** Everything the completion card shows. */
export interface MissionResult {
  mission: Mission;
  missionId: string;
  title: string;
  crew: string;
  story: boolean;
  attempts: number;
  /** Mission time of the successful run, in seconds. */
  seconds: number;
  damage: {
    /** Health the player lost on foot (points). */
    health: number;
    /** Hull damage taken by cars the player drove, in whole cars (1 = one car's worth). */
    hull: number;
  };
  pay: { base: number; bonus: number; total: number };
  /** Respect change per crew. */
  respect: Record<string, number>;
  unlocks: string[];
}

/** A ringing payphone. */
export interface GiverView {
  missionId: string;
  title: string;
  summary: string;
  crew: string;
  /** Crew colour (#rrggbb), cyan if unknown. */
  colour: string;
  story: boolean;
  x: number;
  z: number;
}

const DEFAULT_COLOUR = '#2bf0ff';

/** True when a mission's prerequisites are met (ignores whether it is already done). */
export function prerequisitesMet(m: Mission, p: MissionProgress): boolean {
  const pre = m.prerequisites;
  if (!pre) return true;
  for (const id of pre.missions ?? []) if (!p.completed.includes(id)) return false;
  for (const [crew, min] of Object.entries(pre.respect ?? {})) if ((p.respect[crew] ?? 0) < min) return false;
  return true;
}

/** Order for picking between missions: story first, then chain order, then id. */
export function missionOrder(a: Mission, b: Mission): number {
  if (a.story !== b.story) return a.story ? -1 : 1;
  const ca = a.chain ?? 99;
  const cb = b.chain ?? 99;
  return ca !== cb ? ca - cb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Owns mission pickup (one ringing payphone per available job, in its crew's
 * colour), the active MissionRunner, the hack minigame session, failure
 * handling and the completion result. Ticks at sim rate.
 */
export class MissionDirector {
  readonly host: WorldMissionHost;
  runner: MissionRunner | null = null;
  hack: HackSession | null = null;
  /** The hack target: a vehicle id, or -1 with hackTerminal set. */
  private hackVehicle = -1;
  private hackTerminal: string | null = null;
  readonly completed: MissionResult[] = [];
  readonly givers: GiverView[] = [];
  private progress: { completed: string[]; respect: Record<string, number> } = { completed: [], respect: {} };
  onComplete: ((r: MissionResult) => void) | null = null;
  onFail: ((reason: string) => void) | null = null;
  onHackStart: ((h: HackSession) => void) | null = null;
  onHackEnd: ((success: boolean) => void) | null = null;
  onStart: ((m: Mission) => void) | null = null;
  /** The ringing payphones changed. */
  onGiversChanged: ((g: readonly GiverView[]) => void) | null = null;
  private retryTimer = -1;
  private damageHealth = 0;
  private damageHull = 0;
  private lastVehicle = -1;
  private lastHp = 0;
  private readonly warned = new Set<string>();
  /** Problems found at run time (payphones off the map), for the log. */
  readonly warnings: string[] = [];
  onWarning: ((message: string) => void) | null = null;

  constructor(
    readonly world: World,
    readonly missions: Mission[],
    squads: Squads,
    dialogue: Dialogue,
    private readonly options: DirectorOptions = {},
  ) {
    this.host = new WorldMissionHost(world, squads, dialogue);
    this.placeGivers();
  }

  get active(): boolean {
    return this.runner !== null && (this.runner.state === 'running' || this.runner.state === 'failed');
  }

  /** Load progress from a save. Payphones update at once. */
  setProgress(p: MissionProgress): void {
    this.progress = { completed: [...p.completed], respect: { ...p.respect } };
    this.world.gangs.setAllRespect(this.progress.respect);
    this.placeGivers();
  }

  getProgress(): MissionProgress {
    return this.progress;
  }

  /** Where a mission's payphone is, or null if its marker is not on this map. */
  giverPos(m: Mission): { x: number; z: number } | null {
    if (m.giver.pos) return { x: m.giver.pos[0], z: m.giver.pos[2] };
    const p = markerPos(this.world.content.map, splitRef(m.giver.at!)[1]);
    if (!p && !this.warned.has(m.id)) {
      this.warned.add(m.id);
      const msg = `Mission ${m.id}: payphone ${m.giver.at} is not on this map`;
      this.warnings.push(msg);
      this.onWarning?.(msg);
    }
    return p;
  }

  /** Jobs the player can take now: prerequisites met, not done, payphone on the map. */
  available(): Mission[] {
    return this.missions.filter((m) => !this.progress.completed.includes(m.id) && prerequisitesMet(m, this.progress) && this.giverPos(m) !== null).sort(missionOrder);
  }

  private placeGivers(): void {
    const list = this.world.interactables;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.id.startsWith('giver:')) list.splice(i, 1);
    this.givers.length = 0;
    if (!this.active) {
      // One job per payphone: the most important one rings, the others wait their turn.
      const taken = new Set<string>();
      for (const m of this.available()) {
        const p = this.giverPos(m)!;
        const key = `${Math.round(p.x)},${Math.round(p.z)}`;
        if (taken.has(key)) continue;
        taken.add(key);
        const crew = this.options.crews?.[m.faction];
        this.givers.push({ missionId: m.id, title: m.title, summary: m.summary ?? '', crew: m.faction, colour: crew?.colour ?? DEFAULT_COLOUR, story: m.story, x: p.x, z: p.z });
        list.push({ id: `giver:${m.id}`, x: p.x, z: p.z, radius: this.options.giverRadius ?? 3, label: 'ANSWER' });
      }
    }
    this.onGiversChanged?.(this.givers);
  }

  start(id: string): void {
    const m = this.missions.find((x) => x.id === id);
    if (!m) throw new Error(`Unknown mission "${id}"`);
    this.host.cleanup();
    this.host.resetVehicles();
    this.host.setMission(m);
    this.damageHealth = 0;
    this.damageHull = 0;
    this.lastVehicle = -1;
    this.runner = new MissionRunner(m, this.host);
    this.runner.onFail = (reason) => {
      this.closeHack(false, false);
      this.onFail?.(reason);
      if (this.options.autoRetry) this.retryTimer = 2;
    };
    this.runner.onComplete = (mission) => this.finish(mission);
    this.runner.start();
    this.placeGivers();
    this.onStart?.(m);
  }

  private finish(mission: Mission): void {
    this.closeHack(false, false);
    const r = this.runner!;
    const rw = mission.rewards;
    const bonus = rw.timeBonus && r.missionTime <= rw.timeBonus.underSec ? rw.timeBonus.credits : 0;
    const result: MissionResult = {
      mission,
      missionId: mission.id,
      title: mission.title,
      crew: mission.faction,
      story: mission.story,
      attempts: r.attempts,
      seconds: r.missionTime,
      damage: { health: Math.round(this.damageHealth), hull: Math.round(this.damageHull * 100) / 100 },
      pay: { base: rw.credits, bonus, total: rw.credits + bonus },
      respect: { ...rw.rep },
      unlocks: [...(rw.unlocks ?? [])],
    };
    this.completed.push(result);
    if (!this.progress.completed.includes(mission.id)) this.progress.completed.push(mission.id);
    for (const [crew, v] of Object.entries(rw.rep)) this.progress.respect[crew] = (this.progress.respect[crew] ?? 0) + v;
    // Street crews react to the new standing straight away.
    this.world.gangs.setAllRespect(this.progress.respect);
    this.host.releaseAll();
    this.host.setMission(null);
    this.placeGivers();
    this.onComplete?.(result);
  }

  retry(): void {
    if (!this.runner || this.runner.state !== 'failed') return;
    if (this.runner.mission.failPolicy === 'restart') this.runner.restart();
    else this.runner.retry();
  }

  restart(): void {
    if (!this.runner) return;
    this.closeHack(false, false);
    if (this.runner.state === 'failed' || this.runner.state === 'running') {
      this.runner.state = 'failed';
      this.runner.restart();
    }
  }

  abandon(): void {
    this.closeHack(false, false);
    this.runner?.abandon();
    this.runner = null;
    this.host.releaseAll();
    this.host.setMission(null);
    this.placeGivers();
  }

  /** The UI (or a bot) taps a hack node. */
  hackTap(node: number): void {
    this.hack?.tap(node);
  }

  private closeHack(success: boolean, report: boolean): void {
    if (!this.hack) return;
    const v = this.hackVehicle >= 0 ? this.world.vehicles[this.hackVehicle] : undefined;
    this.hack = null;
    this.hackVehicle = -1;
    this.hackTerminal = null;
    if (report) this.runner?.reportHack(success);
    if (success && v) v.locked = false;
    this.onHackEnd?.(success);
  }

  private openHack(difficulty: number, vehicle: number, terminal: string | null): void {
    this.hack = new HackSession(this.world.rng, difficulty);
    this.hackVehicle = vehicle;
    this.hackTerminal = terminal;
    this.onHackStart?.(this.hack);
  }

  /** Call after each world.step with the step's dt. */
  tick(dt: number): void {
    const w = this.world;
    const r = this.runner;
    const running = r?.state === 'running';
    for (const e of w.events) {
      if (e.type === 'enteredVehicle') {
        this.host.noteEntered(e.vehicleId);
        if (running) r.noteAction('enter');
      } else if (e.type === 'exitedVehicle') {
        if (running) r.noteAction('exit');
      } else if (e.type === 'dodge') {
        if (running) r.noteAction('dodge');
      } else if (e.type === 'shot') {
        if (running && !w.player.vehicle && Math.hypot(e.x - w.playerCtl.x, e.z - w.playerCtl.z) < 1.5) r.noteAction('fire');
      } else if (e.type === 'playerHurt') {
        if (running) this.damageHealth += e.amount;
      } else if (e.type === 'playerDied') {
        if (running) r.failWith('You went down. The job went with you.');
      } else if (e.type === 'playerBusted') {
        if (running) r.failWith('Booked. The job is blown.');
      } else if (e.type === 'interact' && e.id.startsWith('giver:') && !this.active) {
        this.start(e.id.slice('giver:'.length));
      } else if (e.type === 'interact' && e.id.startsWith('terminal:') && !this.hack && running) {
        const o = r.objective;
        const key = e.id.slice('terminal:'.length);
        if (o?.type === 'hack' && o.id === key) this.openHack(o.difficulty, -1, key);
      } else if (e.type === 'hackRequested' && !this.hack && running) {
        const o = r.objective;
        if (o?.type === 'hack' && o.target.startsWith('spawn:') && this.host.ensureVehicle(o.target) === e.vehicleId) this.openHack(o.difficulty, e.vehicleId, null);
      }
    }
    if (this.runner?.state === 'running') this.trackHull();
    if (this.hack) {
      this.hack.tick(dt);
      // Walking away or getting knocked down cancels the hack.
      const v = this.hackVehicle >= 0 ? w.vehicles[this.hackVehicle] : undefined;
      const t = this.hackTerminal ? this.host.terminalPos(this.hackTerminal) : v ? { x: v.x, z: v.z } : null;
      const far = !t || Math.hypot(t.x - w.player.x, t.z - w.player.z) > 8 || w.playerCtl.dead;
      if (this.hack.done) this.closeHack(this.hack.phase === 'success', true);
      else if (far) this.closeHack(false, true);
    }
    if (this.retryTimer > 0) {
      this.retryTimer -= dt;
      if (this.retryTimer <= 0) {
        this.retryTimer = -1;
        this.retry();
      }
    }
    this.host.update();
    this.runner?.tick(dt);
  }

  /** Hull damage on whatever car the player is driving. */
  private trackHull(): void {
    const v = this.world.player.vehicle;
    if (!v) {
      this.lastVehicle = -1;
      return;
    }
    if (v.id === this.lastVehicle && v.hp < this.lastHp) this.damageHull += (this.lastHp - v.hp) / v.params.maxHealth;
    this.lastVehicle = v.id;
    this.lastHp = v.hp;
  }
}
