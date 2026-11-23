import { describe, expect, it } from 'vitest';
import { forwardSpeed, type World } from '@neonheat/sim';
import { EW, NS, intents, loadContent, makeWorld, movePlayer, run } from './helpers';

async function quietWorld(seed = 1, peds = 0): Promise<World> {
  const content = loadContent();
  content.traffic.count = 0;
  content.peds.count = peds;
  const w = await makeWorld(seed, content);
  movePlayer(w, NS.x, NS.z);
  return w;
}

describe('player on foot', () => {
  it('starts on foot and walks where the stick points (up = north)', async () => {
    const w = await quietWorld();
    expect(w.playerCtl.mode).toBe('foot');
    const z0 = w.playerCtl.z;
    const x0 = w.playerCtl.x;
    run(w, 1, intents({ moveY: 1 }));
    expect(w.playerCtl.z).toBeLessThan(z0 - 4);
    expect(Math.abs(w.playerCtl.x - x0)).toBeLessThan(0.2);
  });

  it('dodge roll bursts faster than running', async () => {
    const w = await quietWorld();
    const z0 = w.playerCtl.z;
    w.step(intents({ moveX: 1, dodge: true }));
    run(w, 0.3, intents({ moveX: 1 }));
    const rolled = w.playerCtl.x;
    const w2 = await quietWorld();
    run(w2, 0.32, intents({ moveX: 1 }));
    expect(rolled - w.playerCtl.prevX).toBeGreaterThan(0);
    expect(rolled).toBeGreaterThan(w2.playerCtl.x + 1);
    expect(Math.abs(w.playerCtl.z - z0)).toBeLessThan(0.5);
  });

  it('shows Enter next to a parked car, gets in and back out again', async () => {
    const w = await quietWorld();
    const car = w.vehicles.find((v) => v.active && v.variantId === 'kestrel')!;
    w.playerCtl.teleport(car.x, car.z + 2.4);
    w.step(intents());
    expect(w.playerCtl.context?.kind).toBe('enter');
    w.step(intents({ interact: true }));
    expect(w.player.vehicle).toBe(car);
    expect(w.playerCtl.mode).toBe('driving');
    run(w, 0.2, intents());
    expect(w.playerCtl.context?.kind).toBe('exit');
    w.step(intents({ interact: true }));
    expect(w.playerCtl.mode).toBe('foot');
    expect(w.insideBuilding(w.playerCtl.x, w.playerCtl.z)).toBe(false);
    expect(Math.hypot(w.playerCtl.x - car.x, w.playerCtl.z - car.z)).toBeLessThan(4);
  });

  it('steals a traffic car: the driver is thrown out and flees', async () => {
    const content = loadContent();
    content.traffic.count = 1;
    content.peds.count = 0;
    const w = await makeWorld(2, content);
    const car = w.vehicles.find((v) => v.active && v.role === 'traffic')!;
    w.playerCtl.teleport(car.x + Math.cos(car.yaw) * 2.2, car.z - Math.sin(car.yaw) * 2.2);
    w.step(intents());
    expect(w.playerCtl.context?.kind).toBe('steal');
    w.step(intents({ interact: true }));
    expect(w.player.vehicle).toBe(car);
    const driver = w.peds.peds.find((p) => p.active);
    expect(driver?.state).toBe('flee');
  });

  it('three variants handle differently', async () => {
    const speeds: Record<string, number> = {};
    const grips: Record<string, number> = {};
    for (const variant of ['kestrel', 'vandal', 'brick']) {
      const content = loadContent();
      content.traffic.count = 0;
      content.peds.count = 0;
      content.map.buildings = [];
      const w = await makeWorld(1, content);
      const car = w.spawnVehicle(variant, EW.x, EW.z, Math.PI / 2, 'parked')!;
      w.playerCtl.enter(car);
      run(w, 3, intents({ throttle: 1 }));
      speeds[variant] = forwardSpeed(car);
      grips[variant] = car.params.grip;
    }
    expect(speeds.kestrel).toBeGreaterThan(speeds.brick! + 5);
    expect(speeds.vandal).not.toBeCloseTo(speeds.kestrel!, 0);
    expect(new Set(Object.values(grips)).size).toBe(3);
  });
});

