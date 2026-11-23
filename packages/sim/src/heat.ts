import { z } from 'zod';

/** Every crime the player can commit. Heat points and score credits per kind live in heat.json. */
export const CRIME_KINDS = [
  'gunfire',
  'assault',
  'hitPed',
  'killPed',
  'hitCivCar',
  'carjack',
  'carjackPolice',
  'ramPolice',
  'shootPolice',
  'killCop',
  'destroyVehicle',
  'destroyPolice',
] as const;
export type CrimeKind = (typeof CRIME_KINDS)[number];

const CrimeSchema = z.object({
  /** HEAT points when witnessed. */
  heat: z.number().nonnegative(),
  /** Score credits (before the chain multiplier). */
  credits: z.number().nonnegative(),
  /** Repeats of this crime within the cooldown add no further HEAT (a burst of fire is one offence). */
  cooldownSec: z.number().nonnegative().default(0),
});

const crimeShape = Object.fromEntries(CRIME_KINDS.map((k) => [k, CrimeSchema])) as Record<CrimeKind, typeof CrimeSchema>;

export const HeatLevelSchema = z.object({
  /** Patrol cars hunting the player at this level. */
  units: z.number().int().nonnegative(),
  /** Vehicle variants dispatched, picked in turn. */
  variants: z.array(z.string()).min(1),
  /** investigate: follow and stop you; pursue: chase, box in and PIT. */
  tactic: z.enum(['none', 'investigate', 'pursue']),
  /** Seconds out of sight (and outside the search radius) before dropping a level. */
  decaySec: z.number().positive(),
  /** Search radius around the last known position. 0 = not used. */
  searchRadius: z.number().nonnegative(),
  drone: z.boolean(),
  /** Officers on foot open fire on an on-foot player. */
  officersShoot: z.boolean(),
  roadblocks: z.boolean(),
  spikes: z.boolean(),
  /** Officers each car puts on the street. */
  officersPerCar: z.number().int().nonnegative(),
  /** Officers from this level's first listed variant are tactical (armoured, rifles). */
  tactical: z.boolean().default(false),
});
export type HeatLevel = z.infer<typeof HeatLevelSchema>;

export const OfficerConfigSchema = z.object({
  pool: z.number().int().positive(),
  radius: z.number().positive(),
  mass: z.number().positive(),
  hp: z.number().positive(),
  tacticalHp: z.number().positive(),
  runSpeed: z.number().positive(),
  /** Police cars stop and deploy officers within this distance of the player. */
  deployDist: z.number().positive(),
  /** ...once the car is slower than this (m/s). */
  deploySpeed: z.number().positive(),
  arrestRange: z.number().positive(),
  /** On foot, moving slower than this lets an adjacent officer cuff you. */
  arrestMaxPlayerSpeed: z.number().positive(),
  arrestSec: z.number().positive(),
  /** An officer this close to a slow player car pulls the driver out. */
  carArrestRange: z.number().positive(),
  carArrestMaxSpeed: z.number().positive(),
  /** Officers give up and walk back to their car beyond this distance. */
  returnDist: z.number().positive(),
  boardDist: z.number().positive(),
  sightRange: z.number().positive(),
  shootRange: z.number().positive(),
  /** Officers stop running this far out and shoot instead. */
  shootStandDist: z.number().nonnegative(),
  fireIntervalSec: z.number().positive(),
  damage: z.number().nonnegative(),
  tacticalDamage: z.number().nonnegative(),
  spreadDeg: z.number().nonnegative(),
  spreadPerMetreDeg: z.number().nonnegative(),
  /** Extra spread against a moving target, degrees per m/s. */
  moveSpreadDeg: z.number().nonnegative(),
  firstShotDelaySec: z.number().nonnegative(),
  knockdownSpeed: z.number().positive(),
  hitDamagePerMs: z.number().nonnegative(),
  despawnDist: z.number().positive(),
  downSec: z.number().positive(),
});
export type OfficerConfig = z.infer<typeof OfficerConfigSchema>;

