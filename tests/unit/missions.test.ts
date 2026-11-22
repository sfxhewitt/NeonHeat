import { describe, expect, it } from 'vitest';
import { rawContent, rawMissions } from '@neonheat/content';
import { HackSession, MissionDirector, MissionRunner, lintMission, loadMissionContent, parseMission, type Mission, type MissionHost } from '@neonheat/missions';
import { Rng } from '@neonheat/sim';
import { intents, loadContent, makeWorld, run } from './helpers';

const mc = loadMissionContent(rawContent, rawMissions);
const hotChrome = mc.missions[0]!;

/** A scriptable fake host for pure runner tests. */
class FakeHost implements MissionHost {
  player = { x: 0, z: 0 };
  driving = -1;
  health = 1;
  destroyed = false;
  log: string[] = [];
  heat = 0;
  trace = 0;
  squads = 0;
  hackable = false;
  checkpoints = 0;
  restored = 0;
  resolve(ref: string) {
    if (ref === 'marker:kurogane_lot') return { x: 100, z: 0 };
    if (ref === 'marker:gh_chopshop') return { x: -100, z: 0 };
    return { x: 100, z: 5 };
  }
  ensureVehicle() {
    return 7;
  }
  vehicleHealth() {
    return this.health;
  }
  vehicleDestroyed() {
    return this.destroyed;
  }
  playerVehicle() {
    return this.driving;
  }
  playerPos() {
    return this.player;
  }
  setHackable(_id: number, on: boolean) {
    this.hackable = on;
  }
  setLocked() {}
  dialogue(line: string) {
    this.log.push(line);
  }
  setHeat(v: number) {
    this.heat = v;
  }
  addTrace(v: number) {
    this.trace += v;
  }
  spawnSquad() {
    this.squads++;
  }
  cleanup() {}
  captureCheckpoint() {
    return ++this.checkpoints;
  }
  restoreCheckpoint() {
    this.restored++;
  }
}

function tick(r: MissionRunner, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) r.tick(1 / 60);
}

describe('mission schema', () => {
  it('parses the shipped mission and rejects bad data', () => {
    expect(hotChrome.objectives.map((o) => o.type)).toEqual(['reach', 'hack', 'deliverVehicle']);
    expect(() => parseMission({ ...hotChrome, objectives: [{ id: 'x', type: 'teleport' }] })).toThrow();
    expect(() => parseMission({ ...hotChrome, budgetMinutes: 20 })).toThrow();
    const dup = structuredClone(hotChrome) as Mission;
    dup.objectives[1]!.id = dup.objectives[0]!.id;
    expect(() => parseMission(dup)).toThrow(/duplicate/);
  });
});

describe('MissionRunner', () => {
  it('runs reach → hack → deliver with events, then completes', () => {
    const h = new FakeHost();
    const r = new MissionRunner(hotChrome, h);
    let done = false;
    r.onComplete = () => (done = true);
    r.start();
    expect(h.log).toEqual(['gh_03_intro']);
    expect(r.view.text).toMatch(/marker/);
    h.player = { x: 98, z: 0 };
    tick(r, 0.1);
    expect(r.objective?.id).toBe('hack_car');
    expect(h.hackable).toBe(true);
    r.reportHack(false);
    expect(h.trace).toBe(40);
    expect(r.objective?.id).toBe('hack_car');
    r.reportHack(true);
    tick(r, 0.1);
    expect(r.objective?.id).toBe('deliver');
    expect(h.heat).toBe(2);
    expect(h.squads).toBe(0);
    tick(r, 20);
    expect(h.squads).toBe(1);
    expect(r.view.text).toMatch(/Get in/);
    h.driving = 7;
    h.player = { x: -97, z: 1 };
    tick(r, 0.1);
    expect(done).toBe(true);
    expect(r.state).toBe('complete');
  });

  it('fails delivery on time, damage or destruction, and retries from the checkpoint', () => {
    for (const cause of ['time', 'damage', 'wreck'] as const) {
      const h = new FakeHost();
      const r = new MissionRunner(hotChrome, h);
      r.start();
      h.player = { x: 100, z: 0 };
      tick(r, 0.1);
      r.reportHack(true);
      tick(r, 0.1);
      expect(r.objective?.id).toBe('deliver');
      if (cause === 'time') tick(r, 181);
      if (cause === 'damage') {
        h.health = 0.4;
        tick(r, 0.1);
      }
      if (cause === 'wreck') {
        h.destroyed = true;
        tick(r, 0.1);
      }
      expect(r.state).toBe('failed');
      expect(r.failReason).toMatch(cause === 'time' ? /time/ : cause === 'damage' ? /damaged/ : /wrecked/);
      h.health = 1;
      h.destroyed = false;
      r.retry();
      expect(h.restored).toBe(1);
      expect(r.state).toBe('running');
      expect(r.objective?.id).toBe('deliver');
      expect(r.attempts).toBe(2);
    }
  });

  it('instant restart rewinds to the first objective', () => {
    const h = new FakeHost();
    const r = new MissionRunner(hotChrome, h);
    r.start();
    h.player = { x: 100, z: 0 };
    tick(r, 0.1);
    r.restart();
    expect(r.objective?.id).toBe('goto_lot');
    expect(h.restored).toBe(1);
  });
});

