import { z } from 'zod';

/**
 * Side activities tuning (content/data/activities.json): rampage tokens, stunt
 * ramps, hidden data shards, taxi and courier fares and street races. Where each
 * one sits is generated from the city (see placement.ts), steered by these rules.
 */

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const District = z.string().regex(/^[a-z]+$/);

export const RampageKindSchema = z.enum(['wreck', 'smash', 'takedown']);
export type RampageKind = z.infer<typeof RampageKindSchema>;

export const RampageDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  title: z.string(),
  district: District,
  /** Where the token sits: on a pavement, in a park or yard, or in an alley. */
  spot: z.enum(['pavement', 'park', 'lot', 'alley']).default('pavement'),
  /**
   * wreck: wreck cars (any but your own); smash: knock down street furniture;
   * takedown: put down a crew of hostile gang members who come for you.
   */
  kind: RampageKindSchema,
  target: z.number().int().positive(),
  timeSec: z.number().positive(),
  /** Weapon handed over for the challenge (and the ammo that comes with it). */
  weapon: z.string().optional(),
  ammo: z.number().int().nonnegative().default(0),
  reward: z.number().int().nonnegative(),
  /** Paid again (smaller) for a repeat pass. */
  repeatReward: z.number().int().nonnegative().default(0),
  /** Takedown: the gang's look and toughness. */
  gang: z.object({ faction: z.string(), hp: z.number().int().positive().default(2), armed: z.boolean().default(true), ring: z.tuple([z.number().positive(), z.number().positive()]).default([22, 40]) }).optional(),
});
export type RampageDef = z.infer<typeof RampageDefSchema>;

export const JumpsConfigSchema = z.object({
  /** Downward acceleration while airborne (m/s²): a little more than real for an arcade arc. */
  gravity: z.number().positive(),
  /** Multiplies the take-off vertical speed (a kicker throws you up a bit harder than its slope). */
  launchBoost: z.number().positive(),
  /** Above this height airborne cars pass over traffic, people and the ramp's own rails. */
  clearHeight: z.number().positive(),
  /** Air drag on horizontal speed while airborne (fraction per second). */
  airDrag: z.number().min(0).max(1),
  /** Yaw rate fades by this factor per second while airborne. */
  airYawDamp: z.number().nonnegative(),
  landing: z.object({
    /** Fraction of horizontal speed kept on a clean landing. */
    speedKeep: z.number().min(0).max(1),
    /** Vertical speed (m/s) above which a landing hurts the hull. */
    hardSpeed: z.number().positive(),
    /** Hull damage per m/s of vertical speed past hardSpeed. */
    damagePerMs: z.number().nonnegative(),
  }),
  /** The ramp shape: a kicker up, a short deck, and a steeper slope down the back. */
  ramp: z.object({
    width: z.number().positive(),
    up: z.number().positive(),
    deck: z.number().nonnegative(),
    down: z.number().positive(),
    height: z.number().positive(),
  }),
  reward: z.object({
    /** Below this distance a jump pays nothing. */
    minDistance: z.number().nonnegative(),
    base: z.number().int().nonnegative(),
    perMetre: z.number().nonnegative(),
    perAirSecond: z.number().nonnegative(),
    /** One-off bonus for clearing a ramp's target distance: a "unique jump". */
    unique: z.number().int().nonnegative(),
  }),
  /** Render side: slow motion for a big jump. */
  slowMo: z.object({ minAirSec: z.number().nonnegative(), scale: z.number().min(0.05).max(1), sec: z.number().nonnegative(), heightScale: z.number().min(0.3).max(1.2) }),
  /** Ramps per district. */
  perDistrict: z.record(District, z.number().int().nonnegative()),
  /** Clear road before the kicker (m), and clear ground (no buildings or water) beyond the lip. */
  runUp: z.number().positive(),
  landingRun: z.number().positive(),
  /** No part of a ramp (run-up to landing) within this many metres of a player spawn. */
  spawnClear: z.number().nonnegative(),
  /** Unique jump target: this fraction of the distance a car at targetSpeed would fly. */
  targetSpeed: z.number().positive(),
  targetFraction: z.number().min(0.2).max(1.5),
});
export type JumpsConfig = z.infer<typeof JumpsConfigSchema>;

