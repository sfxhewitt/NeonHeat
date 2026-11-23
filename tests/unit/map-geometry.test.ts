import { describe, expect, it } from 'vitest';
import {
  distanceToRoute,
  districtAt,
  geometryFromBlockMap,
  geometryFromMap,
  routeLength,
  straightRoute,
} from '../../packages/ui/src/map-geometry';
import { CREWS, crewById } from '../../packages/ui/src/icons';
import { loadContent } from './helpers';

describe('map geometry', () => {
  it('turns a block map into crossing roads, buildings, one district and service landmarks', () => {
    const block = {
      size: [300, 300] as [number, number],
      roads: { positions: [-120, -40, 40, 120], width: 14, extent: 127 },
      buildings: [{ x: 0, z: 0, w: 10, d: 10, h: 20 }],
      markers: { clinic: { pos: [-128, 0, -128] }, gh_chopshop: { pos: [-60, 0, 64] }, player_start: { pos: [0, 0, 0] } },
    };
    const geom = geometryFromBlockMap(block);
    expect(geom.roads).toHaveLength(8);
    for (const r of geom.roads) expect(r.x0 === r.x1 || r.z0 === r.z1).toBe(true);
    expect(geom.districts).toHaveLength(1);
    expect(geom.landmarks.map((l) => l.kind).sort()).toEqual(['chopshop', 'clinic']);
    expect(districtAt(geom, 0, 0)?.id).toBe('block0');
    expect(districtAt(geom, 10_000, 0)).toBeNull();
  });

  it('turns the generated city into segments, water, parks, districts and landmarks', () => {
    const map = loadContent().map;
    const geom = geometryFromMap(map as unknown as Parameters<typeof geometryFromMap>[0]);
    expect(geom.size).toEqual(map.size);
    expect(geom.roads).toHaveLength(map.roads.segments.length);
    expect(geom.roads.some((r) => r.kind === 'bridge')).toBe(true);
    expect(geom.water.length).toBeGreaterThan(0);
    expect(geom.parks.length).toBeGreaterThan(0);
    // Every district is on the map, and every point inside a district rect is found.
    expect(new Set(geom.districts.map((d) => d.id)).size).toBe(map.districts.length);
    for (const d of geom.districts) expect(districtAt(geom, d.x, d.z)?.name).toBe(d.name);
    const kinds = new Set(geom.landmarks.map((l) => l.kind));
    for (const k of ['clinic', 'precinct', 'safehouse', 'respray', 'arms', 'chopshop', 'landmark']) expect(kinds.has(k as never)).toBe(true);
  });

  it('measures routes and the distance from a point to them', () => {
    const r = [
      { x: 0, z: 0 },
      { x: 30, z: 0 },
      { x: 30, z: 40 },
    ];
    expect(routeLength(r)).toBe(70);
    expect(distanceToRoute(r, 15, 5)).toBeCloseTo(5);
    expect(distanceToRoute(r, 35, 20)).toBeCloseTo(5);
    expect(distanceToRoute(r, -3, -4)).toBeCloseTo(5);
    expect(straightRoute(1, 2, 3, 4)).toEqual([
      { x: 1, z: 2 },
      { x: 3, z: 4 },
    ]);
  });

  it('pairs every crew colour with a distinct shape', () => {
    expect(CREWS).toHaveLength(5);
    expect(new Set(CREWS.map((c) => c.shape)).size).toBe(5);
    expect(new Set(CREWS.map((c) => c.colour)).size).toBe(5);
    expect(crewById('nobody').name).toBe('Nobody');
  });
});
