import { describe, expect, it } from 'vitest';
import { forwardSpeed } from '@neonheat/sim';
import { intents, loadContent, makeWorld, run } from './helpers';

/** Spawn the player in a car on an empty map (no buildings), facing east. */
async function onOpenRoad(seed = 1, variant = 'kestrel') {
  const content = loadContent();
  content.map.buildings = [];
  content.traffic.count = 0;
  const world = await makeWorld(seed, content);
  const car = world.spawnVehicle(variant, -110, 0, Math.PI / 2, 'player')!;
  world.playerCtl.enter(car);
  return { world, car };
}

describe('arcade vehicle', () => {
  it('reaches top speed under full throttle', async () => {
    const { world, car } = await onOpenRoad();
    run(world, 6, intents({ throttle: 1 }));
    expect(forwardSpeed(car)).toBeGreaterThan(car.params.topSpeed * 0.97);
    expect(forwardSpeed(car)).toBeLessThanOrEqual(car.params.topSpeed * 1.001);
    expect(car.x).toBeGreaterThan(-110 + 80);
    expect(Math.abs(car.z)).toBeLessThan(0.5);
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
    expect(car.z).toBeLessThan(0);
  });

  it('collides with buildings instead of passing through them', async () => {
    const content = loadContent();
    content.traffic.count = 0;
    const world = await makeWorld(1, content);
    // Centre building spans x -29..1, z -27..3. Drive north into it from the road at z = 40.
    const car = world.spawnVehicle('kestrel', -14, 34, Math.PI, 'player')!;
    world.playerCtl.enter(car);
    run(world, 3, intents({ throttle: 1 }));
    expect(car.z).toBeGreaterThan(3);
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
