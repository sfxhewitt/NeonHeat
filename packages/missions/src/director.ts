import type { World } from '@neonheat/sim';
import { HackSession } from './hack';
import { WorldMissionHost } from './host';
import { MissionRunner } from './runner';
import type { Dialogue, Mission, Squads } from './schema';

export interface DirectorOptions {
  /** Retry from checkpoint automatically after a failure (bots and soak tests). */
  autoRetry?: boolean;
  giverRadius?: number;
}

export interface MissionResult {
  mission: Mission;
  attempts: number;
  seconds: number;
}

/**
 * Owns mission pickup (payphone markers), the active MissionRunner, the hack
 * minigame session, and failure handling. Ticks at sim rate.
 */
export class MissionDirector {
  readonly host: WorldMissionHost;
  runner: MissionRunner | null = null;
  hack: HackSession | null = null;
  private hackVehicle = -1;
  readonly completed: MissionResult[] = [];
  onComplete: ((r: MissionResult) => void) | null = null;
  onFail: ((reason: string) => void) | null = null;
  onHackStart: ((h: HackSession) => void) | null = null;
  onHackEnd: ((success: boolean) => void) | null = null;
  onStart: ((m: Mission) => void) | null = null;
  private retryTimer = -1;

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

  private placeGivers(): void {
    const list = this.world.interactables;
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.id.startsWith('giver:')) list.splice(i, 1);
    if (this.active) return;
    for (const m of this.missions) {
      list.push({ id: `giver:${m.id}`, x: m.giver.pos[0], z: m.giver.pos[2], radius: this.options.giverRadius ?? 3, label: 'ANSWER' });
    }
  }

  start(id: string): void {
    const m = this.missions.find((x) => x.id === id);
    if (!m) throw new Error(`Unknown mission "${id}"`);
    this.host.cleanup();
    this.host.resetVehicles();
    this.runner = new MissionRunner(m, this.host);
    this.runner.onFail = (reason) => {
      this.closeHack(false, false);
      this.onFail?.(reason);
      if (this.options.autoRetry) this.retryTimer = 2;
    };
    this.runner.onComplete = (mission) => {
      this.closeHack(false, false);
      const r = { mission, attempts: this.runner!.attempts, seconds: this.runner!.missionTime };
      this.completed.push(r);
      this.placeGivers();
      this.onComplete?.(r);
    };
    this.runner.start();
    this.placeGivers();
    this.onStart?.(m);
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
    this.placeGivers();
  }

  /** The UI (or a bot) taps a hack node. */
  hackTap(node: number): void {
    this.hack?.tap(node);
  }

  private closeHack(success: boolean, report: boolean): void {
    if (!this.hack) return;
    const v = this.world.vehicles[this.hackVehicle];
    this.hack = null;
    this.hackVehicle = -1;
    if (report) this.runner?.reportHack(success);
    if (success && v) v.locked = false;
    this.onHackEnd?.(success);
  }

  /** Call after each world.step with the step's dt. */
  tick(dt: number): void {
    const w = this.world;
    for (const e of w.events) {
      if (e.type === 'enteredVehicle') this.host.noteEntered(e.vehicleId);
      else if (e.type === 'interact' && e.id.startsWith('giver:') && !this.active) {
        this.start(e.id.slice('giver:'.length));
      } else if (e.type === 'hackRequested' && !this.hack && this.runner?.state === 'running') {
        const o = this.runner.objective;
        if (o?.type === 'hack' && this.host.ensureVehicle(o.target) === e.vehicleId) {
          this.hack = new HackSession(w.rng, o.difficulty);
          this.hackVehicle = e.vehicleId;
          this.onHackStart?.(this.hack);
        }
      }
    }
    if (this.hack) {
      this.hack.tick(dt);
      // Walking away or getting knocked down cancels the hack.
      const v = w.vehicles[this.hackVehicle];
      const far = !v || Math.hypot(v.x - w.player.x, v.z - w.player.z) > 8 || w.playerCtl.dead;
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
    this.runner?.tick(dt);
  }
}
