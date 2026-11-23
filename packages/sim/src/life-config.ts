import { z } from 'zod';

/**
 * Tuning for the living city (content/data/life.json): emergency services,
 * street crews and crowds. Every field has a default, so a partial file works.
 */

const Range = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);

export const ServicesConfigSchema = z
  .object({
    /** Vehicle variants sent out. */
    ambulance: z.string().default('lifeline'),
    fireTender: z.string().default('ember'),
    /** Seconds between the incident and the call going out (someone phones it in). */
    dispatchDelaySec: Range.default([3, 6]),
    /** Only incidents this close to the player get a response (nobody sees the rest). */
    callRadius: z.number().positive().default(150),
    /** A clinic this close to the incident sends its own ambulance; otherwise one arrives from out of view. */
    clinicMaxDist: z.number().positive().default(240),
    /** Responders spawned on the road this far from the incident (and out of the player's view). */
    spawnDist: Range.default([110, 190]),
    /** Crew per vehicle (paramedics or firefighters). */
    crew: z.number().int().min(1).max(3).default(2),
    /** Driving: cruise with lights on, corner speed, how close to the scene counts as arrived. */
    driveSpeed: z.number().positive().default(17),
    cornerSpeed: z.number().positive().default(8),
    arriveRadius: z.number().positive().default(7),
    /** Gap kept behind traffic, and how far an emergency vehicle moves over to pass cars that pulled in. */
    minGap: z.number().positive().default(5),
    overtakeOffset: z.number().nonnegative().default(0.8),
    /** On foot. */
    walkSpeed: z.number().positive().default(2.6),
    /** Seconds kneeling over a patient before they are back on their feet. */
    reviveSec: z.number().positive().default(5),
    /** A wreck burns for this long on its own before going out. */
    burnSec: z.number().positive().default(150),
    /** Burn removed per second by each firefighter's hose (1 = fully alight). */
    hoseRate: z.number().positive().default(0.09),
    /** Firefighters stand this far from the wreck. */
    hoseRange: z.number().positive().default(5.5),
    /** A responder that has not reached the scene in this long gives up and leaves. */
    giveUpSec: z.number().positive().default(75),
    /** Seconds of a wreck burning before the fire tender is called. */
    fireCallDelaySec: z.number().nonnegative().default(4),
    /** Traffic ahead of a vehicle with lights on pulls over to the kerb. */
    pullOver: z
      .object({
        /** How far ahead of the siren a car notices it (m). */
        range: z.number().positive().default(48),
        /** Extra sideways shift towards the kerb (m). */
        shift: z.number().nonnegative().default(1.8),
        /** Speed a car slows to while pulled over (m/s). */
        speed: z.number().nonnegative().default(2.5),
        /** Seconds a car stays pulled over after the siren passes. */
        holdSec: z.number().nonnegative().default(1.2),
      })
      .prefault({}),
  })
  .prefault({});
export type ServicesConfig = z.infer<typeof ServicesConfigSchema>;

/** A crew's street look: a silhouette detail as well as its colour (colour-blind safe). */
export const CrewLookSchema = z.enum(['hood', 'visor', 'hat', 'beanie', 'mohawk']);
export type CrewLook = z.infer<typeof CrewLookSchema>;

export const GangCrewSchema = z.object({
  look: CrewLookSchema,
  /** Cars the crew cruises in (painted in the crew colour). */
  cars: z.array(z.string()).min(1),
  /** Share of members carrying a gun; the rest fight with fists. */
  armed: z.number().min(0).max(1).default(0.7),
  /** Trouser colour, to vary the silhouette further. */
  trousers: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#1d1f2b'),
});
export type GangCrew = z.infer<typeof GangCrewSchema>;

