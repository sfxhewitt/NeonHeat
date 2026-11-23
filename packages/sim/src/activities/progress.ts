/**
 * What the side activities remember between sessions. The sim keeps it up to
 * date; the app copies it into the save (packages/save mirrors this shape).
 */
export interface ActivityProgress {
  /** Rampages passed: how many times, and the fastest pass (seconds). */
  rampages: Record<string, { passes: number; bestSec: number }>;
  /** Best distance off each ramp (m), and whether its unique jump is done. */
  jumps: Record<string, { best: number; unique: boolean }>;
  /** Ids of the data shards found. */
  shards: string[];
  /** Street races: wins, finishes and the best time (seconds). */
  races: Record<string, { wins: number; finishes: number; bestSec: number }>;
  /** Taxi and courier work: deliveries, earnings and the longest streak. */
  fares: Record<string, { done: number; earned: number; bestStreak: number }>;
}

export function emptyProgress(): ActivityProgress {
  return { rampages: {}, jumps: {}, shards: [], races: {}, fares: {} };
}

/** Counts for the stats screen. */
export function progressSummary(p: ActivityProgress): { rampages: number; uniqueJumps: number; shards: number; racesWon: number; fares: Record<string, number> } {
  return {
    rampages: Object.values(p.rampages).filter((r) => r.passes > 0).length,
    uniqueJumps: Object.values(p.jumps).filter((j) => j.unique).length,
    shards: p.shards.length,
    racesWon: Object.values(p.races).filter((r) => r.wins > 0).length,
    fares: Object.fromEntries(Object.entries(p.fares).map(([k, v]) => [k, v.done])),
  };
}
