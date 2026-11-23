import { z } from 'zod';

/**
 * Mission data. Missions are JSON files interpreted by MissionRunner; a new
 * mission is a new file, never a new code path.
 *
 * References:
 * - `marker:<id>`: a map marker (the city generator's guaranteed vocabulary);
 * - `spawn:<id>`: a vehicle, from the mission's own `spawns` first, then the map's;
 * - `actor:<id>`: a person from the mission's own `actors`.
 */
const ID = /^[a-z0-9_]+$/;
export const MarkerRefSchema = z.string().regex(/^marker:[a-z0-9_]+$/, 'expected "marker:<id>"');
export const SpawnRefSchema = z.string().regex(/^spawn:[a-z0-9_]+$/, 'expected "spawn:<id>"');
export const ActorRefSchema = z.string().regex(/^actor:[a-z0-9_]+$/, 'expected "actor:<id>"');
/** Anything with a position. */
export const RefSchema = z.string().regex(/^(marker|spawn|actor):[a-z0-9_]+$/, 'expected "marker:<id>", "spawn:<id>" or "actor:<id>"');
export const SpawnOrActorRefSchema = z.string().regex(/^(spawn|actor):[a-z0-9_]+$/, 'expected "spawn:<id>" or "actor:<id>"');

/** What the player must be in: any vehicle, on foot, or one particular spawned vehicle. */
export const VehicleReqSchema = z.union([z.literal('any'), z.literal('none'), SpawnRefSchema]);
export type VehicleReq = z.infer<typeof VehicleReqSchema>;

const Offset = z.tuple([z.number(), z.number()]);

// ------------------------------------------------------------------ events

const EventBase = { delaySec: z.number().nonnegative().optional() };

export const MissionEventSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('dialogue'), line: z.string().min(1), ...EventBase }),
  /** A short instruction line (tutorials). `desktop` replaces `text` with a keyboard and mouse. */
  z.object({ do: z.literal('hint'), text: z.string().min(1).max(90), desktop: z.string().min(1).max(90).optional(), durationSec: z.number().positive().max(20).optional(), ...EventBase }),
  z.object({ do: z.literal('setHeat'), value: z.number().int().min(0).max(5), ...EventBase }),
  z.object({ do: z.literal('spawnSquad'), squad: z.string().min(1), ...EventBase }),
  z.object({ do: z.literal('addTrace'), value: z.number().min(-100).max(100), ...EventBase }),
  /** Put mission vehicles and people into the world now (otherwise they appear when first needed). */
  z.object({ do: z.literal('spawn'), refs: z.array(SpawnOrActorRefSchema).min(1), ...EventBase }),
  z.object({ do: z.literal('despawn'), refs: z.array(SpawnOrActorRefSchema).min(1), ...EventBase }),
  /** Hostile actors start fighting. */
  z.object({ do: z.literal('aggro'), refs: z.array(ActorRefSchema).min(1), target: z.union([SpawnOrActorRefSchema, z.literal('player')]).optional(), ...EventBase }),
  /** Give a mission vehicle a driver: follow a road route, flee the player, ram something, or hold still. */
  z.object({
    do: z.literal('drive'),
    vehicle: SpawnRefSchema,
    mode: z.enum(['route', 'flee', 'ram', 'hold', 'park']),
    route: z.array(RefSchema).min(1).optional(),
    /** Ram target: a spawn, or the player. */
    target: z.union([SpawnRefSchema, z.literal('player')]).optional(),
    speed: z.number().positive().optional(),
    loop: z.boolean().optional(),
    ...EventBase,
  }),
  /** People get into the player's car (they ride along until dropped off). */
  z.object({ do: z.literal('board'), actors: z.array(ActorRefSchema).min(1), ...EventBase }),
  z.object({ do: z.literal('alight'), actors: z.array(ActorRefSchema).min(1), at: RefSchema.optional(), ...EventBase }),
  z.object({ do: z.literal('goTo'), actor: ActorRefSchema, to: RefSchema, run: z.boolean().optional(), ...EventBase }),
  z.object({ do: z.literal('lock'), vehicle: SpawnRefSchema, value: z.boolean(), ...EventBase }),
]);
export type MissionEvent = z.infer<typeof MissionEventSchema>;

const Hooks = {
  onStart: z.array(MissionEventSchema).optional(),
  onComplete: z.array(MissionEventSchema).optional(),
  onFail: z.array(MissionEventSchema).optional(),
};

// -------------------------------------------------------------- objectives

