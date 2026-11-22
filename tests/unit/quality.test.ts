import { describe, expect, it } from 'vitest';
import { rawContent } from '@neonheat/content';
import { DynamicResolution, QualitySchema, tierFromFrameTimes } from '@neonheat/engine';

const q = QualitySchema.parse(rawContent.quality);

describe('quality tiers', () => {
  it('ship three tiers with bloom and rain off on low', () => {
    expect(q.tiers.low.bloom).toBe(false);
    expect(q.tiers.low.rain).toBe(false);
    expect(q.tiers.high.bloom).toBe(true);
  });

  it('picks a tier from the benchmark median', () => {
    expect(tierFromFrameTimes([10, 12, 11, 50], q.benchmark)).toBe('high');
    expect(tierFromFrameTimes([22, 23, 24], q.benchmark)).toBe('mid');
    expect(tierFromFrameTimes([40, 45, 60], q.benchmark)).toBe('low');
  });

  it('dynamic resolution drops under load and recovers, within 0.6..1.0', () => {
    const d = new DynamicResolution(q.dynamicResolution);
    for (let i = 0; i < 200; i++) d.sample(40);
    expect(d.scale).toBeCloseTo(0.6, 5);
    for (let i = 0; i < 2000; i++) d.sample(8);
    expect(d.scale).toBe(1);
  });
});