export const ShardsConfigSchema = z.object({
  count: z.number().int().positive(),
  radius: z.number().positive(),
  /** Credits for every `milestone` shards found. */
  milestone: z.number().int().positive(),
  milestoneReward: z.number().int().nonnegative(),
  /** Each found shard pays a little too. */
  reward: z.number().int().nonnegative(),
  minSpacing: z.number().nonnegative(),
  /** Share of shards by kind of spot. */
  mix: z.object({ pavement: z.number().nonnegative(), alley: z.number().nonnegative(), park: z.number().nonnegative(), lot: z.number().nonnegative(), edge: z.number().nonnegative() }),
  /** The minimap shows a shard within this range (they are hidden on the full map). */
  revealRange: z.number().nonnegative(),
});
export type ShardsConfig = z.infer<typeof ShardsConfigSchema>;

export const FareJobSchema = z.object({
  /** HUD and button text. */
  name: z.string(),
  startLabel: z.string(),
  /** Vehicle classes (vehicles.json `class`) that can take this work. */
  classes: z.array(z.string()).min(1),
  /** taxi: a person waves at the kerb and rides along; courier: a parcel waits at a door. */
  cargo: z.enum(['passenger', 'parcel']),
  pickupDistance: z.tuple([z.number().positive(), z.number().positive()]),
  dropDistance: z.tuple([z.number().positive(), z.number().positive()]),
  /** Seconds to reach the pick-up before the fare gives up. */
  pickupSec: z.number().positive(),
  /** Delivery time: base plus route metres / allowance speed. */
  baseSec: z.number().nonnegative(),
  allowanceSpeed: z.number().positive(),
  /** Stop within this radius, below stopSpeed, to pick up or drop off. */
  stopRadius: z.number().positive(),
  stopSpeed: z.number().positive(),
  pay: z.object({
    base: z.number().int().nonnegative(),
    perMetre: z.number().nonnegative(),
    /** Up to this fraction of the fare again as a tip, by how much of the timer was left. */
    tipMax: z.number().nonnegative(),
    /** Fragile cargo: pay lost per unit of hull lost on the way (parcels). */
    damagePenalty: z.number().min(0).max(1),
  }),
  /** Every `streakEvery` deliveries in a row pays a bonus that grows with the streak. */
  streakEvery: z.number().int().positive(),
  streakBonus: z.number().int().nonnegative(),
  /** Out of the vehicle this long ends the shift. */
  leaveSec: z.number().positive(),
});
export type FareJob = z.infer<typeof FareJobSchema>;

export const RaceDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  title: z.string(),
  district: District,
  /** sprint: A to B; circuit: laps back to the start. */
  kind: z.enum(['sprint', 'circuit']),
  laps: z.number().int().positive().default(1),
  /** Rough length of one lap or the sprint (m). */
  length: z.number().positive(),
  opponents: z.number().int().min(0).max(3),
  /** Opponent cars (vehicles.json variants), one per grid slot. */
  opponentVariants: z.array(z.string()).min(1),
  /** Opponents' top speed on straights (m/s). */
  opponentSpeed: z.number().positive(),
  /** Race-built opponents: hull as a multiple of the road car's, so a shunt through traffic does not end their race. */
  opponentHull: z.number().positive().default(4),
  /** Credits by finishing place (1st, 2nd, ...). */
  prizes: z.array(z.number().int().nonnegative()).min(1),
  colour: Hex.default('#ff9a3c'),
});
export type RaceDef = z.infer<typeof RaceDefSchema>;

export const ActivitiesConfigSchema = z.object({
  /** Seeds the placement of every activity, independent of the city's own seed. */
  seed: z.number().int(),
  /** Hidden from free roam while a job runs; everything here also pauses then. */
  rampages: z.object({
    radius: z.number().positive(),
    /** A failed or passed rampage's token comes back after this long. */
    cooldownSec: z.number().nonnegative(),
    /** Countdown shown before the clock starts. */
    readySec: z.number().nonnegative(),
    /** Range around the player inside which wrecks count. */
    countRange: z.number().positive(),
    defs: z.array(RampageDefSchema).min(1),
  }),
  jumps: JumpsConfigSchema,
  shards: ShardsConfigSchema,
  fares: z.record(z.string(), FareJobSchema),
  races: z.object({
    checkpointRadius: z.number().positive(),
    /** Checkpoints along the route about this far apart (m), plus every corner. */
    checkpointSpacing: z.number().positive(),
    countdownSec: z.number().nonnegative(),
    /** Stop within this radius of the flag to be offered the race. */
    flagRadius: z.number().positive(),
    /** The race is lost if the player falls this far behind the leader (m) or leaves the car for this long. */
    abandonDistance: z.number().positive(),
    leaveSec: z.number().positive(),
    defs: z.array(RaceDefSchema).min(1),
  }),
});
export type ActivitiesConfig = z.infer<typeof ActivitiesConfigSchema>;
