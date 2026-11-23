import { describe, expect, it } from 'vitest';
import { MissionRunner, OBJECTIVE_TYPES, parseMission, type Mission } from '@neonheat/missions';
import { FakeHost } from './fake-host';

/** A one-objective mission around `objective`. */
function mission(objectives: unknown[], extra: Record<string, unknown> = {}): Mission {
  return parseMission({
    id: 'test_job',
    faction: 'glasshounds',
    title: 'Test',
    giver: { type: 'payphone', at: 'marker:ashgrove_payphone_1' },
    budgetMinutes: 5,
    objectives,
    rewards: { credits: 100, rep: { glasshounds: 5 } },
    failPolicy: 'checkpoint',
    ...extra,
  });
}

function tick(r: MissionRunner, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) r.tick(1 / 60);
}

function run(objectives: unknown[], host = new FakeHost(), extra: Record<string, unknown> = {}): { r: MissionRunner; h: FakeHost } {
  const r = new MissionRunner(mission(objectives, extra), host);
  r.start();
  return { r, h: host };
}

describe('mission schema', () => {
  it('knows every objective type', () => {
    expect([...OBJECTIVE_TYPES].sort()).toEqual(
      ['chase', 'collect', 'deliverVehicle', 'destroyVehicle', 'dropOff', 'eliminate', 'escape', 'hack', 'perform', 'photograph', 'protect', 'race', 'reach', 'stealVehicle', 'tail', 'wait'].sort(),
    );
  });

  it('rejects contradictory or out-of-range objectives', () => {
    expect(() => mission([{ id: 'a', type: 'stealVehicle' }])).toThrow(/exactly one/);
    expect(() => mission([{ id: 'a', type: 'stealVehicle', vehicle: 'spawn:x', variants: ['vandal'] }])).toThrow(/exactly one/);
    expect(() => mission([{ id: 'a', type: 'protect', target: 'actor:vip', destination: 'marker:plaza' }])).toThrow(/escorted/);
    expect(() => mission([{ id: 'a', type: 'protect', target: 'spawn:van' }])).toThrow(/exactly one/);
    expect(() => mission([{ id: 'a', type: 'tail', target: 'spawn:x', route: ['marker:plaza'], minRange: 80, maxRange: 50 }])).toThrow(/minRange/);
    expect(() => mission([{ id: 'a', type: 'eliminate', targets: ['actor:a'], count: 2 }])).toThrow(/count/);
    expect(() => mission([{ id: 'a', type: 'reach', target: 'marker:plaza', timeLimitSec: 900 }])).toThrow(/budget/);
    expect(() => mission([{ id: 'a', type: 'reach', target: 'plaza' }])).toThrow();
    expect(() => mission([{ id: 'a', type: 'reach', target: 'marker:plaza' }], { giver: { type: 'payphone' } })).toThrow(/exactly one/);
    // The legacy absolute payphone position still parses.
    expect(mission([{ id: 'a', type: 'reach', target: 'marker:plaza' }], { giver: { type: 'payphone', pos: [1, 0, 2] } }).giver.pos).toEqual([1, 0, 2]);
  });
});