/** Extra ways an objective can fail. */
export const FailConditionSchema = z.discriminatedUnion('if', [
  z.object({ if: z.literal('vehicleDestroyed'), target: SpawnRefSchema, message: z.string().optional() }),
  z.object({ if: z.literal('actorKilled'), target: ActorRefSchema, message: z.string().optional() }),
  z.object({ if: z.literal('heatAtLeast'), value: z.number().int().min(1).max(5), message: z.string().optional() }),
  z.object({ if: z.literal('traceAtLeast'), value: z.number().min(1).max(100), message: z.string().optional() }),
  /** The player gets out of (or never into) a vehicle. */
  z.object({ if: z.literal('onFoot'), message: z.string().optional() }),
  /** The player goes further than `distance` from a vehicle or person for `graceSec`. */
  z.object({ if: z.literal('tooFar'), target: SpawnOrActorRefSchema, distance: z.number().positive(), graceSec: z.number().nonnegative().default(8), message: z.string().optional() }),
]);
export type FailCondition = z.infer<typeof FailConditionSchema>;

const Base = {
  id: z.string().regex(ID),
  /** Replaces the default objective line. British English, short. */
  text: z.string().min(1).max(80).optional(),
  timeLimitSec: z.number().positive().optional(),
  failOn: z.array(FailConditionSchema).optional(),
  ...Hooks,
};

const PERFORM_ACTIONS = ['dodge', 'fire', 'enter', 'exit'] as const;

export const ObjectiveSchema = z.discriminatedUnion('type', [
  z.object({ ...Base, type: z.literal('reach'), target: RefSchema, radius: z.number().positive().default(6), vehicle: VehicleReqSchema.optional() }),
  z.object({
    ...Base,
    type: z.literal('hack'),
    /** A car (spawn) or a terminal at a marker. */
    target: z.string().regex(/^(spawn|marker):[a-z0-9_]+$/, 'hack targets are spawns or markers'),
    minigame: z.literal('sequence'),
    difficulty: z.number().int().min(1).max(5),
  }),
  z.object({
    ...Base,
    type: z.literal('deliverVehicle'),
    vehicle: SpawnRefSchema,
    target: RefSchema,
    radius: z.number().positive().default(6),
    minHealth: z.number().min(0).max(1).default(0),
  }),
  z.object({
    ...Base,
    type: z.literal('stealVehicle'),
    /** One particular car… */
    vehicle: SpawnRefSchema.optional(),
    /** …or any car of these variants. */
    variants: z.array(z.string().min(1)).min(1).optional(),
  }),
  z.object({
    ...Base,
    type: z.literal('destroyVehicle'),
    targets: z.array(SpawnRefSchema).min(1),
    count: z.number().int().positive().optional(),
    /** Fail if a target reaches this place. */
    escapeAt: RefSchema.optional(),
    escapeRadius: z.number().positive().default(15),
  }),
  z.object({
    ...Base,
    type: z.literal('eliminate'),
    targets: z.array(ActorRefSchema).min(1),
    count: z.number().int().positive().optional(),
  }),
  z.object({
    ...Base,
    type: z.literal('protect'),
    target: SpawnOrActorRefSchema,
    /** Escort: a vehicle target drives here; done when it arrives. */
    destination: RefSchema.optional(),
    radius: z.number().positive().default(12),
    speed: z.number().positive().optional(),
    /** Defend: keep the target alive this long. */
    durationSec: z.number().positive().optional(),
  }),
  z.object({
    ...Base,
    type: z.literal('tail'),
    target: SpawnRefSchema,
    route: z.array(RefSchema).min(1),
    speed: z.number().positive().default(12),
    maxRange: z.number().positive().default(70),
    minRange: z.number().positive().default(12),
    tooCloseSec: z.number().positive().default(4),
    lostSec: z.number().positive().default(8),
  }),
  z.object({
    ...Base,
    type: z.literal('chase'),
    target: SpawnRefSchema,
    /** disable: knock its hull below disableHealth and the driver gives up; wreck: destroy it. */
    catch: z.enum(['disable', 'wreck']).default('disable'),
    disableHealth: z.number().min(0).max(1).default(0.4),
    speed: z.number().positive().optional(),
    escapeDistance: z.number().positive().default(220),
    escapeSec: z.number().positive().default(8),
  }),
  z.object({ ...Base, type: z.literal('escape') }),
  z.object({
    ...Base,
    type: z.literal('race'),
    checkpoints: z.array(RefSchema).min(2),
    radius: z.number().positive().default(10),
    vehicle: VehicleReqSchema.default('any'),
    opponents: z.array(SpawnRefSchema).optional(),
    opponentSpeed: z.number().positive().optional(),
  }),
  z.object({
    ...Base,
    type: z.literal('collect'),
    pickups: z.array(RefSchema).min(1),
    radius: z.number().positive().default(4),
    count: z.number().int().positive().optional(),
    vehicle: VehicleReqSchema.optional(),
  }),
  z.object({
    ...Base,
    type: z.literal('wait'),
    target: RefSchema,
    radius: z.number().positive().default(10),
    durationSec: z.number().positive(),
    vehicle: VehicleReqSchema.optional(),
    /** Leaving the zone starts the count again instead of pausing it. */
    resetOnLeave: z.boolean().default(false),
  }),
  z.object({
    ...Base,
    type: z.literal('dropOff'),
    target: RefSchema,
    radius: z.number().positive().default(8),
    vehicle: VehicleReqSchema.default('any'),
    passengers: z.array(ActorRefSchema).optional(),
    /** Slow down to this speed (m/s) to let them out. */
    maxSpeed: z.number().positive().default(4),
  }),
  z.object({
    ...Base,
    type: z.literal('photograph'),
    target: SpawnOrActorRefSchema,
    range: z.number().positive().default(30),
    holdSec: z.number().positive().default(2.5),
  }),
  z.object({ ...Base, type: z.literal('perform'), action: z.enum(PERFORM_ACTIONS), count: z.number().int().positive().default(1) }),
]);
export type Objective = z.infer<typeof ObjectiveSchema>;
export type ObjectiveType = Objective['type'];
export type PerformAction = (typeof PERFORM_ACTIONS)[number];
export const OBJECTIVE_TYPES: readonly ObjectiveType[] = ObjectiveSchema.options.map((o) => o.shape.type.value);

