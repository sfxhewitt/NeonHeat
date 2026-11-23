import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbStorage, MemoryStorage, SaveManager, applyMissionResult, migrate, newActivities, newSave, newStats } from '@neonheat/save';

describe('save', () => {
  it('creates a fresh save when none exists and round-trips it', async () => {
    const storage = new MemoryStorage();
    const a = new SaveManager(storage);
    expect((await a.load()).credits).toBe(0);
    a.current = applyMissionResult(a.current, 'm1', { credits: 1500, rep: { glasshounds: 10, kurogane: -15 } });
    await a.save(new Date('2026-01-01T00:00:00Z'));
    const b = new SaveManager(storage);
    const loaded = await b.load();
    expect(loaded.credits).toBe(1500);
    expect(loaded.respect).toEqual({ glasshounds: 10, kurogane: -15 });
    expect(loaded.completedMissions).toEqual(['m1']);
    expect(loaded.savedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accumulates respect and unlocks, keeps the best time and does not duplicate completed missions', () => {
    let s = newSave();
    s = applyMissionResult(s, 'm1', { credits: 100, rep: { a: 5 } });
    s = applyMissionResult(s, 'm1', { credits: 100, rep: { a: 5 } });
    expect(s.credits).toBe(200);
    expect(s.respect.a).toBe(10);
    expect(s.completedMissions).toEqual(['m1']);
    expect(s.stats.missionsPassed).toBe(2);
    s = applyMissionResult(s, 'm2', { credits: 0, rep: {}, unlocks: ['safehouse:safehouse_2'] }, 300);
    s = applyMissionResult(s, 'm2', { credits: 0, rep: {}, unlocks: ['safehouse:safehouse_2', 'weapon:smg'] }, 250);
    s = applyMissionResult(s, 'm2', { credits: 0, rep: {} }, 280);
    expect(s.unlocks).toEqual(['safehouse:safehouse_2', 'weapon:smg']);
    expect(s.missions.m2).toEqual({ bestSeconds: 250, passes: 3 });
  });

  it('migrates a version 1 save: rep becomes respect, nothing is lost', () => {
    const v1 = {
      version: 1,
      credits: 1500,
      rep: { glasshounds: 10, kurogane: -15 },
      completedMissions: ['glasshounds_03_hot_chrome'],
      stats: { missionsPassed: 1, playSeconds: 321 },
      savedAt: '2026-11-22T10:00:00.000Z',
    };
    const s = migrate(v1);
    expect(s).toEqual({
      version: 3,
      credits: 1500,
      respect: { glasshounds: 10, kurogane: -15 },
      completedMissions: ['glasshounds_03_hot_chrome'],
      unlocks: [],
      missions: {},
      stats: { ...newStats(), missionsPassed: 1, playSeconds: 321 },
      activities: newActivities(),
      savedAt: '2026-11-22T10:00:00.000Z',
      loadout: null,
      armour: 0,
      cyberware: [],
      exportList: [],
    });
    expect(() => migrate({ ...v1, credits: -5 })).toThrow();
  });

  it('migrates a version 0 save', () => {
    const s = migrate({ money: 250.7, missions: ['old_job'] });
    expect(s.version).toBe(3);
    expect(s.credits).toBe(250);
    expect(s.completedMissions).toEqual(['old_job']);
  });

  it('reads an early v1 save without the newer stats fields, defaulting them to zero', () => {
    const s = migrate({
      version: 1,
      credits: 10,
      rep: {},
      completedMissions: [],
      stats: { missionsPassed: 1, playSeconds: 30 },
      savedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(s.stats).toMatchObject({ missionsPassed: 1, playSeconds: 30, distanceDriven: 0, carsStolen: 0, flatlined: 0, highestHeat: 0 });
  });

  it('migrates a version 2 save to 3: keeps unlocks and progress, starting loadout, no cyberware', () => {
    const v2 = {
      version: 2,
      credits: 3200,
      respect: { rustmouth: 12 },
      completedMissions: ['rustmouth_01_scrap_value'],
      unlocks: ['safehouse:safehouse_2', 'weapon:smg'],
      missions: { rustmouth_01_scrap_value: { bestSeconds: 200, passes: 1 } },
      stats: { missionsPassed: 1, playSeconds: 900 },
      savedAt: '2026-11-23T01:00:00.000Z',
    };
    const s = migrate(v2);
    expect(s.version).toBe(3);
    expect(s.credits).toBe(3200);
    expect(s.unlocks).toEqual(['safehouse:safehouse_2', 'weapon:smg']);
    expect(s.missions.rustmouth_01_scrap_value).toEqual({ bestSeconds: 200, passes: 1 });
    expect(s.loadout).toBeNull();
    expect(s.armour).toBe(0);
    expect(s.cyberware).toEqual([]);
    expect(s.exportList).toEqual([]);
    expect(s.stats.creditsSpent).toBe(0);
    expect(() => migrate({ ...v2, unlocks: 'nope' })).toThrow();
  });

  it('folds live state in before each write (beforeSave) and round-trips the v3 fields', async () => {
    const storage = new MemoryStorage();
    const a = new SaveManager(storage);
    await a.load();
    a.beforeSave = (s) => ({ ...s, loadout: { fists: 0, smg: 77 }, armour: 40, cyberware: ['ghost'], exportList: ['hatch', 'saloon', 'mule'] });
    await a.save();
    const b = new SaveManager(storage);
    const loaded = await b.load();
    expect(loaded.loadout).toEqual({ fists: 0, smg: 77 });
    expect(loaded.armour).toBe(40);
    expect(loaded.cyberware).toEqual(['ghost']);
    expect(loaded.exportList).toEqual(['hatch', 'saloon', 'mule']);
  });

  it('counts credits earned from jobs', () => {
    let s = newSave();
    s = applyMissionResult(s, 'm1', { credits: 1500, rep: {} });
    s = applyMissionResult(s, 'm2', { credits: 500, rep: {} });
    expect(s.stats.creditsEarned).toBe(2000);
  });

  it('migrates a version 2 save to 3: side-activity progress starts empty and the rest is kept', () => {
    const v2 = {
      version: 2,
      credits: 900,
      respect: { glasshounds: 20 },
      completedMissions: ['story_01_first_call'],
      unlocks: ['safehouse:safehouse_1'],
      missions: { story_01_first_call: { bestSeconds: 200, passes: 1 } },
      stats: { ...newStats(), missionsPassed: 1, playSeconds: 600 },
      savedAt: '2026-11-23T01:00:00.000Z',
    };
    const s = migrate(v2);
    expect(s).toMatchObject({ ...v2, version: 3, activities: { rampages: {}, jumps: {}, shards: [], races: {}, fares: {} } });
  });

  it('round-trips side-activity progress: shards, jumps, rampages, races and fares', async () => {
    const storage = new MemoryStorage();
    const a = new SaveManager(storage);
    await a.load();
    a.current.activities = {
      rampages: { glass_hostile_takeover: { passes: 2, bestSec: 51.5 } },
      jumps: { jump_glass_1: { best: 41.2, unique: true } },
      shards: ['shard_glass_1', 'shard_lantern_4'],
      races: { lantern_loop: { wins: 1, finishes: 3, bestSec: 92.31 } },
      fares: { taxi: { done: 7, earned: 3100, bestStreak: 4 } },
    };
    await a.save();
    const b = new SaveManager(storage);
    expect((await b.load()).activities).toEqual(a.current.activities);
    // Partial activity blocks (from a hand-edited or older v3 save) fill in defaults.
    expect(migrate({ ...newSave(), activities: { shards: ['x'] } }).activities).toEqual({ ...newActivities(), shards: ['x'] });
  });

  it('rejects saves from a newer build and falls back to a fresh save', async () => {
    expect(() => migrate({ version: 99 })).toThrow(/newer/);
    const storage = new MemoryStorage();
    await storage.write('slot1', { version: 99 });
    const m = new SaveManager(storage);
    const prevWarn = console.warn;
    console.warn = () => undefined;
    expect((await m.load()).credits).toBe(0);
    console.warn = prevWarn;
  });

  it('persists through IndexedDB', async () => {
    const m = new SaveManager(new IndexedDbStorage('neonheat-test'));
    await m.load();
    m.current = applyMissionResult(m.current, 'x', { credits: 42, rep: {} });
    await m.save();
    const again = new SaveManager(new IndexedDbStorage('neonheat-test'));
    expect((await again.load()).credits).toBe(42);
  });
});
