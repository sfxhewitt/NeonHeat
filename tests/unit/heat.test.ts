import { describe, expect, it } from 'vitest';
import { Heat } from '@neonheat/sim';
import { loadContent } from './helpers';

function heat(): Heat {
  return new Heat(loadContent().heat);
}

describe('HEAT escalation', () => {
  it('starts cold and rises through all five levels as witnessed points accrue', () => {
    const h = heat();
    expect(h.level).toBe(0);
    expect(h.config.maxLevel).toBe(5);
    for (let l = 1; l <= 5; l++) {
      h.addPoints(h.config.thresholds[l]! - h.points, 0, 0);
      expect(h.level).toBe(l);
    }
    h.addPoints(1000, 0, 0);
    expect(h.level).toBe(5);
  });

  it('caps at the configured maximum level', () => {
    const h = heat();
    h.setLevel(9, 0, 0);
    expect(h.level).toBe(h.config.maxLevel);
  });

  it('unwitnessed points never push past the unwitnessed cap level', () => {
    const h = heat();
    for (let i = 0; i < 500; i++) h.addUnwitnessed(5, 0, 0);
    expect(h.level).toBe(h.config.witness.unwitnessedMaxLevel);
    expect(h.points).toBeLessThan(h.config.thresholds[h.config.witness.unwitnessedMaxLevel + 1]!);
  });

  it('counts a car hit as a crime only when repeated within the window', () => {
    const h = heat();
    expect(h.civCarHit(0)).toBe(false);
    expect(h.civCarHit(2)).toBe(true);
    const g = heat();
    expect(g.civCarHit(0)).toBe(false);
    expect(g.civCarHit(g.config.repeatWindowSec + 5)).toBe(false);
  });

  it('has distinct behaviour at every level', () => {
    const l = heat().config.levels;
    expect(l[1]!.tactic).toBe('investigate');
    expect(l[1]!.units).toBe(1);
    expect(l[2]!.tactic).toBe('pursue');
    expect(l[2]!.drone).toBe(false);
    expect(l[3]!.drone && l[3]!.officersShoot).toBe(true);
    expect(l[2]!.officersShoot).toBe(false);
    expect(l[4]!.roadblocks && l[4]!.spikes).toBe(true);
    expect(l[3]!.roadblocks).toBe(false);
    expect(l[4]!.variants).toContain('warden');
    expect(l[5]!.variants).toContain('patrolvan');
    expect(l[5]!.tactical).toBe(true);
    for (let i = 1; i < 5; i++) expect(l[i + 1]!.units).toBeGreaterThan(l[i]!.units);
  });
});

describe('HEAT decay', () => {
  const dt = 1 / 60;

  it('HEAT 1 drops after about 15 s out of sight', () => {
    const h = heat();
    h.setLevel(1, 0, 0);
    expect(h.decaySeconds).toBeGreaterThanOrEqual(12);
    expect(h.decaySeconds).toBeLessThanOrEqual(18);
    let t = 0;
    while (t < h.decaySeconds - 0.1) {
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
    for (let i = 0; i < 600; i++) h.update(dt, false, 0, 0);
    h.update(dt, true, 5, 5);
    for (let i = 0; i < 600; i++) h.update(dt, false, 5, 5);
    expect(h.level).toBe(1);
    expect(h.lastKnownX).toBe(5);
  });

  it('at level 2+ only decays once outside the search radius', () => {
    const h = heat();
    h.setLevel(2, 0, 0);
    for (let i = 0; i < 60 * 40; i++) h.update(dt, false, 10, 10);
    expect(h.level).toBe(2);
    const far = h.searchRadius + 5;
    for (let i = 0; i < 60 * (h.decaySeconds + 0.5); i++) h.update(dt, false, far, 0);
    expect(h.level).toBe(1);
    // Level 1 has no search radius requirement.
    for (let i = 0; i < 60 * (h.decaySeconds + 0.5); i++) h.update(dt, false, far, 0);
    expect(h.level).toBe(0);
  });

  it('dropLevel steps down one level', () => {
    const h = heat();
    h.setLevel(3, 0, 0);
    h.dropLevel();
    expect(h.level).toBe(2);
    expect(h.points).toBe(h.config.thresholds[2]);
  });
});
