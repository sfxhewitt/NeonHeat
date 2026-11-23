import { describe, expect, it } from 'vitest';
import { distanceToRoute, districtAt, geometryFromBlockMap, routeLength, straightRoute } from '../../packages/ui/src/map-geometry';
import { CREWS, crewById } from '../../packages/ui/src/icons';
import block from '../../content/map/block0.json';

describe('map geometry', () => {
  const geom = geometryFromBlockMap(block as unknown as Parameters<typeof geometryFromBlockMap>[0]);

  it('turns the block map into crossing roads, buildings, one district and service landmarks', () => {
    const n = block.roads.positions.length;
    expect(geom.size).toEqual(block.size);
    expect(geom.roads).toHaveLength(n * 2);
    for (const r of geom.roads) {
      expect(r.width).toBe(block.roads.width);
      // Each road runs the full extent along one axis.
      expect(r.x0 === r.x1 || r.z0 === r.z1).toBe(true);
    }
    expect(geom.buildings).toHaveLength(block.buildings.length);
    expect(geom.water).toEqual([]);
    expect(geom.parks).toEqual([]);
    expect(geom.districts).toHaveLength(1);
    const kinds = geom.landmarks.map((l) => l.kind).sort();
    expect(kinds).toEqual(['chopshop', 'clinic']);
  });

  it('finds the district under a point', () => {
    expect(districtAt(geom, 0, 0)?.id).toBe('block0');
    expect(districtAt(geom, 10_000, 0)).toBeNull();
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
