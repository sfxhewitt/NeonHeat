import { describe, expect, it } from 'vitest';
import type { World } from '@neonheat/sim';
import { intents, loadContent, makeWorld, movePlayer, run } from './helpers';

async function quietWorld(): Promise<World> {
  const c = loadContent();
  c.traffic.count = 0;
  c.peds.count = 0;
  return makeWorld(3, c);
}

describe('mission actors (people)', () => {
  it('a hostile guard notices the player, shoots, and goes down to pistol fire', async () => {
    const w = await quietWorld();
    const m = w.content.map.markers['glass_door_1']!.pos;
    w.playerCtl.teleport(m[0] + 40, m[2]);
    const a = w.actors.spawnActor({ x: m[0], z: m[2], faction: 'kurogane', hostile: true, behaviour: 'guard' })!;
    expect(a).not.toBeNull();
    run(w, 1, intents());
    expect(a.aggro).toBe(false);
    // Walk into view.
    w.playerCtl.teleport(m[0] + 10, m[2]);
    run(w, 15, intents());
    expect(a.aggro).toBe(true);
    expect(w.playerCtl.hp).toBeLessThan(w.playerCtl.maxHp);
    // Face it and shoot until it drops.
    w.playerCtl.hp = w.playerCtl.maxHp;
    for (let i = 0; i < 600 && !a.dead; i++) {
      w.playerCtl.facing = Math.atan2(a.x - w.playerCtl.x, a.z - w.playerCtl.z);
      w.step(intents({ fire: i % 20 === 0 }));
    }
    expect(a.dead).toBe(true);
    w.dispose();
  });

  it('auto-aim locks on to an armed heavy, and shooting back at one is not a crime when no police see it', async () => {
    const w = await quietWorld();
    const m = w.content.map.markers['glass_door_1']!.pos;
    w.playerCtl.teleport(m[0] + 10, m[2]);
    const a = w.actors.spawnActor({ x: m[0], z: m[2], faction: 'kurogane', hostile: true, behaviour: 'guard', hp: 50 })!;
    run(w, 3, intents());
    expect(a.aggro).toBe(true);
    // Facing roughly its way (inside the lock cone, not dead on): auto-aim picks it.
    const ang = Math.atan2(a.x - w.playerCtl.x, a.z - w.playerCtl.z);
    const t = w.combat.findHostile(w.playerCtl.x, w.playerCtl.z, ang + 0.3, 30, 60, null);
    expect(t?.kind).toBe('ped');
    expect(t?.id).toBe(a.pedId);
    w.heat.setLevel(0, w.player.x, w.player.z);
    for (let i = 0; i < 120; i++) {
      w.playerCtl.facing = ang + 0.3;
      w.step(intents({ fire: i % 20 === 0 }));
    }
    expect(a.hp).toBeLessThan(50);
    // Witness reports land a few seconds later.
    run(w, 8, intents());
    expect(w.heat.level).toBe(0);
    expect(w.heat.points).toBe(0);
    w.dispose();
  });

  it('a car you bail out of at speed rolls on without running you over', async () => {
    const w = await quietWorld();
    const m = w.content.map.markers['glass_door_1']!.pos;
    movePlayer(w, m[0] + 60, m[2] + 60);
    const car = w.spawnVehicle('kestrel', w.player.x, w.player.z, 0, 'parked')!;
    w.playerCtl.enter(car);
    run(w, 3, intents({ throttle: 1, scheme: 'classic' }));
    w.playerCtl.exit();
    // Swing the car into the player as it rolls on.
    car.vx = Math.cos(car.yaw) * 8 + Math.sin(car.yaw) * 10;
    car.vz = -Math.sin(car.yaw) * 8 + Math.cos(car.yaw) * 10;
    car.body?.setLinvel({ x: car.vx, y: 0, z: car.vz }, true);
    run(w, 1, intents());
    expect(w.playerCtl.hp).toBe(w.playerCtl.maxHp);
    w.dispose();
  });

  it('tough actors get back up until their hit points run out; clear() removes the living', async () => {
    const w = await quietWorld();
    const m = w.content.map.markers['lantern_door_2']!.pos;
    movePlayer(w, m[0] + 20, m[2] + 20);
    const capBefore = w.peds.cap;
    const a = w.actors.spawnActor({ x: m[0], z: m[2], faction: 'velvet_choir', hostile: false, behaviour: 'idle', hp: 2 })!;
    const b = w.actors.spawnActor({ x: m[0] + 3, z: m[2], faction: 'velvet_choir', hostile: false, behaviour: 'idle' })!;
    expect(w.peds.cap).toBe(capBefore + 2);
    const pa = w.actors.pedOf(a)!;
    w.peds.knockDown(pa, 0, 0, false);
    w.step(intents());
    expect(a.dead).toBe(false);
    expect(a.hp).toBe(1);
    w.peds.knockDown(w.actors.pedOf(a)!, 0, 0, false);
    w.step(intents());
    expect(a.dead).toBe(true);
    w.actors.clear();
    expect(b.active).toBe(false);
    expect(w.peds.cap).toBe(capBefore);
    w.dispose();
  });

  it('board and alight move an actor in and out of the world', async () => {
    const w = await quietWorld();
    const m = w.content.map.markers['ashgrove_door_1']!.pos;
    const a = w.actors.spawnActor({ x: m[0], z: m[2], faction: 'velvet_choir', hostile: false, behaviour: 'follow' })!;
    const ped = w.actors.pedOf(a)!;
    w.actors.board(a);
    expect(a.riding).toBe(true);
    expect(ped.active).toBe(false);
    w.actors.alight(a, m[0] + 5, m[2]);
    expect(a.riding).toBe(false);
    expect(w.actors.pedOf(a)).not.toBeNull();
    w.dispose();
  });
});

describe('mission actors (drivers)', () => {
  it('drives a route along the roads and stops at the end', async () => {
    const w = await quietWorld();
    const from = w.content.map.markers['ashgrove_road_1']!.pos;
    const to = w.content.map.markers['glass_road_3']!.pos;
    const v = w.spawnVehicle('kestrel', from[0], from[2], 0, 'parked')!;
    const d = w.actors.driveRoute(v, [{ x: to[0], z: to[2] }], 16)!;
    expect(v.role).toBe('mission');
    for (let i = 0; i < 60 * 90 && !d.done; i++) w.step(intents());
    expect(d.done).toBe(true);
    expect(Math.hypot(v.x - to[0], v.z - to[2])).toBeLessThan(12);
    w.dispose();
  });

  it('a fleeing car opens the gap on a player standing still; a rammer hunts its target', async () => {
    const w = await quietWorld();
    const p = w.content.map.markers['glass_road_2']!.pos;
    w.playerCtl.teleport(p[0], p[2] + 6);
    const runner = w.spawnVehicle('vandal', p[0], p[2], 0, 'parked')!;
    w.actors.flee(runner);
    run(w, 12, intents());
    expect(Math.hypot(runner.x - w.player.x, runner.z - w.player.z)).toBeGreaterThan(80);
    const q = w.content.map.markers['saltworks_road_1']!.pos;
    movePlayer(w, q[0] + 30, q[2] + 30);
    const target = w.spawnVehicle('brick', q[0], q[2], 0, 'parked')!;
    const rammer = w.spawnVehicle('enforcer', q[0] + 60, q[2], 0, 'parked')!;
    target.persistent = rammer.persistent = true;
    w.actors.ram(rammer, target.id);
    const hp = target.hp;
    run(w, 15, intents());
    expect(target.hp).toBeLessThan(hp);
    w.dispose();
  });
});