// ---------------------------------------------------------- spawns, actors

export const SpawnDefSchema = z.object({
  variant: z.string().min(1),
  at: MarkerRefSchema,
  /** Metres east/south of the marker, to park several cars at one lot. */
  offset: Offset.optional(),
  /** Heading in radians; left out, a car on a road faces along its lane. */
  yaw: z.number().optional(),
  locked: z.boolean().default(false),
  hackable: z.boolean().default(false),
  /** What it is for, for the UI's marker colour: a target, a car to escort, a hostile, a racer, a courier. */
  role: z.enum(['parked', 'target', 'escort', 'hostile', 'racer', 'courier']).default('parked'),
  /** Fraction of the variant's full health it starts with (a beaten-up van goes down quicker). */
  hull: z.number().min(0.1).max(1).default(1),
});
export type SpawnDef = z.infer<typeof SpawnDefSchema>;

export const ActorDefSchema = z.object({
  faction: z.string().min(1),
  at: MarkerRefSchema,
  offset: Offset.optional(),
  facing: z.number().optional(),
  behaviour: z.enum(['idle', 'guard', 'wander', 'flee', 'follow', 'goto']).default('idle'),
  hostile: z.boolean().default(false),
  armed: z.boolean().optional(),
  hp: z.number().int().min(1).max(10).default(1),
  group: z.string().regex(ID).optional(),
  role: z.enum(['target', 'guard', 'vip', 'crew', 'witness']).default('target'),
});
export type ActorDef = z.infer<typeof ActorDefSchema>;

// ------------------------------------------------------------------ mission

/**
 * Unlocks granted by a mission: `safehouse:<marker id>`, `shop:<marker id>`,
 * `weapon:<weapon id>`, `respray:<marker id>`, `vehicle:<variant>`, `crew:<crew id>`.
 */
export const UnlockSchema = z.string().regex(/^(safehouse|shop|weapon|respray|vehicle|crew):[a-z0-9_]+$/, 'expected "<kind>:<id>"');

