import { z } from 'zod';

/** Zod schemas for every piece of content the simulation consumes. */

export const VehicleParamsSchema = z.object({
  name: z.string(),
  role: z.enum(['civilian', 'police', 'squad', 'mission']),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  length: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  mass: z.number().positive(),
  acceleration: z.number().positive(),
  topSpeed: z.number().positive(),
  reverseTopSpeed: z.number().positive(),
  brakeDecel: z.number().positive(),
  rollingDrag: z.number().nonnegative(),
  airDrag: z.number().nonnegative(),
  grip: z.number().positive(),
  driftGrip: z.number().positive(),
  handbrakeGripMul: z.number().min(0).max(1),
  handbrakeDecel: z.number().nonnegative(),
  driftEnterSlip: z.number().positive(),
  driftExitSlip: z.number().positive(),
  steerRateLow: z.number().positive(),
  steerRateHigh: z.number().positive(),
  steerSpeedMin: z.number().positive(),
  steerResponse: z.number().positive(),
  handbrakeSteerBoost: z.number().positive(),
  driftSteerMul: z.number().positive(),
  autoStraighten: z.number().nonnegative(),
  maxHealth: z.number().positive(),
  armour: z.number().positive(),
});
export type VehicleParams = z.infer<typeof VehicleParamsSchema>;

export const VehiclesSchema = z
  .object({
    player: z.string(),
    variants: z.record(z.string(), VehicleParamsSchema),
    damage: z.object({
      impactThreshold: z.number().nonnegative(),
      damagePerMs: z.number().nonnegative(),
      destroyedEjectSec: z.number().nonnegative(),
    }),
  })
  .refine((v) => v.player in v.variants, { message: 'player variant must exist' });
export type VehiclesContent = z.infer<typeof VehiclesSchema>;

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const MapSchema = z.object({
  id: z.string(),
  size: z.tuple([z.number().positive(), z.number().positive()]),
  roads: z.object({
    positions: z.array(z.number()).min(2),
    width: z.number().positive(),
    laneOffset: z.number().positive(),
    extent: z.number().positive(),
  }),
  wallThickness: z.number().positive(),
  buildings: z.array(
    z.object({ x: z.number(), z: z.number(), w: z.number().positive(), d: z.number().positive(), h: z.number().positive() }),
  ),
  markers: z.record(z.string(), z.object({ pos: Vec3 })),
  spawns: z.record(z.string(), z.object({ variant: z.string(), pos: Vec3, yaw: z.number(), locked: z.boolean() })),
  traffic: z.object({
    loops: z.array(z.object({ id: z.string(), points: z.array(z.tuple([z.number(), z.number()])).min(3) })),
  }),
});
export type MapContent = z.infer<typeof MapSchema>;

export interface SimContent {
  vehicles: VehiclesContent;
  map: MapContent;
}

export interface RawSimContent {
  vehicles: unknown;
  map: unknown;
}

/** Validate raw JSON content. Throws a readable error on the first invalid file. */
export function parseSimContent(raw: RawSimContent): SimContent {
  const parse = <T>(name: string, schema: z.ZodType<T>, value: unknown): T => {
    const r = schema.safeParse(value);
    if (!r.success) throw new Error(`Invalid content "${name}": ${z.prettifyError(r.error)}`);
    return r.data;
  };
  const vehicles = parse('vehicles', VehiclesSchema, raw.vehicles);
  const map = parse('map', MapSchema, raw.map);
  for (const [id, s] of Object.entries(map.spawns)) {
    if (!(s.variant in vehicles.variants)) throw new Error(`Spawn "${id}" uses unknown variant "${s.variant}"`);
  }
  return { vehicles, map };
}
