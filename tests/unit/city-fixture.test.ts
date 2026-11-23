import { describe, expect, it } from 'vitest';
import { RoadGraph, onPavement } from '@neonheat/sim';
import { fixtureCity, markerVocabulary } from './fixtures/city-fixture';
import { fixtureContent, makeWorld } from './helpers';

describe('Vey City test fixture', () => {
  const map = fixtureCity();
  const inside = (x: number, z: number, m = 0): boolean => map.buildings.some((b) => Math.abs(x - b.x) < b.w / 2 + m && Math.abs(z - b.z) < b.d / 2 + m);

  it('has every guaranteed marker, each in a sensible place', () => {
    const roads = new RoadGraph(map);
    for (const id of markerVocabulary()) {
      const m = map.markers[id];
      expect(m, id).toBeDefined();
      const [x, , z] = m!.pos;
      expect(inside(x, z, 0.8), `${id} inside a building`).toBe(false);
      if (/_road_/.test(id)) expect(roads.onRoad(x, z), `${id} on a road`).toBe(true);
      if (/_(payphone|door)_/.test(id)) expect(onPavement(map, x, z), `${id} on pavement`).toBe(true);
      if (/_lot_/.test(id)) expect(roads.onRoad(x, z), `${id} off road`).toBe(false);
    }
  });

  it('builds a world', async () => {
    const w = await makeWorld(1, fixtureContent());
    expect(w.vehicles.some((v) => v.active)).toBe(true);
    w.dispose();
  });
});