export const HeatConfigSchema = z.object({
  maxLevel: z.number().int().min(1).max(5),
  /** Points needed to reach each level, index = level. thresholds[0] must be 0. */
  thresholds: z.array(z.number().nonnegative()).length(6),
  crimes: z.object(crimeShape),
  /** Behaviour per level, index = level (0 = clean). */
  levels: z.array(HeatLevelSchema).length(6),
  witness: z.object({
    /** A pedestrian this close with line of sight sees a crime... */
    pedRadius: z.number().positive(),
    /** ...and calls it in after this long, if still standing. */
    callDelaySec: z.number().nonnegative(),
    /** Share of a crime's HEAT that counts straight away when nobody saw it. */
    unwitnessedFraction: z.number().min(0).max(1),
    /** Unwitnessed crimes alone never push HEAT past this level. */
    unwitnessedMaxLevel: z.number().int().min(0).max(5),
    maxPending: z.number().int().positive(),
  }),
  /** Repeated-offence window: car hits only count once this many happen within the window. */
  repeatWindowSec: z.number().positive(),
  civCarHitsToCount: z.number().int().positive(),
  pedHitsToCount: z.number().int().positive(),
  ramMinStrength: z.number().nonnegative(),
  /** Getting into a different car after this long unseen drops a level (once per sighting). */
  carSwapUnseenSec: z.number().nonnegative(),
  respray: z.object({ maxLevel: z.number().int().min(0).max(5), radius: z.number().positive(), maxSpeed: z.number().positive(), unseenSec: z.number().nonnegative() }),
  sightRange: z.number().positive(),
  droneSightRange: z.number().positive(),
  droneSpeed: z.number().positive(),
  droneAltitude: z.number().positive(),
  spawnMinDist: z.number().positive(),
  spawnMaxDist: z.number().positive(),
  spawnIntervalSec: z.number().positive(),
  /** Spawn points must lie outside this box around the player (roughly what the camera shows). */
  screen: z.object({ halfWidth: z.number().nonnegative(), north: z.number().nonnegative(), south: z.number().nonnegative() }),
  despawnDist: z.number().positive(),
  aiHz: z.number().positive(),
  ramDistance: z.number().positive(),
  lookAheadSec: z.number().nonnegative(),
  stuckSec: z.number().positive(),
  reverseSec: z.number().positive(),
  pursuit: z.object({
    /** Inside this distance pursuers match the player's speed plus closingSpeed, so contact is a shove, not a crash. */
    matchSpeedDist: z.number().positive(),
    closingSpeed: z.number().nonnegative(),
    /** Against an on-foot player, cars pull up this far away. */
    footStopDist: z.number().positive(),
    pitDist: z.number().positive(),
    flankOffset: z.number().nonnegative(),
    cutoffLeadSec: z.number().nonnegative(),
    followDist: z.number().nonnegative(),
    boxInRadius: z.number().positive(),
    boxInSpeed: z.number().positive(),
    boxInUnits: z.number().int().positive(),
    boxInBustSec: z.number().positive(),
  }),
  /** Police cars hitting the player's car: damage is scaled, capped per hit and rate-limited. */
  ramDamage: z.object({
    mul: z.number().nonnegative(),
    maxPerHit: z.number().nonnegative(),
    cooldownSec: z.number().nonnegative(),
    /** Hits within this long of a police contact (shoved into a wall) are capped the same way. */
    knockOnSec: z.number().nonnegative(),
    /** ...as are hits with a patrol car within this distance. */
    knockOnDist: z.number().nonnegative(),
  }),
  /** Police cars hitting the player on foot. */
  footHitMul: z.number().nonnegative(),
  officers: OfficerConfigSchema,
  roadblocks: z.object({
    intervalSec: z.number().positive(),
    maxActive: z.number().int().nonnegative(),
    minDist: z.number().positive(),
    maxDist: z.number().positive(),
    minPlayerSpeed: z.number().nonnegative(),
    lifetimeSec: z.number().positive(),
    variant: z.string(),
    /** Minimum alignment of the block with the player's direction of travel (cosine). */
    alignDot: z.number().min(-1).max(1),
    /** Spike strip this far before the block, towards the player. */
    spikeOffset: z.number().nonnegative(),
  }),
  spikes: z.object({
    pool: z.number().int().positive(),
    length: z.number().positive(),
    width: z.number().positive(),
    gripMul: z.number().positive(),
    latGripMul: z.number().positive(),
    topSpeedMul: z.number().positive(),
    accelMul: z.number().positive(),
    lifetimeSec: z.number().positive(),
  }),
  /** TRACE (0-100 % net trace) bleeds off at this rate. */
  traceDecayPerSec: z.number().nonnegative(),
});
export type HeatConfig = z.infer<typeof HeatConfigSchema>;

/**
 * HEAT: the wanted level, 0..maxLevel chevrons. Pure state machine.
 *
 * - Witnessed crimes add their full points; unwitnessed ones add a fraction and
 *   can never push HEAT past `witness.unwitnessedMaxLevel` on their own.
 * - While any unit sees the player, the last known position is refreshed.
 * - Out of sight for the level's `decaySec` (and, where the level has one,
 *   outside the search radius around the last known position) drops one level.
 */
