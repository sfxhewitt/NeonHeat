import { describe, expect, it } from 'vitest';
import { SignalsView } from '@neonheat/engine';
import { trafficLight } from '@neonheat/sim';
import { loadContent, makeWorld } from './helpers';

describe('traffic signals', () => {
  it('puts a signal on every approach of every light-controlled junction and streams the near ones', async () => {
    const c = loadContent();
    c.traffic.count = 0;
    c.peds.count = 0;
    const w = await makeWorld(1, c);
    const added: { name: string; count: number }[] = [];
    const scene = { add: (...o: { name: string; count: number }[]) => added.push(...o) };
    const view = new SignalsView(scene as unknown as ConstructorParameters<typeof SignalsView>[0], w.roads, c.traffic.lights);
    const junctions = w.roads.nodes.filter((n) => n.junction).length;
    expect(view.count).toBeGreaterThanOrEqual(junctions * 3);
    const poles = added.find((o) => o.name === 'signal-poles')!;
    view.update(w.player.x, w.player.z, 0);
    expect(poles.count).toBeGreaterThan(0);
    expect(poles.count).toBeLessThan(view.count);
  });

  it('crossing directions are never green at the same time', () => {
    const node = { id: 17, x: 0, z: 0, links: [], edges: [], junction: true };
    const cfg = loadContent().traffic.lights;
    for (let t = 0; t < 60; t += 0.1) {
      const a = trafficLight(node, true, t, cfg);
      const b = trafficLight(node, false, t, cfg);
      expect(a === 'green' && b === 'green').toBe(false);
    }
  });
});
