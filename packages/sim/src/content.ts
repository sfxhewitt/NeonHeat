import { z } from 'zod';
import { HeatConfigSchema, type HeatConfig } from './heat';
import { TrafficConfigSchema, type TrafficConfig } from './traffic';
import { CitySpecSchema, generateCity, type GeneratedMap } from './citygen';

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
  /** Most sideways acceleration the tyres can give (m/s^2). Past it the car slides, then drifts. */
  latGripMax: z.number().positive(),
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
    /** Mounting or dropping off a kerb: a bump, not a wall. */
    kerb: z
      .object({
        /** Fraction of speed lost hitting a kerb square on (scaled down for glancing crossings). */
        speedLoss: z.number().min(0).max(1),
        /** Below this speed (m/s) a kerb crossing makes no bump event. */
        minBumpSpeed: z.number().nonnegative(),
      })
      .default({ speedLoss: 0.07, minBumpSpeed: 2.5 }),
  })
  .refine((v) => v.player in v.variants, { message: 'player variant must exist' });
export type VehiclesContent = z.infer<typeof VehiclesSchema>;

/** The city map: generated from content/map/city.json (see citygen.ts). */
export type MapContent = GeneratedMap;

const cityCache = new Map<string, GeneratedMap>();

/** Generate (once per spec) and return a private copy, so callers may edit it freely. */
export function cityFromSpec(raw: unknown): GeneratedMap {
  const key = JSON.stringify(raw);
  let m = cityCache.get(key);
  if (!m) {
    const r = CitySpecSchema.safeParse(raw);
    if (!r.success) throw new Error(`Invalid content "map": ${z.prettifyError(r.error)}`);
    m = generateCity(r.data);
    cityCache.set(key, m);
  }
  return JSON.parse(JSON.stringify(m)) as GeneratedMap;
}

export const PropKindSchema = z.object({
  w: z.number().positive(),
  d: z.number().positive(),
  h: z.number().positive(),
  /** Breakable props are knocked flying by a vehicle instead of stopping it. */
  breakable: z.boolean(),
  /** Minimum vehicle speed (m/s) that smashes it. Slower, it just blocks. */
  breakSpeed: z.number().nonnegative(),
  /** Fraction of speed the vehicle loses when it smashes through. */
  slowdown: z.number().min(0).max(1),
  /** Hull damage the vehicle takes smashing through. */
  damage: z.number().nonnegative().default(0),
});
export const PropsConfigSchema = z.object({
  kinds: z.record(z.string(), PropKindSchema),
  respawnSec: z.number().positive(),
  respawnMinDist: z.number().nonnegative(),
});
export type PropsConfig = z.infer<typeof PropsConfigSchema>;

export const PedsConfigSchema = z.object({
  count: z.number().int().nonnegative(),
  radius: z.number().positive(),
  mass: z.number().positive(),
  walkSpeed: z.number().positive(),
  runSpeed: z.number().positive(),
  wanderRadius: z.number().positive(),
  fleeSecMin: z.number().positive(),
  fleeSecMax: z.number().positive(),
  cowerChance: z.number().min(0).max(1),
  cowerSec: z.number().positive(),
  downSec: z.number().positive(),
  knockdownSpeed: z.number().positive(),
  gunshotAlertRadius: z.number().nonnegative(),
  crashAlertRadius: z.number().nonnegative(),
  crashAlertStrength: z.number().nonnegative(),
  carDangerDist: z.number().nonnegative(),
  carDangerSpeed: z.number().nonnegative(),
  respawnMinDist: z.number().nonnegative(),
  aiHz: z.number().positive(),
  colours: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1),
  player: z.object({
    radius: z.number().positive(),
    mass: z.number().positive(),
    moveSpeed: z.number().positive(),
    dodgeSpeed: z.number().positive(),
    dodgeSec: z.number().positive(),
    dodgeCooldownSec: z.number().nonnegative(),
    maxHealth: z.number().positive(),
    enterRange: z.number().positive(),
    exitMaxSpeed: z.number().positive(),
    hitMinSpeed: z.number().nonnegative(),
    hitDamagePerMs: z.number().nonnegative(),
    respawnSec: z.number().nonnegative(),
  }),
});
export type PedsConfig = z.infer<typeof PedsConfigSchema>;

export const WeaponSchema = z.object({
  name: z.string(),
  fireIntervalSec: z.number().positive(),
  range: z.number().positive(),
  lockConeDeg: z.number().positive().max(180),
  damageVehicle: z.number().nonnegative(),
  damagePed: z.number().nonnegative(),
  spreadDeg: z.number().nonnegative(),
});
export const WeaponsSchema = z.object({ pistol: WeaponSchema });
export type WeaponsConfig = z.infer<typeof WeaponsSchema>;

export interface SimContent {
  vehicles: VehiclesContent;
  map: MapContent;
  heat: HeatConfig;
  traffic: TrafficConfig;
  peds: PedsConfig;
  weapons: WeaponsConfig;
  props: PropsConfig;
}

export interface RawSimContent {
  vehicles: unknown;
  map: unknown;
  heat: unknown;
  traffic: unknown;
  peds: unknown;
  weapons: unknown;
  props: unknown;
}

/** Validate raw JSON content. Throws a readable error on the first invalid file. */
export function parseSimContent(raw: RawSimContent): SimContent {
  const parse = <T>(name: string, schema: z.ZodType<T>, value: unknown): T => {
    const r = schema.safeParse(value);
    if (!r.success) throw new Error(`Invalid content "${name}": ${z.prettifyError(r.error)}`);
    return r.data;
  };
  const vehicles = parse('vehicles', VehiclesSchema, raw.vehicles);
  const map = cityFromSpec(raw.map);
  const heat = parse('heat', HeatConfigSchema, raw.heat);
  const traffic = parse('traffic', TrafficConfigSchema, raw.traffic);
  for (const v of traffic.variants) if (!(v in vehicles.variants)) throw new Error(`Traffic uses unknown variant "${v}"`);
  for (const [id, s] of Object.entries(map.spawns)) {
    if (!(s.variant in vehicles.variants)) throw new Error(`Spawn "${id}" uses unknown variant "${s.variant}"`);
  }
  const peds = parse('peds', PedsConfigSchema, raw.peds);
  const weapons = parse('weapons', WeaponsSchema, raw.weapons);
  const props = parse('props', PropsConfigSchema, raw.props);
  for (const p of map.parking) if (!(p.variant in vehicles.variants)) throw new Error(`Parking uses unknown variant "${p.variant}"`);
  for (const p of map.props) if (!(p.kind in props.kinds)) throw new Error(`Map prop uses unknown kind "${p.kind}"`);
  return { vehicles, map, heat, traffic, peds, weapons, props };
}
