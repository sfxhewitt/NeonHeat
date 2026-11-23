import { describe, expect, it } from 'vitest';
import { RoadGraph, mainNetwork, onPavement } from '@neonheat/sim';
import { loadContent } from './helpers';

describe('GPS routes and the road network', () => {
  const map = loadContent().map;
  const g = new RoadGraph(map);

  it('every road, alleys included, is part of one connected network', () => {
    const main = mainNetwork(g);
    expect(g.nodes.filter((n) => !main(n))).toEqual([]);
  });

  it('a route runs along roads: every leg is axis-aligned and every midpoint is on a road', () => {
    const rng = (i: number) => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
    for (let i = 0; i < 40; i++) {
      const ax = -700 + rng(i) * 1400;
      const az = -700 + rng(i + 100) * 1400;
      const bx = -700 + rng(i + 200) * 1400;
      const bz = -700 + rng(i + 300) * 1400;
      const pts = g.route(ax, az, bx, bz);
      // The legs between the two road-joining points follow centre lines.
      for (let k = 1; k < pts.length - 2; k++) {
        const p = pts[k]!;
        const q = pts[k + 1]!;
        expect(Math.min(Math.abs(p.x - q.x), Math.abs(p.z - q.z)), `route ${i} leg ${k}`).toBeLessThan(0.01);
        const mx = (p.x + q.x) / 2;
        const mz = (p.z + q.z) / 2;
        if (Math.hypot(p.x - q.x, p.z - q.z) > 2) expect(onPavement(map, mx, mz), `route ${i} leg ${k} at ${mx},${mz}`).toBe(false);
      }
    }
  });

  it('a short hop round a block goes round it, not through it', () => {
    // From one side of a built block to the other: the route is longer than the straight line.
    const b = map.blocks.find((k) => k.kind === 'built' && k.x1 - k.x0 > 60 && k.z1 - k.z0 > 60)!;
    const pts = g.route(b.x0 - 3, (b.z0 + b.z1) / 2, b.x1 + 3, (b.z0 + b.z1) / 2);
    let len = 0;
    for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k]!.x - pts[k - 1]!.x, pts[k]!.z - pts[k - 1]!.z);
    expect(len).toBeGreaterThan(b.x1 - b.x0 + 20);
  });
});
