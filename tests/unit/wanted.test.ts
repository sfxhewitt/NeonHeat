import { describe, expect, it } from 'vitest';
import { driveTowards, emptyControls, type SimContent, type SimEvent, type Vehicle, type World } from '@neonheat/sim';
import { intents, loadContent, makeWorld, run } from './helpers';

const idle = intents();

function quiet(patch?: (c: SimContent) => void): SimContent {
  const c = loadContent();
  c.traffic.count = 0;
  c.peds.count = 0;
  patch?.(c);
  return c;
}

async function quietWorld(seed = 1, patch?: (c: SimContent) => void): Promise<World> {
  return makeWorld(seed, quiet(patch));
}

const police = (w: World): Vehicle[] => w.vehicles.filter((v) => v.active && v.role === 'police' && v.ai.mode !== 'roadblock' && v.ai.mode !== 'leave');

/** Hold a vehicle still (so a test is about the shot, not the chase). */
function freeze(v: Vehicle): void {
  v.ai.mode = 'stunned';
  v.ai.timer = 1000;
}

function collect(w: World, seconds: number, input = idle, each?: (w: World) => void): SimEvent[] {
  const out: SimEvent[] = [];
  run(w, seconds, () => {
    out.push(...w.events);
    each?.(w);
    return input;
  });
  return out;
}

describe('witnesses', () => {
  it('a few shots in an empty street give HEAT 1 at most (here: none)', async () => {
    const w = await quietWorld(1);
    run(w, 1.2, intents({ fire: true }));
    run(w, 6, idle);
    expect(w.heat.level).toBeLessThanOrEqual(1);
    expect(w.heat.level).toBe(0);
  });

  it('even sustained unwitnessed gunfire never goes past HEAT 1', async () => {
    const w = await quietWorld(1, (c) => {
      c.heat.levels[1]!.units = 0; // nobody comes to look
    });
    w.combat.give('smg', 300);
    let top = 0;
    run(w, 22, () => {
      top = Math.max(top, w.heat.level);
      return intents({ fire: true });
    });
    expect(top).toBe(1);
    expect(w.heat.level).toBe(1);
  });

  it('a pedestrian who sees gunfire calls it in after a delay', async () => {
    const w = await quietWorld(2);
    const pc = w.playerCtl;
    const ped = w.peds.spawnPedAt(pc.x + 6, pc.z)!;
    ped.state = 'cower';
    ped.timer = 100;
    run(w, 0.5, intents({ fire: true }));
    expect(w.heat.level).toBe(0);
    expect(w.police.witnesses.pendingCount()).toBe(1);
    const ev = collect(w, w.content.heat.witness.callDelaySec + 0.5);
    expect(ev.some((e) => e.type === 'crimeReported' && e.by === 'witness')).toBe(true);
    expect(w.heat.level).toBe(1);
  });

  it('a witness knocked down before calling never reports', async () => {
    const w = await quietWorld(3);
    const pc = w.playerCtl;
    const ped = w.peds.spawnPedAt(pc.x + 6, pc.z)!;
    ped.state = 'cower';
    ped.timer = 100;
    run(w, 0.3, intents({ fire: true }));
    expect(w.police.witnesses.pendingCount()).toBe(1);
    w.peds.knockDown(ped, 0, 0, false);
    run(w, w.content.heat.witness.callDelaySec + 1, idle);
    expect(w.heat.level).toBe(0);
  });

  it('gunfire seen by the police counts in full and escalates while it goes on', async () => {
    const w = await quietWorld(4);
    const pc = w.playerCtl;
    const cop = w.spawnVehicle('interceptor', pc.x + 20, pc.z, 0, 'police')!;
    freeze(cop);
    cop.ai.sees = true;
    pc.facing = -Math.PI / 2; // shoot away from the car
    run(w, 0.2, intents({ fire: true }));
    expect(w.heat.level).toBeGreaterThanOrEqual(1);
    // Keep shooting into the air in front of the police for a while.
    w.combat.give('smg', 300);
    let top = 0;
    run(w, 14, (t) => {
      top = Math.max(top, w.heat.level);
      return intents({ fire: Math.floor(t * 2) % 2 === 0 });
    });
    expect(top).toBeGreaterThanOrEqual(2);
  });
});

