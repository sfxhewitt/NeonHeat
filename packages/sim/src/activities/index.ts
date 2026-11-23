import type { World } from '../world';
import type { Intents } from '../intents';
import type { ActivitiesConfig } from './config';
import type { ActivitySites } from './placement';
import { JumpSystem } from './jumps';
import { RampageSystem } from './rampage';
import { ShardSystem } from './shards';
import { FareSystem } from './fares';
import { RaceSystem } from './races';
import { emptyProgress, type ActivityProgress } from './progress';

export * from './config';
export * from './placement';
export * from './jumps';
export * from './rampage';
export * from './shards';
export * from './fares';
export * from './races';
export * from './progress';
export * from './events';

/** What the activity button would do now. */
export interface ActivityPrompt {
  label: string;
  action: 'race' | 'duty' | 'endShift';
  id: string;
}

export interface ActivityContent {
  config: ActivitiesConfig;
  sites: ActivitySites;
}

/**
 * The side activities that fill free roam: rampages, stunt jumps, data shards,
 * taxi and courier fares, and street races. One activity runs at a time; all of
 * them stand down while a job runs (the app clears `enabled`), except shards and
 * ramps, which are always there. Progress lives in `progress`, which the app
 * loads from and copies into the save.
 */
export class ActivitySystem {
  readonly config: ActivitiesConfig | null;
  readonly sites: ActivitySites;
  progress: ActivityProgress = emptyProgress();
  /** False while a job runs: no new activity starts, and a running one is called off. */
  enabled = true;
  prompt: ActivityPrompt | null = null;
  readonly jumps: JumpSystem;
  readonly rampages: RampageSystem;
  readonly shards: ShardSystem;
  readonly fares: FareSystem;
  readonly races: RaceSystem;
  private readonly promptObj: ActivityPrompt = { label: '', action: 'duty', id: '' };

  constructor(
    private readonly world: World,
    content: ActivityContent | null,
  ) {
    this.config = content?.config ?? null;
    this.sites = content?.sites ?? { ramps: [], tokens: [], shards: [], flags: [] };
    const cfg = this.config ?? FALLBACK;
    const p = (): ActivityProgress => this.progress;
    this.jumps = new JumpSystem(world, cfg.jumps, this.sites.ramps, p);
    this.rampages = new RampageSystem(world, cfg.rampages, this.sites.tokens, p);
    this.shards = new ShardSystem(world, cfg.shards, this.sites.shards, p);
    this.fares = new FareSystem(world, this.config ? cfg.fares : {}, p);
    this.races = new RaceSystem(world, cfg.races, this.sites.flags, cfg.seed, p);
  }

  /** Replace the progress (after loading a save). */
  load(p: ActivityProgress): void {
    this.progress = { rampages: { ...p.rampages }, jumps: { ...p.jumps }, shards: [...p.shards], races: { ...p.races }, fares: { ...p.fares } };
    this.shards.sync();
  }

  /** The activity running now, if any. */
  get current(): 'rampage' | 'race' | 'fare' | null {
    if (this.rampages.run) return 'rampage';
    if (this.races.run) return 'race';
    if (this.fares.shift) return 'fare';
    return null;
  }

  /** Call off whatever is running (a job started, or the app asked). */
  cancel(reason = 'A job came up'): void {
    this.rampages.cancel();
    this.races.cancel();
    this.fares.endShift(reason);
  }

  /** Pre-physics: the race grid is held during the countdown. */
  preStep(): void {
    this.races.preStep();
  }

  /** After the world has moved: activities read this step's events and the player's position. */
  step(dt: number, intents: Intents): void {
    if (!this.config) return;
    if (!this.enabled && this.current) this.cancel();
    this.shards.step();
    this.rampages.step(dt);
    this.races.step(dt);
    this.fares.step(dt);
    this.updatePrompt();
    if (intents.activity && this.prompt) this.act(this.prompt);
    else if (this.enabled && !this.current && !this.world.playerCtl.dead) this.rampages.tryStart();
  }

  private act(p: ActivityPrompt): void {
    if (p.action === 'race') this.races.start(p.id);
    else if (p.action === 'duty') this.fares.startShift(p.id);
    else this.fares.endShift('Shift ended');
    this.updatePrompt();
  }

  private updatePrompt(): void {
    const w = this.world;
    const o = this.promptObj;
    this.prompt = null;
    if (w.playerCtl.dead || w.playerCtl.busted) return;
    if (this.fares.shift) {
      if (w.player.vehicle?.id !== this.fares.shift.vehicleId) return;
      o.label = 'END SHIFT';
      o.action = 'endShift';
      o.id = this.fares.shift.job;
      this.prompt = o;
      return;
    }
    if (!this.enabled || this.current) return;
    const v = w.player.vehicle;
    if (!v) return;
    const flag = this.races.flagHere();
    if (flag && Math.hypot(v.vx, v.vz) < 6) {
      o.label = 'RACE';
      o.action = 'race';
      o.id = flag.id;
      this.prompt = o;
      return;
    }
    const job = this.fares.jobFor(v);
    if (job) {
      o.label = this.fares.jobs[job]!.startLabel;
      o.action = 'duty';
      o.id = job;
      this.prompt = o;
    }
  }
}

/** Used when no activities content is loaded: everything empty, nothing placed. */
const FALLBACK: ActivitiesConfig = {
  seed: 0,
  rampages: { radius: 2, cooldownSec: 1, readySec: 0, countRange: 100, defs: [] },
  jumps: {
    gravity: 15,
    launchBoost: 1,
    clearHeight: 1,
    airDrag: 0,
    airYawDamp: 0,
    landing: { speedKeep: 1, hardSpeed: 10, damagePerMs: 0 },
    ramp: { width: 5, up: 8, deck: 2, down: 5, height: 1.6 },
    reward: { minDistance: 0, base: 0, perMetre: 0, perAirSecond: 0, unique: 0 },
    slowMo: { minAirSec: 9, scale: 1, sec: 0, heightScale: 1 },
    perDistrict: {},
    runUp: 40,
    landingRun: 60,
    spawnClear: 0,
    targetSpeed: 30,
    targetFraction: 1,
  },
  shards: { count: 1, radius: 1, milestone: 10, milestoneReward: 0, reward: 0, minSpacing: 0, mix: { pavement: 1, alley: 0, park: 0, lot: 0, edge: 0 }, revealRange: 0 },
  fares: {},
  races: { checkpointRadius: 12, checkpointSpacing: 150, countdownSec: 3, flagRadius: 8, abandonDistance: 400, leaveSec: 5, defs: [] },
};
