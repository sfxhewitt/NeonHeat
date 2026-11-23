import { z } from 'zod';

/** Current save format. Bump and add a migration whenever the shape changes. */
export const SAVE_VERSION = 3;

/**
 * Lifetime stats for the pause menu. Fields added after the first v1 saves
 * default to 0, so older v1 saves still parse without a version bump.
 */
export const StatsSchema = z.object({
  missionsPassed: z.number().int().nonnegative(),
  playSeconds: z.number().nonnegative(),
  distanceDriven: z.number().nonnegative().default(0),
  distanceWalked: z.number().nonnegative().default(0),
  carsStolen: z.number().int().nonnegative().default(0),
  carsWrecked: z.number().int().nonnegative().default(0),
  shotsFired: z.number().int().nonnegative().default(0),
  flatlined: z.number().int().nonnegative().default(0),
  booked: z.number().int().nonnegative().default(0),
  highestHeat: z.number().int().nonnegative().default(0),
  creditsEarned: z.number().int().nonnegative().default(0),
  creditsSpent: z.number().int().nonnegative().default(0),
  exportsDelivered: z.number().int().nonnegative().default(0),
});
export type SaveStats = z.infer<typeof StatsSchema>;

export function newStats(): SaveStats {
  return StatsSchema.parse({ missionsPassed: 0, playSeconds: 0 });
}

/** Version 1 (Phase 0): credits, rep, completed missions. Kept to read old saves. */
export const SaveV1Schema = z.object({
  version: z.literal(1),
  credits: z.number().int().nonnegative(),
  rep: z.record(z.string(), z.number()),
  completedMissions: z.array(z.string()),
  stats: StatsSchema,
  savedAt: z.string(),
});

/** Best run of one mission, for the job list and the completion card. */
export const MissionRecordSchema = z.object({
  bestSeconds: z.number().nonnegative(),
  passes: z.number().int().nonnegative(),
});

/**
 * Version 2: respect per crew (was `rep`), unlocks (safehouses, shops,
 * weapons) and a record per mission.
 */
export const SaveV2Schema = z.object({
  version: z.literal(2),
  credits: z.number().int().nonnegative(),
  /** Respect with each crew; negative for crews you crossed. */
  respect: z.record(z.string(), z.number()),
  completedMissions: z.array(z.string()),
  /** `safehouse:<marker>`, `shop:<marker>`, `weapon:<id>`, ... */
  unlocks: z.array(z.string()),
  missions: z.record(z.string(), MissionRecordSchema),
  stats: StatsSchema,
  savedAt: z.string(),
});

/**
 * Side activities (mirrors the sim's ActivityProgress): rampages passed, best
 * jumps and unique jumps, data shards found, race records and fare work.
 */
export const ActivitiesSaveSchema = z.object({
  rampages: z.record(z.string(), z.object({ passes: z.number().int().nonnegative(), bestSec: z.number().nonnegative() })).default({}),
  jumps: z.record(z.string(), z.object({ best: z.number().nonnegative(), unique: z.boolean() })).default({}),
  shards: z.array(z.string()).default([]),
  races: z.record(z.string(), z.object({ wins: z.number().int().nonnegative(), finishes: z.number().int().nonnegative(), bestSec: z.number().nonnegative() })).default({}),
  fares: z.record(z.string(), z.object({ done: z.number().int().nonnegative(), earned: z.number().nonnegative(), bestStreak: z.number().int().nonnegative() })).default({}),
});
export type ActivitiesSave = z.infer<typeof ActivitiesSaveSchema>;

export function newActivities(): ActivitiesSave {
  return { rampages: {}, jumps: {}, shards: [], races: {}, fares: {} };
}


/**
 * Version 3: the economy. What you carry (weapons and ammo, armour), the
 * cyberware you have installed and the chop shops' export list. Owned
 * safehouses and bought weapons stay in `unlocks` (`safehouse:<marker>`,
 * `weapon:<id>`).
 */
export const SaveV3Schema = SaveV2Schema.extend({
  version: z.literal(3),
  /** Weapon id to ammo carried; null means the starting loadout (a fresh save). */
  loadout: z.record(z.string(), z.number().int().nonnegative()).nullable(),
  armour: z.number().nonnegative(),
  /** Installed cyberware ids (reflex, plating, ghost). */
  cyberware: z.array(z.string()),
  /** Variant ids the chop shops want; empty means roll a new list. */
  exportList: z.array(z.string()),
  /** Side activities: rampages, jumps, shards, races, fares. */
  activities: ActivitiesSaveSchema.default({ rampages: {}, jumps: {}, shards: [], races: {}, fares: {} }),
});
export const SaveSchema = SaveV3Schema;
export type SaveData = z.infer<typeof SaveV3Schema>;

export function newSave(): SaveData {
  return {
    version: 3,
    credits: 0,
    respect: {},
    completedMissions: [],
    unlocks: [],
    missions: {},
    stats: newStats(),
    activities: newActivities(),
    savedAt: new Date(0).toISOString(),
    loadout: null,
    armour: 0,
    cyberware: [],
    exportList: [],
  };
}

