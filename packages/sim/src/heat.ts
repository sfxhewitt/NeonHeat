import { z } from 'zod';

export const HeatConfigSchema = z.object({
  maxLevel: z.number().int().min(1).max(5),
  /** Points needed to reach each level, index = level. thresholds[0] must be 0. */
  thresholds: z.array(z.number().nonnegative()).length(6),
  points: z.object({
    ramPolice: z.number().nonnegative(),
    hitPed: z.number().nonnegative(),
    hitCivCar: z.number().nonnegative(),
    fireWeapon: z.number().nonnegative(),
  }),
  /** Repeated-offence window: hits only count once this many happen within the window. */
  repeatWindowSec: z.number().positive(),
  civCarHitsToCount: z.number().int().positive(),
  pedHitsToCount: z.number().int().positive(),
  ramMinStrength: z.number().nonnegative(),
  decaySeconds: z.number().positive(),
  /** Search radius around the last known position, per level. 0 = not used. */
  searchRadius: z.array(z.number().nonnegative()).length(6),
  /** Patrol cars per level. */
  units: z.array(z.number().int().nonnegative()).length(6),
  droneLevel: z.number().int().min(1),
  sightRange: z.number().positive(),
  droneSightRange: z.number().positive(),
  droneSpeed: z.number().positive(),
  droneAltitude: z.number().positive(),
  spawnMinDist: z.number().positive(),
  spawnMaxDist: z.number().positive(),
  despawnDist: z.number().positive(),
  aiHz: z.number().positive(),
  ramDistance: z.number().positive(),
  lookAheadSec: z.number().nonnegative(),
  stuckSec: z.number().positive(),
  reverseSec: z.number().positive(),
  /** TRACE (0-100 % net trace) bleeds off at this rate. */
  traceDecayPerSec: z.number().nonnegative(),
});
export type HeatConfig = z.infer<typeof HeatConfigSchema>;

/**
 * HEAT: the wanted level, 0..maxLevel chevrons. Pure state machine.
 *
 * - Crimes add points; levels come from point thresholds.
 * - While any unit sees the player, the last known position is refreshed.
 * - Out of sight for `decaySeconds` (and, at level 2+, outside the search radius
 *   around the last known position) drops one level.
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

  get searchRadius(): number {
    return this.config.searchRadius[this.level] ?? 0;
  }

  /** Seconds remaining until the next decay step (for UI), or -1 when not decaying. */
  get decayProgress(): number {
    return this.level === 0 ? 0 : Math.min(1, this.unseenTime / this.config.decaySeconds);
  }

  addPoints(n: number, x: number, z: number): void {
    if (n <= 0) return;
    this.points += n;
    this.lastKnownX = x;
    this.lastKnownZ = z;
    this.unseenTime = 0;
    this.seen = true;
    this.recomputeLevel();
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

  /** Register a crime of a repeated kind at time `now`. */
  civCarHit(now: number, x: number, z: number): void {
    this.repeated(this.civHits, now, this.config.civCarHitsToCount, this.config.points.hitCivCar, x, z);
  }

  pedHit(now: number, x: number, z: number): void {
    this.repeated(this.pedHits, now, this.config.pedHitsToCount, this.config.points.hitPed, x, z);
  }

  private repeated(list: number[], now: number, need: number, pts: number, x: number, z: number): void {
    const w = this.config.repeatWindowSec;
    let keep = 0;
    for (const t of list) if (now - t <= w) list[keep++] = t;
    list.length = keep;
    list.push(now);
    if (list.length >= need) this.addPoints(pts, x, z);
  }

  /**
   * Advance by dt. `seen` is whether any unit currently has the player in sight.
   * Returns true if the level dropped this step.
   */
  update(dt: number, seen: boolean, px: number, pz: number): boolean {
    this.seen = seen;
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
    const outside = this.level < 2 || r <= 0 || Math.hypot(px - this.lastKnownX, pz - this.lastKnownZ) > r;
    if (!outside) return false;
    this.unseenTime += dt;
    if (this.unseenTime >= this.config.decaySeconds) {
      this.level -= 1;
      this.points = this.config.thresholds[this.level]!;
      this.unseenTime = 0;
      return true;
    }
    return false;
  }
}
