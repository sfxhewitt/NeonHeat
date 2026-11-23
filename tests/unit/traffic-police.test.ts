import { describe, expect, it } from 'vitest';
import { forwardSpeed, type Vehicle } from '@neonheat/sim';
import { EW, buildingWithRoadSouth, intents, loadContent, makeWorld, run } from './helpers';

const idle = intents();

describe('traffic', () => {
  it('spawns the configured number of cars which drive along their lanes', async () => {
    const world = await makeWorld(3);
    const cars = world.vehicles.filter((v) => v.active && v.role === 'traffic');
    expect(cars.length).toBe(world.content.traffic.count);
    const start = cars.map((c) => ({ x: c.x, z: c.z }));
    run(world, 8, idle);
    const moved = cars.filter((c, i) => Math.hypot(c.x - start[i]!.x, c.z - start[i]!.z) > 30);
    expect(moved.length).toBeGreaterThanOrEqual(cars.length - 2);
    // Still on the road network.
    const onRoad = cars.filter((c) => c.active && world.roads.onRoad(c.x, c.z));
    expect(onRoad.length).toBeGreaterThanOrEqual(cars.length - 2);
  });

  it('brakes for an obstacle in its lane and keeps a gap', async () => {
    const content = loadContent();
    content.traffic.count = 1;
    content.map.traffic.loops = [content.map.traffic.loops[0]!];
    const world = await makeWorld(4, content);
    const car = world.vehicles.find((v) => v.active && v.role === 'traffic')!;
    // Park a van 40 m ahead in its lane.
    const yaw = car.yaw;
    const block = world.spawnVehicle('brick', car.x + Math.sin(yaw) * 40, car.z + Math.cos(yaw) * 40, yaw, 'parked')!;
    run(world, 10, idle);
    const gap = Math.hypot(block.x - car.x, block.z - car.z) - (car.params.length + block.params.length) / 2;
    expect(Math.abs(forwardSpeed(car))).toBeLessThan(1);
    expect(gap).toBeGreaterThan(2);
    expect(gap).toBeLessThan(15);
    expect(car.hp).toBe(car.params.maxHealth);
  });
});

describe('abandoned cars', () => {
  it('recycles a stolen car left out of range, keeps map cars, and traffic tops back up', async () => {
    const world = await makeWorld(5);
    const stolen = world.vehicles.find((v) => v.active && v.role === 'traffic')!;
    const mapCar = world.vehicles.find((v) => v.active && v.persistent)!;
    world.playerCtl.enter(stolen);
    expect(stolen.role).toBe('player');
    world.playerCtl.exit();
    expect(stolen.role).toBe('parked');
    // Walk far from both cars.
    const far = Math.abs(stolen.x) > 60 ? -Math.sign(stolen.x) * 120 : 120;
    world.playerCtl.teleport(far, far);
    run(world, world.content.traffic.abandonedDespawnSec + 3, idle);
    expect(stolen.active === false || stolen.role !== 'parked').toBe(true);
    expect(mapCar.active).toBe(true);
    const traffic = world.vehicles.filter((v) => v.active && v.role === 'traffic').length;
    expect(traffic).toBe(world.traffic.cap);
  });
});

describe('wrecks', () => {
  it('keeps at most maxWrecks wrecks, clearing the oldest even near the player', async () => {
    const content = loadContent();
    content.traffic.count = 0;
    content.peds.count = 0;
    const world = await makeWorld(6, content);
    const p = world.player;
    for (let i = 0; i < 6; i++) {
      const v = world.spawnVehicle('interceptor', p.x + 8 + i * 6, p.z + 10, 0, 'police')!;
      world.police.cap = 0;
      world.damageVehicle(v, 1e6);
      run(world, 0.5, idle);
    }
    run(world, 5, idle);
    const wrecks = world.vehicles.filter((v) => v.active && v.destroyed).length;
    expect(wrecks).toBeLessThanOrEqual(world.content.traffic.maxWrecks);
  });
});

