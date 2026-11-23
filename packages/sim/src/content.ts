import { WeatherConfigSchema, type WeatherConfig } from './weather';
import { z } from 'zod';
import { HeatConfigSchema, type HeatConfig } from './heat';
import { TrafficConfigSchema, type TrafficConfig } from './traffic';
import { PickupsConfigSchema, type PickupsConfig } from './pickups';
import { SurvivalConfigSchema, type SurvivalConfig } from './survival';
import { CitySpecSchema, generateCity, type GeneratedMap } from './citygen';
import { EconomyConfigSchema, type EconomyConfig } from './economy';
import { LifeConfigSchema, SimCrewsSchema, type LifeConfig, type SimCrews } from './life-config';
import { ActivitiesConfigSchema, type ActivitiesConfig } from './activities/config';
import { clearActivitySites, placeActivities, type ActivitySites } from './activities/placement';

/** Zod schemas for every piece of content the simulation consumes. */

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * What kind of vehicle a variant is. Audio (engine voice), traffic (mixes) and
 * missions ("steal any sports car") query this instead of variant ids.
 */
export const VehicleClassSchema = z.enum([
  'compact',
  'saloon',
  'estate',
  'taxi',
  'suv',
  'sports',
  'super',
  'muscle',
  'van',
  'pickup',
  'truck',
  'bus',
  'bike',
  'emergency',
  'police',
]);
export type VehicleClass = z.infer<typeof VehicleClassSchema>;

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
  /** Vehicle class, for audio, traffic and mission queries. */
  class: VehicleClassSchema.default('saloon'),
  /** Body model the renderer builds (defaults to one picked from the variant id). */
  model: z.string().optional(),
  /** Two-wheeler: no sideways drift without the rear brake (handbrake), lean visuals, rider shown. */
  twoWheel: z.boolean().default(false),
  /** Relative weight in civilian traffic mixes (0 = never picked as traffic by the roster helper). */
  traffic: z.number().nonnegative().default(0),
  /** District hints where this variant is more common (e.g. docks, downtown, industrial). */
  districts: z.array(z.string()).default([]),
  /** Paint colours an instance can roll. Empty: the class palette, else the variant colour. */
  paints: z.array(Hex).default([]),
  /** Most the body leans into a turn, radians (bikes). 0 = a car that only rolls a little. */
  leanMax: z.number().min(0).max(1.2).default(0),
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
    /** Paint palettes by vehicle class, used when a variant has no paints of its own. */
    paints: z.record(z.string(), z.array(Hex)).default({}),
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
  /** Pedestrian hit points (weapons and fists wear them down). */
  hp: z.number().positive().default(100),
  /** Size of the ped pool: ambient people plus gang members, crews and crowds. */
  pool: z.number().int().positive().default(110),
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
    /** Seconds after stepping out of a car during which that car cannot run you over. */
    bailOutGraceSec: z.number().nonnegative().default(1.5),
    respawnSec: z.number().nonnegative(),
  }),
});
export type PedsConfig = z.infer<typeof PedsConfigSchema>;

/** One weapon. `kind` picks the firing model; the optional blocks configure the special kinds. */
export const WeaponSchema = z.object({
  name: z.string(),
  /** Short HUD label. */
  short: z.string(),
  kind: z.enum(['melee', 'hitscan', 'projectile', 'arc']),
  fireIntervalSec: z.number().positive(),
  range: z.number().positive(),
  lockConeDeg: z.number().positive().max(180),
  damageVehicle: z.number().nonnegative(),
  damagePed: z.number().nonnegative(),
  spreadDeg: z.number().nonnegative(),
  /** Hitscan rounds per trigger pull (shotgun). */
  pellets: z.number().int().positive().default(1),
  /** Melee: damage of each hit in a combo, cycling while hits land within comboWindowSec. */
  comboDamage: z.array(z.number().nonnegative()).default([]),
  comboWindowSec: z.number().nonnegative().default(0),
  /** Shove given to whatever is hit (m/s). */
  knockback: z.number().nonnegative().default(0),
  /** 0 = no ammo needed. */
  ammoMax: z.number().int().nonnegative(),
  /** Gunfire alerts pedestrians within this radius. */
  noiseRadius: z.number().nonnegative(),
  /** Can be fired sideways from a moving car. */
  driveBy: z.boolean().default(false),
  projectile: z
    .object({ speed: z.number().positive(), gravity: z.number().positive(), radius: z.number().positive(), blastRadius: z.number().positive(), fuseSec: z.number().positive(), pool: z.number().int().positive() })
    .optional(),
  arc: z.object({ chain: z.number().int().nonnegative(), chainRange: z.number().positive(), stunSec: z.number().positive() }).optional(),
});
export type WeaponDef = z.infer<typeof WeaponSchema>;

