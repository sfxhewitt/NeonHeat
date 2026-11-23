import { describe, expect, it } from 'vitest';
import { rawContent, rawMissions } from '@neonheat/content';
import {
  HackSession,
  MissionDirector,
  OBJECTIVE_TYPES,
  lintCampaign,
  lintMission,
  loadMissionContent,
  parseMission,
  prerequisitesMet,
  type Mission,
} from '@neonheat/missions';
import { Rng, type World } from '@neonheat/sim';
import { intents, loadContent, makeWorld, movePlayer, run } from './helpers';

const mc = loadMissionContent(rawContent, rawMissions);
const byId = (id: string): Mission => mc.missions.find((m) => m.id === id)!;
const hotChrome = byId('glasshounds_03_hot_chrome');
const sim = loadContent();
const ctx = { map: sim.map, vehicles: sim.vehicles, squads: mc.squads, dialogue: mc.dialogue, crews: mc.crews, heatMax: 5 };

describe('mission content', () => {
  it('has at least 24 missions, four or more per crew, a story thread and every objective type', () => {
    expect(mc.missions.length).toBeGreaterThanOrEqual(24);
    for (const crew of Object.keys(mc.crews)) expect(mc.missions.filter((m) => m.faction === crew && !m.story).length).toBeGreaterThanOrEqual(4);
    const story = mc.missions.filter((m) => m.story);
    expect(story.length).toBeGreaterThanOrEqual(5);
    const used = new Set(mc.missions.flatMap((m) => m.objectives.map((o) => o.type)));
    for (const t of OBJECTIVE_TYPES) expect(used, t).toContain(t);
    for (const m of mc.missions) {
      expect(m.budgetMinutes).toBeGreaterThanOrEqual(3);
      expect(m.budgetMinutes).toBeLessThanOrEqual(8);
    }
  });

  it('squads only use the shipped variants', () => {
    for (const s of Object.values(mc.squads)) expect(['kestrel', 'vandal', 'brick', 'interceptor', 'enforcer', 'prototype']).toContain(s.variant);
  });

  it('every mission lints clean against the generated city, and the campaign hangs together', () => {
    const errors = mc.missions.flatMap((m) => lintMission(m, ctx)).filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(lintCampaign(mc.missions, mc.crews).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('player-facing dialogue avoids American spellings we know about', () => {
    const text = Object.values(mc.dialogue)
      .map((d) => d.text)
      .join(' ');
    expect(text).not.toMatch(/\b(color|favor|center|realize|organize|apologize)\b/i);
  });
});

describe('mission schema', () => {
  it('parses marker refs and the old pos form, and rejects bad data', () => {
    expect(hotChrome.objectives.map((o) => o.type)).toEqual(['reach', 'hack', 'deliverVehicle']);
    expect(hotChrome.giver.at).toBe('marker:ashgrove_payphone_1');
    const legacy = { ...structuredClone(hotChrome), giver: { type: 'payphone', pos: [1, 0, 2] } };
    expect(parseMission(legacy).giver.pos).toEqual([1, 0, 2]);
    expect(() => parseMission({ ...hotChrome, giver: { type: 'payphone' } })).toThrow();
    expect(() => parseMission({ ...hotChrome, objectives: [{ id: 'x', type: 'teleport' }] })).toThrow();
    expect(() => parseMission({ ...hotChrome, budgetMinutes: 20 })).toThrow();
    expect(() => parseMission({ ...hotChrome, prerequisites: { missions: [hotChrome.id] } })).toThrow();
    const dup = structuredClone(hotChrome) as Mission;
    dup.objectives[1]!.id = dup.objectives[0]!.id;
    expect(() => parseMission(dup)).toThrow(/duplicate/);
  });
});

describe('mission-lint', () => {
  it('catches bad references, unreachable payphones and unknown squads', () => {
    const bad = structuredClone(hotChrome) as Mission;
    bad.objectives[0] = { ...bad.objectives[0]!, onStart: [{ do: 'dialogue', line: 'nope' }] } as Mission['objectives'][number];
    (bad.objectives[2] as { target: string }).target = 'marker:missing';
    (bad.objectives[1] as { target: string }).target = 'spawn:nowhere';
    bad.onStart = [{ do: 'spawnSquad', squad: 'ghosts' }];
    const tower = sim.map.buildings.find((b) => b.w > 12 && b.d > 12)!;
    bad.giver = { type: 'payphone', pos: [tower.x, 0, tower.z] }; // inside a building
    const msgs = lintMission(bad, ctx).map((i) => i.message);
    expect(msgs.some((m) => /dialogue/.test(m))).toBe(true);
    expect(msgs.some((m) => /unknown marker/.test(m))).toBe(true);
    expect(msgs.some((m) => /unknown spawn/.test(m))).toBe(true);
    expect(msgs.some((m) => /squad/.test(m))).toBe(true);
    expect(msgs.some((m) => /payphone/.test(m))).toBe(true);
  });

  it('finds prerequisite cycles, unknown prerequisites and missions nobody can reach', () => {
    const a = { ...structuredClone(hotChrome), id: 'a', prerequisites: { missions: ['b'] } } as Mission;
    const b = { ...structuredClone(hotChrome), id: 'b', prerequisites: { missions: ['a'] } } as Mission;
    const c = { ...structuredClone(hotChrome), id: 'c', prerequisites: { missions: ['ghost'] } } as Mission;
    const d = { ...structuredClone(hotChrome), id: 'd', prerequisites: { respect: { glasshounds: 999 } } } as Mission;
    const msgs = lintCampaign([a, b, c, d], mc.crews).map((i) => `${i.mission}: ${i.message}`);
    expect(msgs.some((m) => /cycle/.test(m))).toBe(true);
    expect(msgs.some((m) => /c: unknown mission "ghost"/.test(m))).toBe(true);
    expect(msgs.some((m) => /d: cannot be reached/.test(m))).toBe(true);
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

async function quietWorld(): Promise<World> {
  const content = loadContent();
  content.traffic.count = 0;
  content.peds.count = 0;
  return makeWorld(1, content);
}

describe('MissionDirector payphones and progress', () => {
  it('a new game rings only the tutorial; progress opens several crew-coloured payphones at once', async () => {
    const w = await quietWorld();
    const d = new MissionDirector(w, mc.missions, mc.squads, mc.dialogue, { crews: mc.crews });
    expect(d.givers.map((g) => g.missionId)).toEqual(['story_01_first_call']);
    expect(d.givers[0]!.colour).toBe(mc.crews.glasshounds!.colour);
    expect(w.interactables.filter((i) => i.id.startsWith('giver:')).length).toBe(1);
    let changed = 0;
    d.onGiversChanged = () => changed++;
    d.setProgress({ completed: ['story_01_first_call'], respect: {} });
    expect(changed).toBe(1);
    const crews = new Set(d.givers.map((g) => g.crew));
    expect(crews.size).toBeGreaterThanOrEqual(4);
    for (const g of d.givers) expect(g.colour).toBe(mc.crews[g.crew]!.colour);
    // Every ringing job really is available.
    for (const g of d.givers) expect(prerequisitesMet(byId(g.missionId), d.getProgress())).toBe(true);
    // Respect gates: the finale needs Glasshounds respect as well as Dead Air.
    const finale = byId('story_06_lattice_fall');
    expect(prerequisitesMet(finale, { completed: ['story_05_dead_air'], respect: { glasshounds: 5 } })).toBe(false);
    expect(prerequisitesMet(finale, { completed: ['story_05_dead_air'], respect: { glasshounds: 30 } })).toBe(true);
    w.dispose();
  });

  it('the tutorial teaches with hint lines', async () => {
    const w = await quietWorld();
    const d = new MissionDirector(w, mc.missions, mc.squads, mc.dialogue, { crews: mc.crews });
    const hints: string[] = [];
    d.host.onHint = (text) => hints.push(text);
    const g = d.givers[0]!;
    movePlayer(w, g.x, g.z + 1);
    w.step(intents({ interact: true }));
    d.tick(1 / 60);
    expect(d.runner?.mission.id).toBe('story_01_first_call');
    run(w, 1, intents());
    for (let i = 0; i < 60; i++) d.tick(1 / 60);
    expect(hints.length).toBeGreaterThan(0);
    w.dispose();
  });
});

describe('MissionDirector in the world: Hot Chrome', () => {
  const ready = { completed: ['story_01_first_call', 'glasshounds_01_window_shopping', 'glasshounds_02_test_drive'], respect: { glasshounds: 16 } };

  async function begin(): Promise<{ w: World; d: MissionDirector; step: (i?: ReturnType<typeof intents>) => void }> {
    const w = await quietWorld();
    const d = new MissionDirector(w, mc.missions, mc.squads, mc.dialogue, { crews: mc.crews });
    d.setProgress(ready);
    const step = (i = intents()): void => {
      w.step(i);
      d.tick(1 / 60);
    };
    const g = d.givers.find((x) => x.missionId === hotChrome.id)!;
    expect(g).toBeDefined();
    movePlayer(w, g.x, g.z + 1);
    step();
    expect(w.playerCtl.context?.label).toBe('ANSWER');
    step(intents({ interact: true }));
    expect(d.runner?.mission.id).toBe(hotChrome.id);
    expect(d.givers.length).toBe(0);
    const lot = w.content.map.markers['glass_lot_2']!.pos;
    movePlayer(w, lot[0], lot[2]);
    step();
    expect(d.runner?.objective?.id).toBe('hack_car');
    return { w, d, step };
  }

  function hack(w: World, d: MissionDirector, step: (i?: ReturnType<typeof intents>) => void): void {
    const car = w.vehicles[d.runner!.view.vehicleId]!;
    movePlayer(w, car.x + 2.6, car.z);
    step();
    expect(w.playerCtl.context?.kind).toBe('hack');
    step(intents({ interact: true }));
    expect(d.hack).not.toBeNull();
    while (d.hack && d.hack.phase === 'show') step();
    for (const n of d.hack!.sequence) d.hackTap(n);
    step();
  }

  it('answering the payphone starts the job; a failed job retries from its checkpoint', async () => {
    const { w, d, step } = await begin();
    const car = w.vehicles[d.runner!.view.vehicleId]!;
    expect(car.locked && car.hackable).toBe(true);
    hack(w, d, step);
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
    // Too damaged to sell: the retry hands back a sound car, so it does not fail again at once.
    for (let i = 0; i < 60; i++) step();
    w.damageVehicle(restored, restored.params.maxHealth * 0.6);
    step();
    expect(d.runner?.failReason).toMatch(/damaged/);
    d.retry();
    step();
    expect(d.runner?.state).toBe('running');
    expect(w.vehicleHealth(w.vehicles[d.runner!.view.vehicleId]!)).toBe(1);
    w.dispose();
  });

  it('a target shunted during the hack goes back to its spot on retry', async () => {
    const { w, d, step } = await begin();
    const car = w.vehicles[d.runner!.view.vehicleId]!;
    const spawn = { x: car.x, z: car.z, yaw: car.yaw };
    // A police car shoves the locked target 6 m before the hack finishes.
    w.teleportVehicle(car, spawn.x + 6, spawn.z - 3, spawn.yaw + 0.6);
    hack(w, d, step);
    expect(d.runner?.objective?.id).toBe('deliver');
    w.damageVehicle(car, 1e6);
    step();
    d.retry();
    step();
    const restored = w.vehicles[d.runner!.view.vehicleId]!;
    expect(Math.hypot(restored.x - spawn.x, restored.z - spawn.z)).toBeLessThan(0.5);
    w.dispose();
  });

  it('delivering completes the job with time, damage, pay and respect in the result', async () => {
    const { w, d, step } = await begin();
    hack(w, d, step);
    const results: string[] = [];
    d.onComplete = (r) => results.push(r.missionId);
    const car = w.vehicles[d.runner!.view.vehicleId]!;
    // Get in, then put the car on the drop-off.
    movePlayer(w, car.x + 2.6, car.z);
    step(intents({ interact: true }));
    for (let i = 0; i < 30 && w.player.vehicle !== car; i++) step();
    expect(w.player.vehicle).toBe(car);
    const shop = w.content.map.markers['chopshop_1']!.pos;
    w.teleportVehicle(car, shop[0], shop[2], car.yaw);
    for (let i = 0; i < 120 && d.completed.length === 0; i++) step(intents({ brake: 1 }));
    const r = d.completed[0]!;
    expect(r).toBeDefined();
    expect(results).toEqual([hotChrome.id]);
    expect(r.seconds).toBeGreaterThan(0);
    expect(r.pay.total).toBe(hotChrome.rewards.credits);
    expect(r.respect).toEqual(hotChrome.rewards.rep);
    expect(r.damage.hull).toBeGreaterThanOrEqual(0);
    expect(d.getProgress().completed).toContain(hotChrome.id);
    expect(d.getProgress().respect.glasshounds).toBe(16 + hotChrome.rewards.rep.glasshounds!);
    // The next Glasshounds job now rings.
    expect(d.givers.some((g) => g.missionId === 'glasshounds_04_repo_job')).toBe(d.getProgress().respect.glasshounds! >= 25);
    w.dispose();
  });
});
