import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbStorage, MemoryStorage, SaveManager, applyMissionResult, migrate, newSave } from '@neonheat/save';

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
      version: 2,
      credits: 1500,
      respect: { glasshounds: 10, kurogane: -15 },
      completedMissions: ['glasshounds_03_hot_chrome'],
      unlocks: [],
      missions: {},
      stats: { missionsPassed: 1, playSeconds: 321 },
      savedAt: '2026-11-22T10:00:00.000Z',
    });
    expect(() => migrate({ ...v1, credits: -5 })).toThrow();
  });

  it('migrates a version 0 save', () => {
    const s = migrate({ money: 250.7, missions: ['old_job'] });
    expect(s.version).toBe(2);
    expect(s.credits).toBe(250);
    expect(s.completedMissions).toEqual(['old_job']);
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