describe('pistol', () => {
  it('soft-locks the nearest hostile in a 60° cone and damages it', async () => {
    const w = await quietWorld(3);
    const p = w.playerCtl;
    p.teleport(EW.x, EW.z);
    // Facing east (+X). One cop ahead at 15 m, slightly off-axis; one behind.
    p.facing = Math.PI / 2;
    const ahead = w.spawnVehicle('interceptor', EW.x + 15, EW.z + 3, 0, 'police')!;
    const behind = w.spawnVehicle('interceptor', EW.x - 10, EW.z, 0, 'police')!;
    for (const c of [ahead, behind]) {
      c.ai.mode = 'stunned';
      c.ai.timer = 100;
    }
    run(w, 1, intents({ fire: true }));
    expect(p.aimTarget).toBe(ahead.id);
    expect(ahead.hp).toBeLessThan(ahead.params.maxHealth);
    expect(behind.hp).toBe(behind.params.maxHealth);
    expect(w.heat.level).toBeGreaterThanOrEqual(1);
  });

  it('gunfire makes nearby peds flee or cower', async () => {
    const w = await quietWorld(4, 15);
    const p = w.playerCtl;
    for (const ped of w.peds.peds.filter((q) => q.active).slice(0, 5)) {
      ped.body!.setTranslation({ x: p.x + 5, y: 0, z: p.z - 5 }, true);
      ped.x = p.x + 5;
      ped.z = p.z - 5;
    }
    w.step(intents({ fire: true }));
    const near = w.peds.peds.filter((q) => q.active && Math.hypot(q.x - p.x, q.z - p.z) < 10);
    expect(near.length).toBeGreaterThan(0);
    for (const q of near) expect(['flee', 'cower', 'down']).toContain(q.state);
  });
});

describe('pedestrians', () => {
  it('populate, wander and stay out of buildings', async () => {
    const w = await quietWorld(5, 15);
    expect(w.peds.activeCount()).toBe(15);
    run(w, 20, intents());
    for (const q of w.peds.peds.filter((p) => p.active)) expect(w.insideBuilding(q.x, q.z, -0.5)).toBe(false);
  });

  it('are knocked down by the player car, which raises HEAT', async () => {
    const content = loadContent();
    content.traffic.count = 0;
    content.peds.count = 1;
    content.map.buildings = [];
    const w = await makeWorld(6, content);
    movePlayer(w, EW.x - 20, EW.z - 6);
    const ped = w.peds.peds.find((p) => p.active) ?? w.peds.spawnPedAt(EW.x, EW.z)!;
    ped.body!.setTranslation({ x: EW.x, y: 0, z: EW.z }, true);
    ped.x = EW.x;
    ped.z = EW.z;
    ped.state = 'cower';
    ped.timer = 100;
    // Already doing 25 m/s, 6 m away: too late to dive clear.
    const car = w.spawnVehicle('kestrel', EW.x - 8, EW.z, Math.PI / 2, 'parked')!;
    w.playerCtl.enter(car);
    car.vx = 25;
    let hit = false;
    run(w, 3, () => {
      if (w.events.some((e) => e.type === 'pedHit')) hit = true;
      return intents({ throttle: 1 });
    });
    expect(hit).toBe(true);
    expect(ped.state).toBe('down');
    expect(w.heat.level).toBeGreaterThanOrEqual(1);
  });

  it('a car hitting the player on foot hurts them', async () => {
    const content = loadContent();
    content.traffic.count = 0;
    content.peds.count = 0;
    content.map.buildings = [];
    const w = await makeWorld(7, content);
    movePlayer(w, EW.x, EW.z);
    // A hostile squad car that drives straight at the player.
    w.spawnVehicle('brick', EW.x - 40, EW.z, Math.PI / 2, 'squad')!.ai.mode = 'drive';
    let hurt = false;
    run(w, 8, () => {
      if (w.events.some((e) => e.type === 'playerHurt')) hurt = true;
      return intents();
    });
    expect(hurt).toBe(true);
  });
});
