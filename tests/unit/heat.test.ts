import { describe, expect, it } from 'vitest';
import { Heat } from '@neonheat/sim';
import { loadContent } from './helpers';

function heat(): Heat {
  return new Heat(loadContent().heat);
}

describe('HEAT escalation', () => {
  it('starts cold and rises through levels as points accrue', () => {
    const h = heat();
    expect(h.level).toBe(0);
    h.addPoints(h.config.points.ramPolice, 0, 0);
    expect(h.level).toBe(1);
    h.addPoints(h.config.thresholds[2]!, 0, 0);
    expect(h.level).toBe(2);
    h.addPoints(1000, 0, 0);
    expect(h.level).toBe(h.config.maxLevel);
  });

  it('caps at the configured maximum level (3 in Phase 0)', () => {
    const h = heat();
    h.setLevel(5, 0, 0);
    expect(h.level).toBe(3);
  });

  it('ignores a single bump into a civilian car but counts repeated hits', () => {
    const h = heat();
    h.civCarHit(0, 0, 0);
    expect(h.level).toBe(0);
    h.civCarHit(2, 0, 0);
    expect(h.level).toBe(1);
  });

  it('forgets old hits outside the repeat window', () => {
    const h = heat();
    h.civCarHit(0, 0, 0);
    h.civCarHit(h.config.repeatWindowSec + 5, 0, 0);
    expect(h.level).toBe(0);
  });

  it('rises from hitting a pedestrian and from firing', () => {
    const h = heat();
    h.pedHit(0, 0, 0);
    expect(h.level).toBe(1);
    const before = h.points;
    h.addPoints(h.config.points.fireWeapon, 0, 0);
    expect(h.points).toBeGreaterThan(before);
  });
});

describe('HEAT decay', () => {
  const dt = 1 / 60;

  it('drops a level after breaking line of sight for the decay time at level 1', () => {
    const h = heat();
    h.setLevel(1, 0, 0);
    let t = 0;
    while (t < h.config.decaySeconds - 0.1) {
      h.update(dt, false, 0, 0);
      t += dt;
    }
    expect(h.level).toBe(1);
    for (let i = 0; i < 12; i++) h.update(dt, false, 0, 0);
    expect(h.level).toBe(0);
  });

  it('resets the timer whenever a unit sees the player', () => {
    const h = heat();
    h.setLevel(1, 0, 0);
    for (let i = 0; i < 540; i++) h.update(dt, false, 0, 0);
    h.update(dt, true, 5, 5);
    for (let i = 0; i < 540; i++) h.update(dt, false, 5, 5);
    expect(h.level).toBe(1);
    expect(h.lastKnownX).toBe(5);
  });

  it('at level 2+ only decays once outside the search radius', () => {
    const h = heat();
    h.setLevel(2, 0, 0);
    // Hiding inside the search radius: no decay however long.
    for (let i = 0; i < 60 * 30; i++) h.update(dt, false, 10, 10);
    expect(h.level).toBe(2);
    // Leave the radius: decays after the decay time.
    const far = h.searchRadius + 5;
    for (let i = 0; i < 60 * (h.config.decaySeconds + 0.5); i++) h.update(dt, false, far, 0);
    expect(h.level).toBe(1);
    // Level 1 has no search radius requirement.
    for (let i = 0; i < 60 * (h.config.decaySeconds + 0.5); i++) h.update(dt, false, far, 0);
    expect(h.level).toBe(0);
  });
});