describe('damage', () => {
  it('hard crashes damage a car until it is destroyed, then the player is thrown out', async () => {
    const content = loadContent();
    content.traffic.count = 0;
    content.peds.count = 0;
    const world = await makeWorld(1, content);
    const { x, z } = buildingWithRoadSouth(world);
    const car = world.spawnVehicle('kestrel', x, z, Math.PI, 'parked')!;
    world.playerCtl.enter(car);
    const hp: number[] = [];
    for (let i = 0; i < 30 && !car.destroyed; i++) {
      // Back off, then ram the building to the north again.
      run(world, 2.5, intents({ throttle: 1 }));
      hp.push(car.hp);
      run(world, 1.6, intents({ brake: 1 }));
    }
    expect(hp[0]!).toBeLessThan(car.params.maxHealth);
    expect(car.destroyed).toBe(true);
    run(world, world.content.vehicles.damage.destroyedEjectSec + 0.5, intents());
    expect(world.playerCtl.mode).toBe('foot');
    expect(world.player.vehicle).toBeNull();
  });
});

describe('police and HEAT in the world', () => {
  async function chaseWorld(seed = 5) {
    const content = loadContent();
    content.traffic.count = 0;
    return makeWorld(seed, content);
  }

  const police = (w: Awaited<ReturnType<typeof chaseWorld>>): Vehicle[] => w.vehicles.filter((v) => v.active && v.role === 'police');

  it('spawns more patrol cars by level and a drone at level 3', async () => {
    const w = await chaseWorld();
    w.heat.setLevel(1, w.player.x, w.player.z);
    run(w, 1, idle);
    expect(police(w).length).toBe(1);
    expect(w.police.drone.active).toBe(false);
    w.heat.setLevel(3, w.player.x, w.player.z);
    run(w, 6, idle);
    expect(police(w).length).toBe(w.content.heat.levels[3]!.units);
    expect(w.police.drone.active).toBe(true);
  });

  it('patrol cars pursue and reach a stationary player', async () => {
    const w = await chaseWorld(6);
    w.heat.setLevel(2, w.player.x, w.player.z);
    let closest = Infinity;
    run(w, 25, () => {
      for (const p of police(w)) closest = Math.min(closest, w.distToPlayer(p.x, p.z));
      return idle;
    });
    // An on-foot player: units pull up short and send officers in.
    expect(closest).toBeLessThan(w.content.heat.pursuit.footStopDist + 2);
  });

  it('the drone keeps line of sight over buildings and holds HEAT', async () => {
    const w = await chaseWorld(7);
    // Drone only: no patrol cars to wreck the player and reset HEAT.
    w.police.cap = 0;
    w.heat.setLevel(3, w.player.x, w.player.z);
    run(w, 15, idle);
    expect(w.police.drone.sees).toBe(true);
    expect(w.heat.level).toBe(3);
  });

  it('ramming a police car raises HEAT', async () => {
    const w = await chaseWorld(8);
    const car = w.spawnVehicle('kestrel', EW.x, EW.z, Math.PI / 2, 'player')!;
    w.playerCtl.enter(car);
    const cop = w.spawnVehicle('interceptor', EW.x + 50, EW.z, Math.PI / 2, 'police')!;
    // Hold the patrol car still so the test is about the ram, not the chase.
    cop.ai.mode = 'stunned';
    cop.ai.timer = 100;
    expect(w.heat.level).toBe(0);
    run(w, 3, intents({ throttle: 1 }));
    expect(w.heat.level).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic for a seed with traffic and police running', async () => {
    const a = await makeWorld(11);
    const b = await makeWorld(11);
    for (const w of [a, b]) w.heat.setLevel(3, w.player.x, w.player.z);
    const script = (t: number) => intents({ throttle: 1, steer: Math.sin(t), handbrake: t % 3 > 2.5 });
    run(a, 12, script);
    run(b, 12, script);
    expect(a.stateHash()).toBe(b.stateHash());
  });
});