export class Heat {
  level = 0;
  points = 0;
  unseenTime = 0;
  seen = false;
  lastKnownX = 0;
  lastKnownZ = 0;
  private civHits: number[] = [];
  private pedHits: number[] = [];

  constructor(public config: HeatConfig) {}

  get levelConfig(): HeatLevel {
    return this.config.levels[this.level]!;
  }

  get searchRadius(): number {
    return this.levelConfig.searchRadius;
  }

  get decaySeconds(): number {
    return this.levelConfig.decaySec;
  }

  /** 0..1 progress towards the next decay step (for UI). */
  get decayProgress(): number {
    return this.level === 0 ? 0 : Math.min(1, this.unseenTime / this.decaySeconds);
  }

  /** A witnessed crime: full points, and the police know where you are. */
  addPoints(n: number, x: number, z: number): void {
    if (n <= 0) return;
    this.points += n;
    this.lastKnownX = x;
    this.lastKnownZ = z;
    this.unseenTime = 0;
    this.recomputeLevel();
  }

  /**
   * An unwitnessed crime: points count, but only up to the cap level, and the
   * police only learn roughly where it happened if they were not already looking.
   */
  addUnwitnessed(n: number, x: number, z: number): void {
    if (n <= 0) return;
    const capLevel = Math.min(this.config.maxLevel, this.config.witness.unwitnessedMaxLevel);
    const next = this.config.thresholds[capLevel + 1];
    const cap = capLevel >= this.config.maxLevel || next === undefined ? Infinity : next - 0.001;
    const before = this.level;
    if (this.points < cap) {
      this.points = Math.min(cap, this.points + n);
      this.recomputeLevel();
    }
    // Fresh reports of trouble keep a low-level search going where it happened.
    if (this.level > 0 && (before === 0 || this.level <= capLevel)) {
      this.lastKnownX = x;
      this.lastKnownZ = z;
      this.unseenTime = 0;
    }
  }

  setLevel(level: number, x: number, z: number): void {
    const l = Math.max(0, Math.min(this.config.maxLevel, Math.round(level)));
    this.level = l;
    this.points = this.config.thresholds[l]!;
    this.lastKnownX = x;
    this.lastKnownZ = z;
    this.unseenTime = 0;
    this.seen = l > 0;
  }

  /** Drop one level straight away (a car swap while unseen). */
  dropLevel(): void {
    if (this.level === 0) return;
    this.level -= 1;
    this.points = this.config.thresholds[this.level]!;
    this.unseenTime = 0;
  }

  clear(): void {
    this.level = 0;
    this.points = 0;
    this.unseenTime = 0;
    this.seen = false;
    this.civHits.length = 0;
    this.pedHits.length = 0;
  }

  private recomputeLevel(): void {
    const t = this.config.thresholds;
    let l = 0;
    for (let i = 1; i <= this.config.maxLevel; i++) if (this.points >= t[i]!) l = i;
    // Never drop a level by adding points.
    this.level = Math.max(this.level, l);
  }

  /** A civilian car hit at time `now`. True once enough happen within the window to count as a crime. */
  civCarHit(now: number): boolean {
    return this.repeated(this.civHits, now, this.config.civCarHitsToCount);
  }

  pedHit(now: number): boolean {
    return this.repeated(this.pedHits, now, this.config.pedHitsToCount);
  }

  private repeated(list: number[], now: number, need: number): boolean {
    const w = this.config.repeatWindowSec;
    let keep = 0;
    for (const t of list) if (now - t <= w) list[keep++] = t;
    list.length = keep;
    list.push(now);
    return list.length >= need;
  }

  /**
   * Advance by dt. `seen` is whether any unit currently has the player in sight.
   * Returns true if the level dropped this step.
   */
  update(dt: number, seen: boolean, px: number, pz: number): boolean {
    this.seen = seen && this.level > 0;
    if (this.level === 0) {
      this.unseenTime = 0;
      return false;
    }
    if (seen) {
      this.lastKnownX = px;
      this.lastKnownZ = pz;
      this.unseenTime = 0;
      return false;
    }
    const r = this.searchRadius;
    const outside = r <= 0 || Math.hypot(px - this.lastKnownX, pz - this.lastKnownZ) > r;
    if (!outside) return false;
    this.unseenTime += dt;
    if (this.unseenTime >= this.decaySeconds) {
      this.dropLevel();
      return true;
    }
    return false;
  }
}