describe('units per level', () => {
  for (let level = 1; level <= 5; level++) {
    it(`HEAT ${level} sends the configured response`, async () => {
      const w = await quietWorld(5, (c) => {
        c.heat.spawnIntervalSec = 0.05;
      });
      w.police.cap = 10;
      w.heat.setLevel(level, w.player.x, w.player.z);
      run(w, 1.5, idle);
      const lvl = w.content.heat.levels[level]!;
      const units = police(w);
      expect(units.length).toBe(lvl.units);
      expect(w.police.drone.active).toBe(lvl.drone);
      for (const v of units) expect(lvl.variants).toContain(v.variantId);
      // Spawned off screen, 80 to 170 m away.
      for (const v of units) expect(w.police.offScreen(v.x, v.z)).toBe(true);
    });
  }

  it('the quality cap limits units', async () => {
    const w = await quietWorld(6, (c) => {
      c.heat.spawnIntervalSec = 0.05;
    });
    w.police.cap = 4;
    w.heat.setLevel(5, w.player.x, w.player.z);
    run(w, 1.5, idle);
    expect(police(w).length).toBe(4);
  });
});

describe('escape', () => {
  it('HEAT 1 decays once the patrol loses sight of you', async () => {
    const w = await quietWorld(7);
    w.heat.setLevel(1, 0, 0);
    // Hide far from where the crime happened, behind buildings.
    w.playerCtl.teleport(-128, -128);
    run(w, 5, idle);
    expect(w.heat.level).toBe(1);
    expect(w.vehicles.some((v) => v.active && v.role === 'police')).toBe(true);
    run(w, 25, idle);
    expect(w.heat.level).toBe(0);
  });

  it('changing car while unseen drops a level', async () => {
    const w = await quietWorld(8);
    w.police.cap = 0;
    const a = w.spawnVehicle('kestrel', -100, 0, 0, 'parked')!;
    const b = w.spawnVehicle('vandal', -110, 0, 0, 'parked')!;
    w.playerCtl.enter(a);
    w.heat.setLevel(3, -100, 0);
    w.police.drone.active = false;
    w.content.heat.levels[3]!.drone = false;
    run(w, 3, idle); // nobody sees us
    w.playerCtl.exit();
    w.playerCtl.enter(b);
    expect(w.heat.level).toBe(2);
    // Only once per sighting.
    w.playerCtl.exit();
    w.playerCtl.enter(a);
    expect(w.heat.level).toBe(2);
  });

  it('a respray clears HEAT up to 3 when unseen, but not at 4 or while seen', async () => {
    const w = await quietWorld(9);
    w.police.cap = 0;
    const car = w.spawnVehicle('kestrel', -100, 0, 0, 'parked')!;
    w.playerCtl.enter(car);
    w.content.heat.levels[3]!.drone = false;
    w.heat.setLevel(3, 0, 0);
    run(w, 2, idle);
    expect(w.police.respray()).toBe('cleared');
    expect(w.heat.level).toBe(0);
    w.heat.setLevel(4, 0, 0);
    run(w, 2, idle);
    expect(w.police.respray()).toBe('tooHot');
    expect(w.heat.level).toBe(4);
    w.heat.setLevel(2, 0, 0);
    const cop = w.spawnVehicle('interceptor', car.x + 15, car.z, 0, 'police')!;
    freeze(cop);
    cop.ai.sees = true;
    run(w, 0.1, idle);
    expect(w.police.respray()).toBe('seen');
  });

  it('driving slowly into a respray marker resprays the car', async () => {
    const w = await quietWorld(10, (c) => {
      c.map.markers['respray_test'] = { pos: [-100, 0, 0] };
    });
    w.police.cap = 0;
    const car = w.spawnVehicle('kestrel', -100, 0, 0, 'parked')!;
    w.playerCtl.enter(car);
    w.heat.setLevel(2, 100, 100);
    run(w, 2, idle);
    w.playerCtl.exit();
    run(w, 0.1, idle);
    w.playerCtl.enter(car);
    const ev = collect(w, 0.5);
    expect(ev.some((e) => e.type === 'respray' && e.result === 'cleared')).toBe(true);
    expect(w.heat.level).toBe(0);
  });
});

/** Drive the player's car round the inner block (road graph corners), like a player fleeing. */
function fleeScript(w: World): () => ReturnType<typeof intents> {
  const loop = [
    [-40, -40],
    [40, -40],
    [40, 40],
    [-40, 40],
  ] as const;
  let i = 0;
  const c = emptyControls();
  return () => {
    const v = w.player.vehicle;
    if (!v) return idle;
    let [tx, tz] = loop[i]!;
    if (Math.hypot(tx - v.x, tz - v.z) < 14) {
      i = (i + 1) % loop.length;
      [tx, tz] = loop[i]!;
    }
    driveTowards(v, tx, tz, 24, c, false);
    return intents({ steer: c.steer, throttle: c.throttle, brake: c.brake, handbrake: c.handbrake });
  };
}

