import { z } from 'zod';

export const QualityTierSchema = z.object({
  maxPixelRatio: z.number().positive(),
  bloom: z.boolean(),
  rain: z.boolean(),
  rainStreaks: z.number().int().nonnegative(),
  rainSplashes: z.number().int().nonnegative(),
  peds: z.number().int().nonnegative(),
  traffic: z.number().int().nonnegative(),
  police: z.number().int().nonnegative(),
  dynamicResolution: z.boolean(),
  /** Real-time light field: buffer texels (0 = off, baked pools only), world extent, shadow ray-march steps. */
  lighting: z.object({ size: z.number().int().nonnegative(), extent: z.number().positive(), shadowSteps: z.number().int().min(0).max(32) }),
  /** Screen-space reflections on the wet street. */
  ssr: z.boolean(),
  /** Scene brightness above which light also blooms. */
  bloomThreshold: z.number().positive(),
  /** Living city: most ambulances and fire tenders out at once, crew members and crew cars around the player. */
  responders: z.number().int().nonnegative().default(2),
  gangMembers: z.number().int().nonnegative().default(12),
  gangCars: z.number().int().nonnegative().default(1),
});
export const QualitySchema = z.object({
  tiers: z.object({ low: QualityTierSchema, mid: QualityTierSchema, high: QualityTierSchema, ultra: QualityTierSchema }),
  benchmark: z.object({
    seconds: z.number().positive(),
    /**
     * Median frame time thresholds (ms), measured while rendering the ultra
     * tier: at or under ultraMs = ultra, highMs = high, midMs = mid, else low.
     */
    ultraMs: z.number().positive(),
    highMs: z.number().positive(),
    midMs: z.number().positive(),
  }),
  dynamicResolution: z.object({ targetMs: z.number().positive(), min: z.number().min(0.3).max(1), step: z.number().positive() }),
});
export type QualityConfig = z.infer<typeof QualitySchema>;
export type QualityTierConfig = z.infer<typeof QualityTierSchema>;
export type TierName = keyof QualityConfig['tiers'];

/** Pick a tier from benchmark frame times. */
export function tierFromFrameTimes(frameMs: number[], cfg: QualityConfig['benchmark']): TierName {
  if (frameMs.length === 0) return 'mid';
  const sorted = [...frameMs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median <= cfg.ultraMs) return 'ultra';
  if (median <= cfg.highMs) return 'high';
  if (median <= cfg.midMs) return 'mid';
  return 'low';
}

/**
 * Dynamic resolution: nudges the render scale between min and 1.0 of the
 * device pixel ratio to hold the frame-time target.
 */
export class DynamicResolution {
  scale = 1;
  private acc = 0;
  private frames = 0;
  private since = 0;

  constructor(private readonly cfg: QualityConfig['dynamicResolution']) {}

  /** Feed one frame time; returns a new scale when it changes. */
  sample(frameMs: number): number | null {
    this.acc += frameMs;
    this.frames++;
    this.since += frameMs;
    if (this.since < 1000) return null;
    const avg = this.acc / this.frames;
    this.acc = this.frames = this.since = 0;
    const { targetMs, min, step } = this.cfg;
    let next = this.scale;
    if (avg > targetMs * 1.2) next = Math.max(min, this.scale - step);
    else if (avg < targetMs * 0.8) next = Math.min(1, this.scale + step / 2);
    if (next === this.scale) return null;
    this.scale = next;
    return next;
  }
}
