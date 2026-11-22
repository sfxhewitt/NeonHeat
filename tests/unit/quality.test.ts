import { describe, expect, it } from 'vitest';
import { rawContent } from '@neonheat/content';
import { DynamicResolution, QualitySchema, tierFromFrameTimes } from '@neonheat/engine';

const q = QualitySchema.parse(rawContent.quality);

describe('quality tiers', () => {
  it('ship tiers with bloom and rain off on low', () => {
    expect(q.tiers.low.bloom).toBe(false);
    expect(q.tiers.low.rain).toBe(false);
    expect(q.tiers.high.bloom).toBe(true);
  });

  it('picks a tier from the benchmark median', () => {
    // Measured while rendering the ultra tier.
    expect(tierFromFrameTimes([16.7, 16.6, 16.8, 50], q.benchmark)).toBe('ultra');
    expect(tierFromFrameTimes([22, 23, 24], q.benchmark)).toBe('high');
    expect(tierFromFrameTimes([33, 34, 35], q.benchmark)).toBe('mid');
    expect(tierFromFrameTimes([50, 55, 60], q.benchmark)).toBe('low');
  });

  it('has four tiers that scale up lighting, reflections and population', () => {
    const { low, mid, high, ultra } = q.tiers;
    expect(low.lighting.size).toBe(0);
    expect(mid.lighting.size).toBeLessThan(high.lighting.size);
    expect(high.lighting.size).toBeLessThan(ultra.lighting.size);
    expect(ultra.ssr).toBe(true);
    expect(low.ssr || mid.ssr).toBe(false);
    expect(ultra.peds).toBeGreaterThanOrEqual(high.peds);
    expect(ultra.maxPixelRatio).toBeGreaterThan(high.maxPixelRatio);
  });

  it('dynamic resolution drops under load and recovers, within 0.6..1.0', () => {
    const d = new DynamicResolution(q.dynamicResolution);
    for (let i = 0; i < 200; i++) d.sample(40);
    expect(d.scale).toBeCloseTo(0.6, 5);
    for (let i = 0; i < 2000; i++) d.sample(8);
    expect(d.scale).toBe(1);
  });
});
