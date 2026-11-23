import { describe, expect, it } from 'vitest';
import { forwardSpeed } from '@neonheat/sim';
import { intents, loadContent, makeWorld, run } from './helpers';

/** An empty map with one prop in front of the player's car on an open stretch. */
async function lineUp(kind: string, gap = 25) {
  const content = loadContent();
  content.map.buildings = [];
  content.map.props = [{ kind, x: -110 + gap, z: 0, yaw: 0 }];
  content.traffic.count = 0;
  content.peds.count = 0;
  const world = await makeWorld(1, content);
  const car = world.spawnVehicle('kestrel', -110, 0, Math.PI / 2, 'player')!;
  world.playerCtl.enter(car);
  return { world, car, prop: world.props.props[0]! };
}

describe('street furniture', () => {
  it('loads every map prop with a known kind', () => {
    const c = loadContent();
    expect(c.map.props.length).toBeGreaterThan(100);
    for (const p of c.map.props) expect(c.props.kinds[p.kind]).toBeDefined();
  });

  it('a fast car smashes through a breakable prop, losing a little speed', async () => {
    const { world, car, prop } = await lineUp('bin');
    let broke = false;
    for (let i = 0; i < 60 * 4; i++) {
      world.step(intents({ throttle: 1 }));
      if (world.events.some((e) => e.type === 'propBroken' && e.byPlayer)) broke = true;
    }
    expect(broke).toBe(true);
    expect(prop.broken).toBe(true);
    expect(car.x).toBeGreaterThan(prop.x + 10);
    expect(forwardSpeed(car)).toBeGreaterThan(15);
  });

  it('a solid prop stops the car', async () => {
    const { world, car, prop } = await lineUp('dumpster');
    run(world, 4, intents({ throttle: 1 }));
    expect(prop.broken).toBe(false);
    expect(car.x).toBeLessThan(prop.x);
  });

  it('a crawling car does not break a bollard', async () => {
    const { world, car, prop } = await lineUp('bollard', 6);
    // Creep at walking pace (about 1.5 m/s): the bollard stops the car rather than flying off.
    run(world, 5, () => intents(Math.hypot(car.vx, car.vz) < 1.4 ? { throttle: 0.3 } : {}));
    expect(prop.broken).toBe(false);
    expect(car.x).toBeLessThan(prop.x);
  });

  it('smashed props come back once nobody is near', async () => {
    const { world, prop } = await lineUp('bin');
    run(world, 4, intents({ throttle: 1 }));
    expect(prop.broken).toBe(true);
    run(world, 4, intents({ throttle: 1 }));
    run(world, world.content.props.respawnSec + 1, intents({ brake: 1 }));
    expect(prop.broken).toBe(false);
  });
});
