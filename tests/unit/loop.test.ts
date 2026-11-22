import { describe, expect, it } from 'vitest';
import { FixedStepLoop, Rng, SIM_DT, World, emptyIntents, lerpAngle } from '@neonheat/sim';

describe('FixedStepLoop', () => {
  it('runs a whole number of fixed steps and returns the remainder as alpha', () => {
    const loop = new FixedStepLoop();
    let steps = 0;
    const alpha = loop.advance(SIM_DT * 2.5, () => steps++);
    expect(steps).toBe(2);
    expect(alpha).toBeCloseTo(0.5, 5);
  });

  it('caps steps per advance to avoid a spiral of death', () => {
    const loop = new FixedStepLoop({ maxSteps: 3 });
    let steps = 0;
    loop.advance(1, () => steps++);
    expect(steps).toBe(3);
    expect(loop.droppedTime).toBeGreaterThan(0);
  });

  it('interpolates angles along the short arc', () => {
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 1);
  });
});

describe('Rng', () => {
  it('is reproducible from a seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('differs across seeds and stays in range', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      const x = a.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      if (x === b.next()) same++;
    }
    expect(same).toBeLessThan(3);
  });

  it('round-trips its state', () => {
    const a = new Rng(7);
    a.next();
    const s = a.getState();
    const x = a.next();
    a.setState(s);
    expect(a.next()).toBe(x);
  });
});

describe('World', () => {
  it('advances ticks at 60 Hz', () => {
    const w = new World({ seed: 1 });
    for (let i = 0; i < 60; i++) w.step(emptyIntents());
    expect(w.tick).toBe(60);
    expect(w.time).toBeCloseTo(1, 6);
  });
});