export const WeaponsSchema = z
  .object({
    /** Inventory order (weapon switching cycles through owned weapons in this order). */
    order: z.array(z.string()).min(1),
    /** Weapon id to starting ammo. */
    startLoadout: z.record(z.string(), z.number().int().nonnegative()),
    respawnLoadout: z.record(z.string(), z.number().int().nonnegative()),
    weapons: z.record(z.string(), WeaponSchema),
    /** Exploding vehicles. */
    explosion: z.object({
      vehicleRadius: z.number().positive(),
      vehicleDamagePed: z.number().nonnegative(),
      vehicleDamageVehicle: z.number().nonnegative(),
      impulse: z.number().nonnegative(),
      spin: z.number().nonnegative(),
      flipSec: z.number().nonnegative(),
      pedAlarmRadius: z.number().nonnegative(),
      /** Wrecks lighter than this (bikes) crumple instead of blowing up. */
      wreckMinMass: z.number().nonnegative().default(500),
    }),
    /** Drive-by: half-angle of the cone to each side of the car, degrees. */
    driveByConeDeg: z.number().positive().max(180),
  })
  .superRefine((w, ctx) => {
    for (const id of [...w.order, ...Object.keys(w.startLoadout), ...Object.keys(w.respawnLoadout)]) {
      if (!(id in w.weapons)) ctx.addIssue({ code: 'custom', message: `Unknown weapon "${id}"` });
    }
    for (const [id, d] of Object.entries(w.weapons)) {
      if (d.kind === 'projectile' && !d.projectile) ctx.addIssue({ code: 'custom', message: `Weapon "${id}" needs a projectile block` });
      if (d.kind === 'arc' && !d.arc) ctx.addIssue({ code: 'custom', message: `Weapon "${id}" needs an arc block` });
      if (d.kind === 'melee' && d.comboDamage.length === 0) ctx.addIssue({ code: 'custom', message: `Melee weapon "${id}" needs comboDamage` });
    }
  });
export type WeaponsConfig = z.infer<typeof WeaponsSchema>;

export interface SimContent {
  vehicles: VehiclesContent;
  map: MapContent;
  heat: HeatConfig;
  traffic: TrafficConfig;
  peds: PedsConfig;
  weapons: WeaponsConfig;
  props: PropsConfig;
  pickups: PickupsConfig;
  survival: SurvivalConfig;
  weather: WeatherConfig;
  economy: EconomyConfig;
  /** Living city: emergency services, street crews, crowds (life.json). */
  life: LifeConfig;
  /** Crew names, colours and home districts (crews.json). */
  crews: SimCrews;
  /** Side activities and where they sit in this city (null when no activities content is loaded). */
  activities: { config: ActivitiesConfig; sites: ActivitySites } | null;
}

export interface RawSimContent {
  vehicles: unknown;
  map: unknown;
  heat: unknown;
  traffic: unknown;
  peds: unknown;
  weapons: unknown;
  props: unknown;
  pickups: unknown;
  survival: unknown;
  /** Optional: defaults apply when absent. */
  weather?: unknown;
  /** Optional: defaults apply when absent. */
  economy?: unknown;
  life?: unknown;
  crews?: unknown;
  /** Optional: no side activities when absent. */
  activities?: unknown;
}

const sitesCache = new Map<string, ActivitySites>();

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
  const pickups = parse('pickups', PickupsConfigSchema, raw.pickups);
  const survival = parse('survival', SurvivalConfigSchema, raw.survival);
  const weather = parse('weather', WeatherConfigSchema, raw.weather ?? {});
  const economy = parse('economy', EconomyConfigSchema, raw.economy ?? {});
  const life = parse('life', LifeConfigSchema, raw.life ?? {});
  const crews = parse('crews', SimCrewsSchema, raw.crews ?? {});
  checkCombatRefs(vehicles, heat, weapons, pickups);
  checkEconomyRefs(economy, weapons);
  checkLifeRefs(life, crews, vehicles, map);
  let activities: SimContent['activities'] = null;
  if (raw.activities !== undefined) {
    const config = parse('activities', ActivitiesConfigSchema, raw.activities);
    checkActivityRefs(config, vehicles, weapons, map);
    const key = JSON.stringify([raw.map, raw.activities]);
    let sites = sitesCache.get(key);
    if (!sites) {
      sites = placeActivities(map, config);
      sitesCache.set(key, sites);
    }
    const own = JSON.parse(JSON.stringify(sites)) as ActivitySites;
    clearActivitySites(map, own, config);
    activities = { config, sites: own };
  }

  return { vehicles, map, heat, traffic, peds, weapons, props, pickups, survival, weather, economy, life, crews, activities };
}

