import { describe, expect, it } from 'vitest';
import { Rng, WeatherConfigSchema, WeatherSystem } from '@neonheat/sim';
import { intents, loadContent, makeWorld } from './helpers';

const cfg = () => WeatherConfigSchema.parse({});

describe('weather and time of day', () => {
  it('the clock runs and wraps; daylight follows the hour', () => {
    const w = new WeatherSystem({ ...cfg(), startHour: 23.5 }, new Rng(1));
    expect(w.light).toBe(0);
    for (let i = 0; i < 60 * 60; i++) w.step(1 / 60);
    expect(w.hour).toBeCloseTo(0.5, 3);
    w.hour = 12;
    expect(w.light).toBe(1);
    w.hour = 19.5;
    expect(w.light).toBeGreaterThan(0);
    expect(w.light).toBeLessThan(1);
    expect(w.golden).toBeCloseTo(1, 5);
  });

  it('changes weather every spell, never the same twice running, and blends', () => {
    const w = new WeatherSystem(cfg(), new Rng(5));
    const seen = new Set<string>();
    let last = w.kind;
    for (let i = 0; i < 60 * 60 * 40; i++) {
      w.step(1 / 60);
      if (w.kind !== last) {
        seen.add(w.kind);
        last = w.kind;
        // Blending, not a jump.
        const before = w.rain;
        w.step(1 / 60);
        expect(Math.abs(w.rain - before)).toBeLessThan(0.05);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('streets wet fast in rain and dry slowly after it', () => {
    const w = new WeatherSystem({ ...cfg(), blendSec: 0.1 }, new Rng(2));
    w.locked = true;
    w.set('clear');
    for (let i = 0; i < 60 * 60; i++) w.step(1 / 60);
    const dried = w.wetness;
    expect(dried).toBeLessThan(0.5);
    w.set('storm');
    for (let i = 0; i < 60 * 15; i++) w.step(1 / 60);
    expect(w.wetness).toBeGreaterThan(dried + 0.5);
    expect(w.grip).toBeLessThan(1);
  });

  it('is deterministic in the world', async () => {
    const run = async () => {
      const c = loadContent();
      c.traffic.count = 0;
      c.peds.count = 0;
      c.weather.spell = [1, 2];
      const world = await makeWorld(9, c);
      const kinds: string[] = [];
      for (let i = 0; i < 60 * 12; i++) {
        world.step(intents());
        if (i % 60 === 0) kinds.push(world.weather.kind);
      }
      return kinds.join();
    };
    expect(await run()).toBe(await run());
  });
});
