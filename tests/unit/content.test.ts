import { describe, expect, it } from 'vitest';
import { rawContent } from '@neonheat/content';
import { parseSimContent, VehiclesSchema } from '@neonheat/sim';
import { CameraConfigSchema } from '@neonheat/engine';
import { loadContent } from './helpers';

describe('content', () => {
  it('validates all shipped content', () => {
    expect(() => loadContent()).not.toThrow();
    expect(() => CameraConfigSchema.parse(rawContent.camera)).not.toThrow();
  });

  it('rejects invalid vehicle data with a readable error', () => {
    const bad = structuredClone(rawContent);
    (bad.vehicles.variants.kestrel as { grip: unknown }).grip = 'sticky';
    expect(() => parseSimContent(bad as never)).toThrow(/vehicles/);
    expect(VehiclesSchema.safeParse({ player: 'x', variants: {}, damage: { impactThreshold: 1, damagePerMs: 1, destroyedEjectSec: 1 } }).success).toBe(false);
  });

  it('keeps buildings off roads and markers/spawns out of buildings', () => {
    const { map } = loadContent();
    const half = map.roads.width / 2;
    for (const b of map.buildings) {
      for (const r of map.roads.positions) {
        const insideRoadSpanX = Math.abs(b.x) - b.w / 2 < map.roads.extent;
        const insideRoadSpanZ = Math.abs(b.z) - b.d / 2 < map.roads.extent;
        if (insideRoadSpanZ) expect(Math.abs(b.x - r) >= b.w / 2 + half, `building ${JSON.stringify(b)} on road x=${r}`).toBe(true);
        if (insideRoadSpanX) expect(Math.abs(b.z - r) >= b.d / 2 + half, `building ${JSON.stringify(b)} on road z=${r}`).toBe(true);
      }
    }
    const points = [...Object.entries(map.markers).map(([k, m]) => [k, m.pos] as const), ...Object.entries(map.spawns).map(([k, s]) => [k, s.pos] as const)];
    for (const [name, [x, , z]] of points) {
      for (const b of map.buildings) {
        const inside = Math.abs(x - b.x) < b.w / 2 + 1.5 && Math.abs(z - b.z) < b.d / 2 + 1.5;
        expect(inside, `${name} inside building`).toBe(false);
      }
    }
  });
});
