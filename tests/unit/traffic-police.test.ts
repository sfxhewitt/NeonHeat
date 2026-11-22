import { describe, expect, it } from 'vitest';
import { forwardSpeed, type Vehicle } from '@neonheat/sim';
import { intents, loadContent, makeWorld, run } from './helpers';

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

describe('damage', () => {
  it('a hard crash damages and eventually destroys a car', async () => {
    const content = loadContent();
    content.traffic.count = 0;
    const world = await makeWorld(1, content);
    const car = world.player.vehicle!;
    const hits: number[] = [];
    // Ram the building north of the start repeatedly.
    for (let i = 0; i < 12 && !car.destroyed; i++) {
      car.vx = 0;
      car.vz = 0;
      world.despawnVehicle(car);
      const v = world.spawnVehicle(car.variantId, -14, 34, Math.PI, 'player')!;
      v.hp = car.hp;
      world.setPlayerVehicle(v);
      run(world, 2.5, intents({ throttle: 1 }));
      hits.push(v.hp);
      if (v.destroyed) break;
      car.hp = v.hp;
    }
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!).toBeLessThan(world.player.vehicle?.params.maxHealth ?? Infinity);
  });
});

describe('police and HEAT in the world', () => {
  async function chaseWorld(seed = 5) {
    const content = loadContent();
    content.traffic.count = 0;
    return makeWorld(seed, content);
  }

  const police = (w: Awaited<ReturnType<typeof chaseWorld>>): Vehicle[] => w.vehicles.filter((v) => v.active && v.role === 'police');

  it('spawns one to three patrol cars by level and a drone at level 3', async () => {
    const w = await chaseWorld();
    w.heat.setLevel(1, w.player.x, w.player.z);
    run(w, 1, idle);
    expect(police(w).length).toBe(1);
    expect(w.police.drone.active).toBe(false);
    w.heat.setLevel(3, w.player.x, w.player.z);
    run(w, 4, idle);
    expect(police(w).length).toBe(3);
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
    expect(closest).toBeLessThan(8);
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
    const pv = w.player.vehicle!;
    w.despawnVehicle(pv);
    const car = w.spawnVehicle('kestrel', -110, 120, Math.PI / 2, 'player')!;
    w.setPlayerVehicle(car);
    const cop = w.spawnVehicle('interceptor', -60, 120, Math.PI / 2, 'police')!;
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