export const MissionSchema = z
  .object({
    id: z.string().regex(ID),
    /** The crew that gives the job. */
    faction: z.string().min(1),
    title: z.string().min(1).max(40),
    /** One line for the payphone card and the job list. */
    summary: z.string().min(1).max(140).optional(),
    /** Part of the main story thread. */
    story: z.boolean().default(false),
    /** Order within the crew's chain (0 first). */
    chain: z.number().int().nonnegative().optional(),
    giver: z
      .object({
        type: z.literal('payphone'),
        at: MarkerRefSchema.optional(),
        /** Legacy absolute position; prefer `at`. */
        pos: z.tuple([z.number(), z.number(), z.number()]).optional(),
      })
      .refine((g) => (g.at === undefined) !== (g.pos === undefined), { message: 'giver needs exactly one of "at" or "pos"' }),
    prerequisites: z
      .object({
        missions: z.array(z.string().regex(ID)).optional(),
        /** Minimum respect with each crew. */
        respect: z.record(z.string(), z.number()).optional(),
      })
      .optional(),
    budgetMinutes: z.number().min(3).max(8),
    spawns: z.record(z.string().regex(ID), SpawnDefSchema).optional(),
    actors: z.record(z.string().regex(ID), ActorDefSchema).optional(),
    onStart: z.array(MissionEventSchema).optional(),
    onComplete: z.array(MissionEventSchema).optional(),
    objectives: z.array(ObjectiveSchema).min(1),
    rewards: z.object({
      credits: z.number().int().nonnegative(),
      /** Respect with each crew (negative for crews you crossed). */
      rep: z.record(z.string(), z.number()),
      unlocks: z.array(UnlockSchema).optional(),
      /** Extra pay for finishing inside a time. */
      timeBonus: z.object({ underSec: z.number().positive(), credits: z.number().int().positive() }).optional(),
    }),
    failPolicy: z.enum(['checkpoint', 'restart']),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.objectives.forEach((o, i) => {
      const path = ['objectives', i];
      if (seen.has(o.id)) ctx.addIssue({ code: 'custom', message: `duplicate objective id "${o.id}"`, path });
      seen.add(o.id);
      if (o.type === 'stealVehicle' && (o.vehicle === undefined) === (o.variants === undefined)) {
        ctx.addIssue({ code: 'custom', message: 'stealVehicle needs exactly one of "vehicle" or "variants"', path });
      }
      if (o.type === 'protect' && (o.destination === undefined) === (o.durationSec === undefined)) {
        ctx.addIssue({ code: 'custom', message: 'protect needs exactly one of "destination" (escort) or "durationSec" (defend)', path });
      }
      if (o.type === 'protect' && o.destination !== undefined && !o.target.startsWith('spawn:')) {
        ctx.addIssue({ code: 'custom', message: 'only a vehicle can be escorted to a destination; defend people with durationSec', path });
      }
      if (o.type === 'tail' && o.minRange >= o.maxRange) ctx.addIssue({ code: 'custom', message: 'tail minRange must be below maxRange', path });
      if ((o.type === 'destroyVehicle' || o.type === 'eliminate') && o.count !== undefined && o.count > o.targets.length) {
        ctx.addIssue({ code: 'custom', message: 'count is more than the number of targets', path });
      }
      if (o.type === 'collect' && o.count !== undefined && o.count > o.pickups.length) {
        ctx.addIssue({ code: 'custom', message: 'count is more than the number of pickups', path });
      }
      if (o.timeLimitSec !== undefined && o.timeLimitSec > m.budgetMinutes * 60) {
        ctx.addIssue({ code: 'custom', message: 'time limit exceeds the mission budget', path: [...path, 'timeLimitSec'] });
      }
    });
    if (m.prerequisites?.missions?.includes(m.id)) ctx.addIssue({ code: 'custom', message: 'a mission cannot require itself', path: ['prerequisites'] });
  });
export type Mission = z.infer<typeof MissionSchema>;

export const SquadsSchema = z.record(
  z.string(),
  z.object({ variant: z.string(), count: z.number().int().positive(), despawnOnEnd: z.boolean().default(true) }),
);
export type Squads = z.infer<typeof SquadsSchema>;

export const DialogueSchema = z.record(z.string(), z.object({ speaker: z.string(), text: z.string() }));
export type Dialogue = z.infer<typeof DialogueSchema>;

/** The five crews: colour is gameplay information, always paired with a shape. */
export const CrewsSchema = z.record(
  z.string().regex(ID),
  z.object({
    name: z.string().min(1),
    contact: z.string().min(1),
    colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    /** Shape paired with the colour on markers and cards (colour-blind safety). */
    shape: z.enum(['diamond', 'square', 'circle', 'triangle', 'hexagon']),
    district: z.string().min(1),
    blurb: z.string().min(1),
  }),
);
export type Crews = z.infer<typeof CrewsSchema>;

export function parseMission(raw: unknown, source = 'mission'): Mission {
  const r = MissionSchema.safeParse(raw);
  if (!r.success) throw new Error(`Invalid ${source}: ${z.prettifyError(r.error)}`);
  return r.data;
}

/** JSON Schema for editors and external tools, generated from the Zod schema. */
export function missionJsonSchema(): unknown {
  return z.toJSONSchema(MissionSchema, { io: 'input', unrepresentable: 'any' });
}