describe('sequence hack', () => {
  it('shows a sequence, accepts it in order and succeeds in about ten seconds', () => {
    const h = new HackSession(new Rng(1), 2);
    expect(h.sequence.length).toBe(5);
    expect(h.showTime + h.inputTime).toBeGreaterThan(7);
    expect(h.showTime + h.inputTime).toBeLessThan(13);
    expect(h.tap(h.sequence[0]!)).toBe(false); // not during show
    let lit = 0;
    while (h.phase === 'show') {
      if (h.litNode >= 0) lit++;
      h.tick(1 / 60);
    }
    expect(lit).toBeGreaterThan(0);
    for (const n of h.sequence) h.tap(n);
    expect(h.phase).toBe('success');
  });

  it('fails on a wrong tap or on time-out', () => {
    const a = new HackSession(new Rng(2), 1);
    while (a.phase === 'show') a.tick(0.1);
    a.tap((a.sequence[0]! + 1) % 6);
    expect(a.phase).toBe('fail');
    const b = new HackSession(new Rng(3), 1);
    for (let i = 0; i < 200 && !b.done; i++) b.tick(0.1);
    expect(b.phase).toBe('fail');
  });
});

describe('mission-lint', () => {
  const sim = loadContent();
  const ctx = { map: sim.map, vehicles: sim.vehicles, squads: mc.squads, dialogue: mc.dialogue };
  it('passes the shipped mission', () => {
    expect(lintMission(hotChrome, ctx)).toEqual([]);
  });
  it('catches bad references and unreachable targets', () => {
    const bad = structuredClone(hotChrome) as Mission;
    bad.objectives[0] = { ...bad.objectives[0]!, onStart: [{ do: 'dialogue', line: 'nope' }] } as Mission['objectives'][number];
    (bad.objectives[2] as { target: string }).target = 'marker:missing';
    bad.giver.pos = [-14, 0, -12]; // inside the centre tower
    const msgs = lintMission(bad, ctx).map((i) => i.message);
    expect(msgs.some((m) => /dialogue/.test(m))).toBe(true);
    expect(msgs.some((m) => /unknown marker/.test(m))).toBe(true);
    expect(msgs.some((m) => /payphone/.test(m))).toBe(true);
  });
});

describe('MissionDirector in the world', () => {
  it('answering the payphone starts the job; a failed job retries from its checkpoint', async () => {
    const content = loadContent();
    content.traffic.count = 0;
    content.peds.count = 0;
    const w = await makeWorld(1, content);
    const d = new MissionDirector(w, mc.missions, mc.squads, mc.dialogue);
    const g = hotChrome.giver.pos;
    w.playerCtl.teleport(g[0], g[2] + 1);
    const step = (i = intents()) => {
      w.step(i);
      d.tick(1 / 60);
    };
    step();
    expect(w.playerCtl.context?.label).toBe('ANSWER');
    step(intents({ interact: true }));
    expect(d.runner?.state).toBe('running');
    expect(w.interactables.some((i) => i.id.startsWith('giver:'))).toBe(false);
    // Skip ahead: stand at the lot, hack the car.
    const lot = w.content.map.markers['kurogane_lot']!.pos;
    w.playerCtl.teleport(lot[0], lot[2]);
    step();
    expect(d.runner?.objective?.id).toBe('hack_car');
    const car = w.vehicles[d.runner!.view.vehicleId]!;
    expect(car.locked && car.hackable).toBe(true);
    w.playerCtl.teleport(car.x + 2.6, car.z);
    step();
    expect(w.playerCtl.context?.kind).toBe('hack');
    step(intents({ interact: true }));
    expect(d.hack).not.toBeNull();
    while (d.hack && d.hack.phase === 'show') step();
    for (const n of d.hack!.sequence) d.hackTap(n);
    step();
    expect(d.runner?.objective?.id).toBe('deliver');
    expect(car.locked).toBe(false);
    expect(w.heat.level).toBe(2);
    // Wreck the prototype: the job fails, then retry restores it at the lot.
    w.damageVehicle(car, 1e6);
    step();
    expect(d.runner?.state).toBe('failed');
    d.retry();
    step();
    const restored = w.vehicles[d.runner!.view.vehicleId]!;
    expect(restored.destroyed).toBe(false);
    expect(Math.hypot(restored.x - car.x, restored.z - car.z)).toBeLessThan(3);
    run(w, 0.1, intents());
  });
});