type Migration = (old: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrations from version N to N+1. Version 0 was the pre-release prototype
 * format `{ money, missions }`; kept as the worked example of a migration.
 */
export const MIGRATIONS: Record<number, Migration> = {
  0: (old) => ({
    version: 1,
    credits: Math.max(0, Math.floor(Number(old.money ?? 0))),
    rep: {},
    completedMissions: Array.isArray(old.missions) ? old.missions.map(String) : [],
    stats: { missionsPassed: Array.isArray(old.missions) ? old.missions.length : 0, playSeconds: 0 },
    savedAt: new Date(0).toISOString(),
  }),
  1: (old) => {
    const { rep, ...rest } = SaveV1Schema.parse(old);
    return { ...rest, version: 2, respect: { ...rep }, unlocks: [], missions: {} };
  },
  2: (old) => ({ ...SaveV2Schema.parse(old), version: 3, loadout: null, armour: 0, cyberware: [], exportList: [], activities: newActivities() }),
};

/** Bring any known older save up to the current version and validate it. */
export function migrate(raw: unknown): SaveData {
  if (typeof raw !== 'object' || raw === null) throw new Error('Save is not an object');
  let data = raw as Record<string, unknown>;
  let version = typeof data.version === 'number' ? data.version : 0;
  if (version > SAVE_VERSION) throw new Error(`Save version ${version} is newer than this build (${SAVE_VERSION})`);
  while (version < SAVE_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`No migration from save version ${version}`);
    data = step(data);
    version = data.version as number;
  }
  return SaveSchema.parse(data);
}

export interface MissionRewards {
  credits: number;
  /** Respect change per crew. */
  rep: Record<string, number>;
  unlocks?: readonly string[];
}

/** Record a passed mission: pay, respect, unlocks and the mission's best time. */
export function applyMissionResult(save: SaveData, missionId: string, rewards: MissionRewards, seconds?: number): SaveData {
  const respect = { ...save.respect };
  for (const [k, v] of Object.entries(rewards.rep)) respect[k] = (respect[k] ?? 0) + v;
  const unlocks = [...save.unlocks];
  for (const u of rewards.unlocks ?? []) if (!unlocks.includes(u)) unlocks.push(u);
  const prev = save.missions[missionId];
  let best = prev?.bestSeconds ?? 0;
  if (seconds !== undefined) best = best > 0 ? Math.min(best, seconds) : seconds;
  return {
    ...save,
    credits: save.credits + rewards.credits,
    respect,
    unlocks,
    missions: { ...save.missions, [missionId]: { bestSeconds: best, passes: (prev?.passes ?? 0) + 1 } },
    completedMissions: save.completedMissions.includes(missionId) ? save.completedMissions : [...save.completedMissions, missionId],
    stats: { ...save.stats, missionsPassed: save.stats.missionsPassed + 1, creditsEarned: save.stats.creditsEarned + rewards.credits },
  };
}

/** Where saves live. IndexedDB in the browser; memory in tests. */
export interface SaveStorage {
  read(slot: string): Promise<unknown>;
  write(slot: string, data: unknown): Promise<void>;
}

export class MemoryStorage implements SaveStorage {
  readonly data = new Map<string, unknown>();
  async read(slot: string): Promise<unknown> {
    return structuredClone(this.data.get(slot));
  }
  async write(slot: string, value: unknown): Promise<void> {
    this.data.set(slot, structuredClone(value));
  }
}

export class IndexedDbStorage implements SaveStorage {
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly name = 'neonheat',
    private readonly factory: IDBFactory = indexedDB,
  ) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = this.factory.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('saves');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  async read(slot: string): Promise<unknown> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('saves', 'readonly').objectStore('saves').get(slot);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async write(slot: string, data: unknown): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('saves', 'readwrite');
      tx.objectStore('saves').put(data, slot);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

/** Load-or-create, plus write with a timestamp. */
export class SaveManager {
  current: SaveData = newSave();
  lastSaved = 0;
  /** Called before each write, to fold live state (loadout, economy) into the save. */
  beforeSave: ((s: SaveData) => SaveData) | null = null;

  constructor(
    private readonly storage: SaveStorage,
    private readonly slot = 'slot1',
  ) {}

  async load(): Promise<SaveData> {
    const raw = await this.storage.read(this.slot);
    if (raw === undefined || raw === null) {
      this.current = newSave();
      return this.current;
    }
    try {
      this.current = migrate(raw);
    } catch (err) {
      console.warn('Save could not be read, starting fresh', err);
      this.current = newSave();
    }
    return this.current;
  }

  async save(now = new Date()): Promise<void> {
    if (this.beforeSave) this.current = this.beforeSave(this.current);
    this.current = { ...this.current, savedAt: now.toISOString() };
    await this.storage.write(this.slot, this.current);
    this.lastSaved = now.getTime();
  }
}