describe('police chase you, they do not kill you', () => {
  it('a car survives a sustained 60 s HEAT 2 chase', async () => {
    const w = await quietWorld(11);
    const car = w.spawnVehicle('kestrel', -40, 0, Math.PI, 'parked')!;
    w.playerCtl.enter(car);
    w.heat.setLevel(2, car.x, car.z);
    const script = fleeScript(w);
    let contacts = 0;
    let closest = Infinity;
    run(w, 60, () => {
      if (w.heat.level < 2) w.heat.setLevel(2, w.player.x, w.player.z);
      for (const e of w.events) if (e.type === 'impact' && e.involvesPlayer && e.other === 'vehicle') contacts++;
      for (const p of police(w)) closest = Math.min(closest, w.distToPlayer(p.x, p.z));
      return script();
    });
    expect(closest).toBeLessThan(10);
    expect(contacts).toBeGreaterThan(0);
    expect(car.destroyed).toBe(false);
    expect(w.vehicleHealth(car)).toBeGreaterThan(0.5);
  });

  it('police rams are capped per hit', async () => {
    const w = await quietWorld(12);
    const car = w.spawnVehicle('kestrel', -100, 0, 0, 'parked')!;
    w.playerCtl.enter(car);
    const cop = w.spawnVehicle('interceptor', -100, 0, 0, 'police')!;
    const raw = 80;
    const first = w.police.scaleImpactDamage(car, { kind: 'vehicle', id: cop.id }, raw);
    expect(first).toBeLessThanOrEqual(w.content.heat.ramDamage.maxPerHit);
    // Straight after: rate-limited.
    expect(w.police.scaleImpactDamage(car, { kind: 'vehicle', id: cop.id }, raw)).toBe(0);
    // Not police (and no patrol car near, no recent police contact): unchanged.
    w.despawnVehicle(cop);
    run(w, 3, idle);
    expect(w.police.scaleImpactDamage(car, { kind: 'static', id: -1 }, raw)).toBe(raw);
  });

  it('patrol cars pull up short of a player on foot and officers get out', async () => {
    const w = await quietWorld(13);
    w.heat.setLevel(2, w.player.x, w.player.z);
    let officers = 0;
    run(w, 25, () => {
      officers = Math.max(officers, w.officers.activeCount());
      return idle;
    });
    expect(officers).toBeGreaterThan(0);
    // Booked, never run down.
    expect(w.playerCtl.dead).toBe(false);
  });
});

describe('roadblocks and spikes', () => {
  it('HEAT 4 puts a roadblock across the road ahead of a fleeing player', async () => {
    const w = await quietWorld(14, (c) => {
      c.heat.roadblocks.intervalSec = 1;
      for (const l of c.heat.levels) l.units = 0;
    });
    const car = w.spawnVehicle('kestrel', -120, 110, Math.PI, 'parked')!;
    w.playerCtl.enter(car);
    w.heat.setLevel(4, car.x, car.z);
    w.police.drone.active = false;
    const ev = collect(w, 3, intents({ throttle: 1 }));
    const rb = ev.find((e) => e.type === 'roadblock');
    expect(rb).toBeDefined();
    if (rb?.type !== 'roadblock') return;
    // Ahead (north, -Z) of the player, with a spike strip laid in front of it.
    expect(rb.z).toBeLessThan(car.z);
    const block = w.vehicles.filter((v) => v.active && v.ai.mode === 'roadblock');
    expect(block.length).toBe(2);
    expect(w.police.roadblocks.spikes.some((s) => s.active)).toBe(true);
  });

  it('a spike strip pops tyres: lower top speed and grip', async () => {
    const w = await quietWorld(15);
    const car = w.spawnVehicle('kestrel', -120, 100, Math.PI, 'parked')!;
    w.playerCtl.enter(car);
    const top = car.params.topSpeed;
    w.police.roadblocks.placeSpikes(-120, 80, 1, 0);
    const ev = collect(w, 3, intents({ throttle: 1 }));
    expect(ev.some((e) => e.type === 'tyresPopped' && e.byPlayer)).toBe(true);
    expect(w.police.roadblocks.isPopped(car)).toBe(true);
    expect(car.params.topSpeed).toBeLessThan(top);
    expect(car.params.grip).toBeLessThan(w.content.vehicles.variants.kestrel!.grip);
  });
});

describe('determinism', () => {
  it('a chase with officers, shooting and pickups is deterministic for a seed', async () => {
    const a = await makeWorld(21);
    const b = await makeWorld(21);
    for (const w of [a, b]) {
      w.heat.setLevel(3, w.player.x, w.player.z);
      w.combat.give('smg', 200);
    }
    const script = (t: number) => intents({ moveX: Math.sin(t), moveY: Math.cos(t * 0.7), fire: t % 2 > 1 });
    run(a, 12, script);
    run(b, 12, script);
    expect(a.stateHash()).toBe(b.stateHash());
  });
});
