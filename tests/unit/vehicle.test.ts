import { describe, expect, it } from 'vitest';
import { forwardSpeed } from '@neonheat/sim';
import { EW, buildingWithRoadSouth, intents, loadContent, makeWorld, movePlayer, run } from './helpers';

/** Spawn the player in a car on an empty map (no buildings), facing east. */
async function onOpenRoad(seed = 1, variant = 'kestrel') {
  const content = loadContent();
  content.map.buildings = [];
  content.map.props = [];
  content.traffic.count = 0;
  const world = await makeWorld(seed, content);
  const car = world.spawnVehicle(variant, EW.x, EW.z, Math.PI / 2, 'player')!;
  world.playerCtl.enter(car);
  return { world, car };
}

describe('arcade vehicle', () => {
  it('reaches top speed under full throttle', async () => {
    const { world, car } = await onOpenRoad();
    run(world, 6, intents({ throttle: 1 }));
    expect(forwardSpeed(car)).toBeGreaterThan(car.params.topSpeed * 0.97);
    expect(forwardSpeed(car)).toBeLessThanOrEqual(car.params.topSpeed * 1.001);
    expect(car.x).toBeGreaterThan(EW.x + 80);
    expect(Math.abs(car.z - EW.z)).toBeLessThan(0.5);
  });

  it('stops under braking', async () => {
    const { world, car } = await onOpenRoad();
    run(world, 2.5, intents({ throttle: 1 }));
    expect(forwardSpeed(car)).toBeGreaterThan(20);
    let stoppedAt = -1;
    const t0 = world.time;
    run(world, 1.5, () => {
      if (stoppedAt < 0 && Math.abs(forwardSpeed(car)) < 0.6) stoppedAt = world.time - t0;
      return intents({ brake: 1 });
    });
    expect(stoppedAt).toBeGreaterThan(0);
    expect(stoppedAt).toBeLessThan(1.2);
    // Keeping brake held after stopping reverses, slowly.
    expect(forwardSpeed(car)).toBeLessThan(0);
    expect(forwardSpeed(car)).toBeGreaterThanOrEqual(-car.params.reverseTopSpeed);
  });

  it('drifts under handbrake: lateral slip builds and grip returns afterwards', async () => {
    const { world, car } = await onOpenRoad();
    run(world, 2.5, intents({ throttle: 1 }));
    let maxSlip = 0;
    run(world, 0.8, () => {
      const lat = Math.abs(car.vx * Math.cos(car.yaw) - car.vz * Math.sin(car.yaw));
      maxSlip = Math.max(maxSlip, lat);
      return intents({ throttle: 1, steer: 1, handbrake: true });
    });
    expect(car.drifting).toBe(true);
    expect(maxSlip).toBeGreaterThan(5);

    // Without the handbrake the same steer slips far less.
    const b = await onOpenRoad();
    run(b.world, 2.5, intents({ throttle: 1 }));
    let gripSlip = 0;
    run(b.world, 0.8, () => {
      const lat = Math.abs(b.car.vx * Math.cos(b.car.yaw) - b.car.vz * Math.sin(b.car.yaw));
      gripSlip = Math.max(gripSlip, lat);
      return intents({ throttle: 1, steer: 1 });
    });
    expect(gripSlip).toBeLessThan(maxSlip * 0.6);
  });

  it('auto-straightens when steering is released', async () => {
    const { world, car } = await onOpenRoad();
    run(world, 1.5, intents({ throttle: 1 }));
    run(world, 0.3, intents({ throttle: 1, steer: 0.5 }));
    expect(Math.abs(car.yawRate)).toBeGreaterThan(0.3);
    run(world, 0.4, intents({ throttle: 1 }));
    expect(Math.abs(car.yawRate)).toBeLessThan(0.05);
  });

  it('turns towards the stick with direction steering', async () => {
    const { world, car } = await onOpenRoad();
    run(world, 1, intents({ throttle: 1 }));
    // Stick up = north (-Z). Car faces east (+X), so it should turn left, towards -Z.
    run(world, 1.2, intents({ scheme: 'direction', moveY: 1 }));
    const heading = Math.atan2(Math.sin(car.yaw), Math.cos(car.yaw));
    expect(Math.abs(Math.abs(heading) - Math.PI)).toBeLessThan(0.5);
    expect(car.z).toBeLessThan(EW.z);
  });

  it('cannot snap round faster than its tyres allow at speed (weight)', async () => {
    const { world, car } = await onOpenRoad();
    run(world, 2.5, intents({ throttle: 1 }));
    let maxYaw = 0;
    for (let i = 0; i < 30; i++) {
      world.step(intents({ throttle: 1, steer: 1 }));
      const v = Math.abs(forwardSpeed(car));
      if (v > 10) maxYaw = Math.max(maxYaw, Math.abs(car.yawRate) * v);
    }
    // yaw rate x speed is the sideways pull: capped near the tyres' limit (plus slip allowance).
    expect(maxYaw).toBeLessThan(car.params.latGripMax * 1.6);
  });

  it('touch steering brakes into a sharp turn at speed and drifts a hairpin', async () => {
    const { world, car } = await onOpenRoad();
    run(world, 2.5, intents({ scheme: 'direction', moveX: 1 }));
    const before = forwardSpeed(car);
    run(world, 0.5, intents({ scheme: 'direction', moveY: 1 }));
    expect(forwardSpeed(car)).toBeLessThan(before - 3);
    const b = await onOpenRoad();
    run(b.world, 2.5, intents({ scheme: 'direction', moveX: 1 }));
    let drifted = false;
    for (let i = 0; i < 30; i++) {
      b.world.step(intents({ scheme: 'direction', moveX: -1 }));
      drifted ||= b.car.drifting;
    }
    expect(drifted).toBe(true);
    run(b.world, 2.5, intents({ scheme: 'direction', moveX: -1 }));
    // Facing back west, under way again.
    expect(Math.cos(b.car.yaw - -Math.PI / 2)).toBeGreaterThan(0.9);
    expect(forwardSpeed(b.car)).toBeGreaterThan(5);
  });

  it('collides with buildings instead of passing through them', async () => {
    const content = loadContent();
    content.traffic.count = 0;
    const world = await makeWorld(1, content);
    // Drive north into a building from the road south of it.
    const { b, x, z } = buildingWithRoadSouth(world);
    const car = world.spawnVehicle('kestrel', x, z, Math.PI, 'player')!;
    world.playerCtl.enter(car);
    run(world, 3, intents({ throttle: 1 }));
    expect(car.z).toBeGreaterThan(b.z + b.d / 2);
    expect(car.hp).toBeLessThan(car.params.maxHealth);
  });

  it('is deterministic for a seed', async () => {
    const script = (t: number) =>
      intents({ throttle: 1, steer: Math.sin(t * 1.7), handbrake: t % 2 > 1.4, brake: t > 6 && t < 7 ? 1 : 0 });
    const a = await onOpenRoad(99);
    const b = await onOpenRoad(99);
    run(a.world, 10, script);
    run(b.world, 10, script);
    expect(a.world.stateHash()).toBe(b.world.stateHash());
  });
});

describe('parked cars', () => {
  it('every variant stays put when parked, and a shoved one stops', async () => {
    const content = loadContent();
    content.traffic.count = 0;
    content.peds.count = 0;
    const w = await makeWorld(1, content);
    movePlayer(w, EW.x, EW.z - 8);
    const cars = Object.keys(content.vehicles.variants).map((id, i) => w.spawnVehicle(id, EW.x + i * 12, EW.z, -Math.PI / 2, 'parked')!);
    run(w, 4, intents());
    for (const v of cars) expect(Math.hypot(v.x - (EW.x + cars.indexOf(v) * 12), v.z - EW.z), v.variantId).toBeLessThan(0.2);
    const v = cars[0]!;
    v.vx = 12;
    run(w, 3, intents());
    expect(Math.hypot(v.vx, v.vz)).toBeLessThan(0.1);
  });
});
