import { z } from 'zod';

/** A reference to something in the map: `marker:<id>` or `spawn:<id>`. */
export const RefSchema = z.string().regex(/^(marker|spawn):[a-z0-9_]+$/, 'expected "marker:<id>" or "spawn:<id>"');

const EventBase = { delaySec: z.number().nonnegative().optional() };

export const MissionEventSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('dialogue'), line: z.string().min(1), ...EventBase }),
  z.object({ do: z.literal('setHeat'), value: z.number().int().min(0).max(5), ...EventBase }),
  z.object({ do: z.literal('spawnSquad'), squad: z.string().min(1), ...EventBase }),
  z.object({ do: z.literal('addTrace'), value: z.number().min(-100).max(100), ...EventBase }),
]);
export type MissionEvent = z.infer<typeof MissionEventSchema>;

const Hooks = {
  onStart: z.array(MissionEventSchema).optional(),
  onComplete: z.array(MissionEventSchema).optional(),
  onFail: z.array(MissionEventSchema).optional(),
};

export const ObjectiveSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    type: z.literal('reach'),
    target: RefSchema,
    radius: z.number().positive().default(6),
    ...Hooks,
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('hack'),
    target: RefSchema.refine((r) => r.startsWith('spawn:'), 'hack targets must be spawns'),
    minigame: z.literal('sequence'),
    difficulty: z.number().int().min(1).max(5),
    ...Hooks,
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('deliverVehicle'),
    vehicle: RefSchema.refine((r) => r.startsWith('spawn:'), 'vehicle must be a spawn'),
    target: RefSchema,
    radius: z.number().positive().default(6),
    minHealth: z.number().min(0).max(1).default(0),
    timeLimitSec: z.number().positive().optional(),
    ...Hooks,
  }),
]);
export type Objective = z.infer<typeof ObjectiveSchema>;

export const MissionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+$/),
    faction: z.string().min(1),
    title: z.string().min(1),
    giver: z.object({ type: z.literal('payphone'), pos: z.tuple([z.number(), z.number(), z.number()]) }),
    budgetMinutes: z.number().min(3).max(8),
    objectives: z.array(ObjectiveSchema).min(1),
    rewards: z.object({ credits: z.number().int().nonnegative(), rep: z.record(z.string(), z.number()) }),
    failPolicy: z.enum(['checkpoint', 'restart']),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const o of m.objectives) {
      if (seen.has(o.id)) ctx.addIssue({ code: 'custom', message: `duplicate objective id "${o.id}"`, path: ['objectives'] });
      seen.add(o.id);
    }
  });
export type Mission = z.infer<typeof MissionSchema>;

export const SquadsSchema = z.record(
  z.string(),
  z.object({ variant: z.string(), count: z.number().int().positive(), despawnOnEnd: z.boolean().default(true) }),
);
export type Squads = z.infer<typeof SquadsSchema>;

export const DialogueSchema = z.record(z.string(), z.object({ speaker: z.string(), text: z.string() }));
export type Dialogue = z.infer<typeof DialogueSchema>;

export function parseMission(raw: unknown, source = 'mission'): Mission {
  const r = MissionSchema.safeParse(raw);
  if (!r.success) throw new Error(`Invalid ${source}: ${z.prettifyError(r.error)}`);
  return r.data;
}

/** JSON Schema for editors and external tools, generated from the Zod schema. */
export function missionJsonSchema(): unknown {
  return z.toJSONSchema(MissionSchema, { io: 'input', unrepresentable: 'any' });
}
