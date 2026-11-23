import { describe, expect, it } from 'vitest';
import { rawContent } from '@neonheat/content';
import { Cell, cityGrid, parseSimContent, VehiclesSchema } from '@neonheat/sim';
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

  it('keeps buildings off roads and water, and markers/spawns out of buildings', () => {
    const { map } = loadContent();
    const g = cityGrid(map);
    // Sample each building's footprint: no road or water under it.
    for (const b of map.buildings) {
      for (const [fx, fz] of [[0, 0], [-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]] as const) {
        const c = g.at(b.x + fx * b.w, b.z + fz * b.d);
        expect(c & (Cell.road | Cell.water), `building ${JSON.stringify(b)} on road or water`).toBe(0);
      }
    }
    const points = [...Object.entries(map.markers).map(([k, m]) => [k, m.pos] as const), ...Object.entries(map.spawns).map(([k, s]) => [k, s.pos] as const)];
    for (const [name, [x, , z]] of points) {
      for (const b of map.buildings) {
        const inside = Math.abs(x - b.x) < b.w / 2 + 0.6 && Math.abs(z - b.z) < b.d / 2 + 0.6;
        expect(inside, `${name} inside building`).toBe(false);
      }
      expect(g.at(x, z) & Cell.water, `${name} in the river`).toBe(0);
    }
  });

  it('generates the whole city deterministically with every district and the mission vocabulary', () => {
    const a = loadContent().map;
    const b = loadContent().map;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.size[0]).toBeGreaterThanOrEqual(1500);
    expect(a.buildings.length).toBeGreaterThan(1500);
    for (const d of ['glass', 'lantern', 'saltworks', 'ashgrove', 'undercroft']) {
      for (const k of ['payphone_4', 'lot_4', 'road_8', 'door_6']) expect(a.markers[`${d}_${k}`], `${d}_${k}`).toBeDefined();
    }
    for (const k of ['player_start', 'clinic_north', 'precinct_south', 'safehouse_3', 'respray_2', 'chopshop_1', 'bridge_east', 'tunnel_mouth']) expect(a.markers[k], k).toBeDefined();
    expect(a.roads.segments.filter((s) => s.kind === 'bridge').length).toBe(3);
  });
});