export const GangsConfigSchema = z
  .object({
    crews: z.record(z.string(), GangCrewSchema).default({}),
    /** Loitering spots per district, picked deterministically from the map. */
    spotsPerDistrict: z.number().int().nonnegative().default(14),
    groupSize: Range.default([3, 5]),
    /** Groups appear between these distances from the player (out of view) and leave beyond despawnDist. */
    spawnDist: Range.default([55, 150]),
    despawnDist: z.number().positive().default(200),
    /** Respect at or above `friendlyAt` is friendly; at or below `hostileAt` hostile. */
    friendlyAt: z.number().default(20),
    hostileAt: z.number().default(-20),
    aiHz: z.number().positive().default(12),
    walkSpeed: z.number().positive().default(1.4),
    runSpeed: z.number().positive().default(5),
    hp: z.number().positive().default(70),
    /** Hostile crews notice the player this close with line of sight (in their turf). */
    aggroRadius: z.number().positive().default(24),
    /** Friendly members nod at a player on foot this close. */
    nodRadius: z.number().positive().default(7),
    /** Friendly members join a fight against police officers this close to them (and to the player). */
    helpRadius: z.number().positive().default(30),
    /** Seconds a neutral group holds a grudge after being attacked. */
    grudgeSec: z.number().positive().default(60),
    shotRange: z.number().positive().default(26),
    shotIntervalSec: z.number().positive().default(1.15),
    accuracy: z.number().min(0).max(1).default(0.4),
    shotDamagePlayer: z.number().nonnegative().default(6),
    shotDamageVehicle: z.number().nonnegative().default(4),
    shotDamagePed: z.number().nonnegative().default(36),
    shotDamageOfficer: z.number().nonnegative().default(30),
    punchDamage: z.number().nonnegative().default(8),
    fightRange: z.number().positive().default(12),
    /** Crew cars: cruising speed and how many per crew near the player at most. */
    carCruise: z.number().positive().default(11),
    /** Rival crews: one squad walks into the other's patch and a fight breaks out. */
    rivals: z.array(z.tuple([z.string(), z.string()])).default([]),
    fight: z
      .object({
        /** Seconds between rival fights (min, max), and the chance one starts when due. */
        intervalSec: Range.default([80, 160]),
        chance: z.number().min(0).max(1).default(0.6),
        squad: z.number().int().positive().default(3),
        /** Shouting before the shooting starts (crowds gather). */
        standoffSec: z.number().nonnegative().default(6),
        maxSec: z.number().positive().default(45),
        /** The squad gives up walking in after this long. */
        approachSec: z.number().positive().default(40),
      })
      .prefault({}),
  })
  .prefault({});
export type GangsConfig = z.infer<typeof GangsConfigSchema>;

/** A piecewise-linear curve over the day: [hour, multiplier] points, sorted by hour. */
const HourCurve = z.array(z.tuple([z.number().min(0).max(24), z.number().nonnegative()])).min(1);

export const CrowdsConfigSchema = z
  .object({
    aiHz: z.number().positive().default(4),
    /** Chance a new pedestrian walks with one or two companions. */
    groupChance: z.number().min(0).max(1).default(0.3),
    groupMax: z.number().int().nonnegative().default(2),
    /** Chance per decision that a wanderer near a junction goes to cross it. */
    crossChance: z.number().min(0).max(1).default(0.35),
    crossRadius: z.number().positive().default(26),
    crossSpeed: z.number().positive().default(1.6),
    /** Rain above this: the share of walkers with umbrellas opens them (rendered). */
    umbrellaRain: z.number().min(0).max(1).default(0.25),
    umbrellaShare: z.number().min(0).max(1).default(0.6),
    /** Rain above this (a storm): the share without umbrellas shelters in doorways. */
    shelterRain: z.number().min(0).max(1).default(0.85),
    shelterShare: z.number().min(0).max(1).default(0.7),
    /** People within gawkRadius drift over to watch a wreck or a fight, standing gawkRing metres off. */
    gawkRadius: z.number().positive().default(36),
    gawkMax: z.number().int().nonnegative().default(7),
    gawkSec: z.number().positive().default(28),
    gawkRing: Range.default([6, 9]),
    /** A car on the pavement: people this far ahead dive out of its way. */
    pavementDanger: z
      .object({ range: z.number().positive().default(16), minSpeed: z.number().nonnegative().default(2.5), lateral: z.number().positive().default(2.8) })
      .prefault({}),
    /** Ambient density by district style over the day. Missing styles count as 1. */
    density: z.record(z.string(), HourCurve).default({}),
    /** Most the density can raise the ambient cap by (fraction of the tier's cap). */
    maxBoost: z.number().nonnegative().default(0.4),
  })
  .prefault({});
export type CrowdsConfig = z.infer<typeof CrowdsConfigSchema>;

export const LifeConfigSchema = z
  .object({
    services: ServicesConfigSchema,
    gangs: GangsConfigSchema,
    crowds: CrowdsConfigSchema,
  })
  .prefault({});
export type LifeConfig = z.infer<typeof LifeConfigSchema>;

/** The parts of content/data/crews.json the sim needs (the missions package owns the full schema). */
export const SimCrewSchema = z.looseObject({
  name: z.string(),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  district: z.string(),
});
export const SimCrewsSchema = z.record(z.string(), SimCrewSchema).default({});
export type SimCrews = z.infer<typeof SimCrewsSchema>;

/** Value of a day curve at `hour` (wraps at 24). */
export function curveAt(curve: readonly (readonly [number, number])[], hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (curve.length === 1) return curve[0]![1];
  for (let i = 0; i < curve.length - 1; i++) {
    const [h0, v0] = curve[i]!;
    const [h1, v1] = curve[i + 1]!;
    if (h >= h0 && h <= h1) return h1 > h0 ? v0 + ((v1 - v0) * (h - h0)) / (h1 - h0) : v1;
  }
  return h < curve[0]![0] ? curve[0]![1] : curve[curve.length - 1]![1];
}