describe('MissionRunner objective types', () => {
  it('reach honours the vehicle requirement', () => {
    const h = new FakeHost().at('marker:plaza', 100, 0);
    const { r } = run([{ id: 'a', type: 'reach', target: 'marker:plaza', vehicle: 'none' }], h);
    h.player = { x: 99, z: 0 };
    h.driving = 3;
    tick(r, 0.1);
    expect(r.state).toBe('running');
    expect(r.view.text).toMatch(/foot/);
    h.driving = -1;
    tick(r, 0.1);
    expect(r.state).toBe('complete');
  });

  it('stealVehicle: a particular car, or any car of a class', () => {
    const h = new FakeHost().at('spawn:mark', 20, 0);
    const { r } = run([{ id: 'a', type: 'stealVehicle', vehicle: 'spawn:mark' }], h);
    expect(r.view.text).toBe('Steal the car');
    h.driving = 99;
    tick(r, 0.1);
    expect(r.state).toBe('running');
    h.put('spawn:mark', true);
    tick(r, 0.1);
    expect(r.state).toBe('complete');

    const h2 = new FakeHost();
    const r2 = run([{ id: 'a', type: 'stealVehicle', variants: ['vandal'] }], h2).r;
    expect(r2.view.text).toBe('Steal a Vandal');
    h2.variants.set(5, 'kestrel');
    h2.driving = 5;
    tick(r2, 0.1);
    expect(r2.state).toBe('running');
    h2.variants.set(6, 'vandal');
    h2.driving = 6;
    tick(r2, 0.1);
    expect(r2.state).toBe('complete');
  });

  it('destroyVehicle counts wrecks and fails if a target reaches the escape point', () => {
    const h = new FakeHost().at('spawn:a', 10, 0).at('spawn:b', 20, 0).at('marker:bridge_east', 300, 0);
    const { r } = run([{ id: 'a', type: 'destroyVehicle', targets: ['spawn:a', 'spawn:b'], escapeAt: 'marker:bridge_east' }], h);
    expect(r.view.markerCount).toBe(2);
    h.destroyed.add('spawn:a');
    tick(r, 0.1);
    expect(r.view.progress).toBe('1/2');
    h.at('spawn:b', 299, 0);
    tick(r, 0.1);
    expect(r.state).toBe('failed');
    expect(r.failReason).toMatch(/got away/);
    r.retry();
    h.at('spawn:b', 20, 0);
    h.destroyed.add('spawn:b');
    tick(r, 0.1);
    expect(r.state).toBe('complete');
  });

  it('eliminate completes when enough targets are down', () => {
    const h = new FakeHost().at('actor:a', 5, 5).at('actor:b', 6, 6).at('actor:c', 7, 7);
    const { r } = run([{ id: 'a', type: 'eliminate', targets: ['actor:a', 'actor:b', 'actor:c'], count: 2 }], h);
    expect(h.spawned).toEqual(['actor:a', 'actor:b', 'actor:c']);
    h.dead.add('actor:b');
    tick(r, 0.1);
    expect(r.view.progress).toBe('1/2');
    h.dead.add('actor:c');
    tick(r, 0.1);
    expect(r.state).toBe('complete');
  });

  it('protect: an escort drives to the drop; a defence lasts its time; either fails if the target is lost', () => {
    const h = new FakeHost().at('spawn:van', 0, 0).at('marker:safehouse_2', 200, 0);
    const { r } = run([{ id: 'a', type: 'protect', target: 'spawn:van', destination: 'marker:safehouse_2', speed: 11 }], h);
    expect(h.drives.get('spawn:van')).toMatchObject({ mode: 'route', speed: 11, route: [{ x: 200, z: 0 }] });
    h.at('spawn:van', 195, 0);
    tick(r, 0.1);
    expect(r.state).toBe('complete');

    const h2 = new FakeHost().at('actor:vip', 0, 0);
    const r2 = run([{ id: 'a', type: 'protect', target: 'actor:vip', durationSec: 30 }], h2).r;
    tick(r2, 10);
    expect(r2.view.timeLeft).toBeCloseTo(20, 0);
    h2.dead.add('actor:vip');
    tick(r2, 0.1);
    expect(r2.state).toBe('failed');
    expect(r2.failReason).toMatch(/killed/);
    h2.dead.clear();
    r2.retry();
    tick(r2, 31);
    expect(r2.state).toBe('complete');
  });

  it('tail: too close for too long or too far for too long fails; reaching the end completes', () => {
    const base = { id: 't', type: 'tail', target: 'spawn:courier', route: ['marker:plaza', 'marker:stadium'], minRange: 10, maxRange: 60, tooCloseSec: 3, lostSec: 5 };
    const h = new FakeHost().at('spawn:courier', 0, 0).at('marker:plaza', 100, 0).at('marker:stadium', 100, 100);
    const { r } = run([base], h);
    expect(h.drives.get('spawn:courier')?.mode).toBe('route');
    expect(h.drives.get('spawn:courier')?.route).toHaveLength(2);
    h.player = { x: 5, z: 0 };
    tick(r, 2);
    expect(r.view.warning).toMatch(/close/);
    tick(r, 1.5);
    expect(r.state).toBe('failed');
    expect(r.failReason).toMatch(/spotted/);
    r.retry();
    // Far away before ever closing in (as after a retry): not lost yet.
    h.player = { x: 100, z: 0 };
    tick(r, 6);
    expect(r.state).toBe('running');
    h.player = { x: 30, z: 0 };
    tick(r, 0.5);
    h.player = { x: 100, z: 0 };
    tick(r, 5.5);
    expect(r.failReason).toMatch(/lost/);
    r.retry();
    h.player = { x: 30, z: 0 };
    tick(r, 3);
    h.done.add('spawn:courier');
    tick(r, 0.1);
    expect(r.state).toBe('complete');
  });

  it('chase: disable or wreck the target; it gets away if you fall too far behind', () => {
    const h = new FakeHost().at('spawn:runner', 0, 0);
    const { r } = run([{ id: 'c', type: 'chase', target: 'spawn:runner', escapeDistance: 100, escapeSec: 4 }], h);
    expect(h.drives.get('spawn:runner')?.mode).toBe('flee');
    h.player = { x: 150, z: 0 };
    tick(r, 4.5);
    expect(r.failReason).toMatch(/got away/);
    r.retry();
    h.player = { x: 20, z: 0 };
    h.health.set('spawn:runner', 0.3);
    tick(r, 0.1);
    expect(r.state).toBe('complete');
    expect(h.drives.get('spawn:runner')?.mode).toBe('hold');

    const h2 = new FakeHost().at('spawn:runner', 0, 0);
    const r2 = run([{ id: 'c', type: 'chase', target: 'spawn:runner', catch: 'wreck' }], h2).r;
    h2.health.set('spawn:runner', 0.1);
    tick(r2, 0.1);
    expect(r2.state).toBe('running');
    h2.destroyed.add('spawn:runner');
    tick(r2, 0.1);
    expect(r2.state).toBe('complete');
  });

  it('escape completes once the HEAT is gone', () => {
    const h = new FakeHost();
    const { r } = run([{ id: 'e', type: 'escape', onStart: [{ do: 'setHeat', value: 2 }] }], h);
    expect(h.heat).toBe(2);
    tick(r, 3);
    expect(r.state).toBe('running');
    h.heat = 0;
    tick(r, 0.1);
    expect(r.state).toBe('complete');
  });

  it('race: checkpoints in order, in a car, against the clock and opponents', () => {
    const h = new FakeHost().at('marker:a', 0, 100).at('marker:b', 100, 100).at('marker:c', 100, 0).at('spawn:rival', 0, 0);
    const { r } = run([{ id: 'r', type: 'race', checkpoints: ['marker:a', 'marker:b', 'marker:c'], opponents: ['spawn:rival'], timeLimitSec: 60 }], h);
    expect(h.drives.get('spawn:rival')?.route).toHaveLength(3);
    // Out of order and on foot does not count.
    h.player = { x: 100, z: 100 };
    tick(r, 0.1);
    expect(r.view.progress).toBe('0/3');
    h.driving = 1;
    h.player = { x: 0, z: 100 };
    tick(r, 0.1);
    h.player = { x: 100, z: 100 };
    tick(r, 0.1);
    expect(r.view.progress).toBe('2/3');
    h.done.add('spawn:rival');
    tick(r, 0.1);
    expect(r.failReason).toMatch(/Beaten/);
    h.done.clear();
    r.retry();
    for (const p of [
      [0, 100],
      [100, 100],
      [100, 0],
    ]) {
      h.player = { x: p[0]!, z: p[1]! };
      tick(r, 0.1);
    }
    expect(r.state).toBe('complete');
  });

  it('collect: any order, points to the nearest, counts', () => {
    const h = new FakeHost().at('marker:p1', 50, 0).at('marker:p2', 10, 0).at('marker:p3', 90, 0);
    const { r } = run([{ id: 'c', type: 'collect', pickups: ['marker:p1', 'marker:p2', 'marker:p3'], vehicle: 'none' }], h);
    expect(r.view.targetX).toBe(10);
    expect(r.view.markerCount).toBe(3);
    h.player = { x: 90, z: 0 };
    tick(r, 0.1);
    expect(r.view.progress).toBe('1/3');
    h.player = { x: 50, z: 1 };
    tick(r, 0.1);
    h.player = { x: 10, z: 0 };
    tick(r, 0.1);
    expect(r.state).toBe('complete');
  });

  it('wait: time counts only inside the zone (and resets if asked)', () => {
    const h = new FakeHost().at('marker:door', 0, 0);
    const { r } = run([{ id: 'w', type: 'wait', target: 'marker:door', durationSec: 10, vehicle: 'any', resetOnLeave: true }], h);
    h.driving = 1;
    tick(r, 6);
    h.player = { x: 40, z: 0 };
    tick(r, 1);
    h.player = { x: 0, z: 0 };
    tick(r, 6);
    expect(r.state).toBe('running');
    tick(r, 4.1);
    expect(r.state).toBe('complete');
  });

  it('dropOff: in the car, slowed down, passengers get out; wrecking the car with them aboard fails', () => {
    const h = new FakeHost().at('marker:club', 0, 0);
    const { r } = run(
      [
        { id: 'pick', type: 'reach', target: 'marker:club', radius: 50, onComplete: [{ do: 'board', actors: ['actor:vip'] }] },
        { id: 'drop', type: 'dropOff', target: 'marker:club', passengers: ['actor:vip'] },
      ],
      h,
    );
    tick(r, 0.1);
    expect(h.boarded.has('actor:vip')).toBe(true);
    h.driving = 1;
    h.speed = 10;
    tick(r, 0.1);
    expect(r.view.warning).toMatch(/Slow/);
    h.lostPassengers = true;
    tick(r, 0.1);
    expect(r.failReason).toMatch(/passengers/);
    h.lostPassengers = false;
    r.retry();
    h.speed = 1;
    tick(r, 0.1);
    expect(r.state).toBe('complete');
    expect(h.boarded.has('actor:vip')).toBe(false);
  });

  it('photograph needs range and line of sight for the hold time', () => {
    const h = new FakeHost().at('actor:mark', 0, 0);
    const { r } = run([{ id: 'p', type: 'photograph', target: 'actor:mark', range: 20, holdSec: 2 }], h);
    h.player = { x: 50, z: 0 };
    tick(r, 3);
    expect(r.view.warning).toMatch(/closer/);
    h.player = { x: 10, z: 0 };
    h.los = false;
    tick(r, 3);
    expect(r.state).toBe('running');
    h.los = true;
    tick(r, 2.1);
    expect(r.state).toBe('complete');
  });

  it('perform counts reported actions; hint events reach the host', () => {
    const h = new FakeHost();
    const { r } = run([{ id: 'd', type: 'perform', action: 'dodge', count: 2, onStart: [{ do: 'hint', text: 'Tap DODGE to roll' }] }], h);
    expect(h.hints).toEqual(['Tap DODGE to roll']);
    r.noteAction('fire');
    r.noteAction('dodge');
    tick(r, 0.1);
    expect(r.view.progress).toBe('1/2');
    r.noteAction('dodge');
    tick(r, 0.1);
    expect(r.state).toBe('complete');
  });

  it('hack on a terminal places and removes it', () => {
    const h = new FakeHost().at('marker:node', 5, 5);
    const { r } = run([{ id: 'h', type: 'hack', target: 'marker:node', minigame: 'sequence', difficulty: 1 }], h);
    expect(h.terminals.get('h')).toEqual({ x: 5, z: 5 });
    r.reportHack(true);
    tick(r, 0.1);
    expect(r.state).toBe('complete');
    expect(h.terminals.get('h')).toBeNull();
  });

  it('failOn conditions, time limits and mission-level events', () => {
    const h = new FakeHost().at('marker:far', 1000, 0);
    const { r } = run(
      [
        {
          id: 'a',
          type: 'reach',
          target: 'marker:far',
          timeLimitSec: 60,
          failOn: [
            { if: 'heatAtLeast', value: 3, message: 'Too hot' },
            { if: 'tooFar', target: 'actor:vip', distance: 50, graceSec: 2 },
          ],
        },
      ],
      h,
      { onStart: [{ do: 'dialogue', line: 'hello' }, { do: 'dialogue', line: 'later', delaySec: 30 }], onComplete: [{ do: 'dialogue', line: 'bye' }] },
    );
    h.at('actor:vip', 0, 0);
    expect(h.log).toEqual(['hello']);
    h.heat = 3;
    tick(r, 0.1);
    expect(r.failReason).toBe('Too hot');
    h.heat = 0;
    r.retry();
    h.player = { x: 100, z: 0 };
    tick(r, 2.5);
    expect(r.failReason).toMatch(/behind/);
    r.retry();
    h.player = { x: 0, z: 0 };
    tick(r, 61);
    expect(r.failReason).toMatch(/time/);
    expect(h.log).toContain('later');
    r.restart();
    h.player = { x: 1000, z: 0 };
    tick(r, 0.1);
    expect(r.state).toBe('complete');
    expect(h.log.at(-1)).toBe('bye');
  });
});