/** Shop prices must name real weapons. */
function checkEconomyRefs(economy: EconomyConfig, weapons: WeaponsConfig): void {
  for (const id of [...Object.keys(economy.arms.weapons), ...Object.keys(economy.arms.ammo)]) {
    if (!(id in weapons.weapons)) throw new Error(`Economy prices unknown weapon "${id}"`);
  }
}

/** Cross-file references of the side activities: weapons, vehicle classes and variants, districts. */
function checkActivityRefs(a: ActivitiesConfig, vehicles: VehiclesContent, weapons: WeaponsConfig, map: GeneratedMap): void {
  const districts = new Set(map.districts.map((d) => d.id));
  const classes = new Set(Object.values(vehicles.variants).map((v) => v.class));
  for (const r of a.rampages.defs) {
    if (r.weapon && !(r.weapon in weapons.weapons)) throw new Error(`Rampage "${r.id}" gives unknown weapon "${r.weapon}"`);
    if (!districts.has(r.district)) throw new Error(`Rampage "${r.id}" is in unknown district "${r.district}"`);
    if (r.kind === 'takedown' && !r.gang) throw new Error(`Rampage "${r.id}" needs a gang`);
  }
  for (const r of a.races.defs) {
    for (const v of r.opponentVariants) if (!(v in vehicles.variants)) throw new Error(`Race "${r.id}" uses unknown variant "${v}"`);
    if (!districts.has(r.district)) throw new Error(`Race "${r.id}" is in unknown district "${r.district}"`);
  }
  for (const [id, f] of Object.entries(a.fares)) for (const c of f.classes) if (!classes.has(c as VehicleClass)) throw new Error(`Fare job "${id}" uses unknown vehicle class "${c}"`);
}

/** Cross-file references of the combat layer: police variants, pickup weapons. */
function checkCombatRefs(vehicles: VehiclesContent, heat: HeatConfig, weapons: WeaponsConfig, pickups: PickupsConfig): void {
  for (const l of heat.levels) for (const v of l.variants) if (!(v in vehicles.variants)) throw new Error(`HEAT level uses unknown variant "${v}"`);
  if (!(heat.roadblocks.variant in vehicles.variants)) throw new Error(`Roadblock uses unknown variant "${heat.roadblocks.variant}"`);
  for (const [id, k] of Object.entries(pickups.kinds)) {
    if (k.weapon && !(k.weapon in weapons.weapons)) throw new Error(`Pickup "${id}" gives unknown weapon "${k.weapon}"`);
  }
  for (const k of pickups.auto.kinds) if (!(k in pickups.kinds)) throw new Error(`Auto pickup uses unknown kind "${k}"`);
}

/** Living-city references: responder and crew car variants, crews and their home districts. */
function checkLifeRefs(life: LifeConfig, crews: SimCrews, vehicles: VehiclesContent, map: MapContent): void {
  for (const v of [life.services.ambulance, life.services.fireTender]) if (!(v in vehicles.variants)) throw new Error(`Services use unknown variant "${v}"`);
  for (const [id, c] of Object.entries(life.gangs.crews)) {
    const crew = crews[id];
    if (!crew) throw new Error(`Gang config names unknown crew "${id}"`);
    if (!map.districts.some((d) => d.id === crew.district)) throw new Error(`Crew "${id}" lives in unknown district "${crew.district}"`);
    for (const v of c.cars) if (!(v in vehicles.variants)) throw new Error(`Crew "${id}" drives unknown variant "${v}"`);
  }
  for (const pair of life.gangs.rivals) for (const id of pair) if (!(id in life.gangs.crews)) throw new Error(`Rivalry names unknown crew "${id}"`);
}
