import { z } from 'zod';
import type { Rng } from './rng';

export const WeatherKindSchema = z.enum(['clear', 'drizzle', 'rain', 'storm', 'fog']);
export type WeatherKind = z.infer<typeof WeatherKindSchema>;

export const WeatherConfigSchema = z.object({
  /** In-game hour when a new game starts (0–24). */
  startHour: z.number().min(0).max(24).default(22),
  /** Real seconds per in-game hour (60 = a 24-minute day). */
  secondsPerHour: z.number().positive().default(60),
  /** Seconds a weather spell lasts, min and max. */
  spell: z.tuple([z.number().positive(), z.number().positive()]).default([150, 330]),
  /** Seconds to blend from one weather to the next. */
  blendSec: z.number().positive().default(25),
  /** How quickly the streets dry once the rain stops (wetness per second). */
  dryRate: z.number().positive().default(0.004),
  /** How quickly they wet in full rain (wetness per second). */
  wetRate: z.number().positive().default(0.05),
  /** Relative chance of each weather. */
  weights: z.record(WeatherKindSchema, z.number().nonnegative()).default({ clear: 2, drizzle: 3, rain: 3, storm: 1, fog: 1.5 }),
  /** Rain amount (0–1) and fog density (0–1) of each weather. */
  kinds: z
    .record(WeatherKindSchema, z.object({ rain: z.number().min(0).max(1), fog: z.number().min(0).max(1) }))
    .default({
      clear: { rain: 0, fog: 0.1 },
      drizzle: { rain: 0.35, fog: 0.25 },
      rain: { rain: 0.75, fog: 0.35 },
      storm: { rain: 1, fog: 0.5 },
      fog: { rain: 0.05, fog: 1 },
    }),
  /** Tyre grip multiplier on fully wet roads. */
  wetGrip: z.number().min(0.5).max(1).default(0.9),
});
export type WeatherConfig = z.infer<typeof WeatherConfigSchema>;

/**
 * The city's clock and weather. Deterministic (draws from the world RNG only
 * when a new spell starts). Rain and fog blend between spells; the streets
 * wet quickly in rain and dry slowly after it, so reflections linger.
 * Rendering and audio read `hour`, `rain`, `fog`, `wetness` and `light`.
 */
export class WeatherSystem {
  /** In-game hour, 0 to 24. */
  hour: number;
  kind: WeatherKind = 'drizzle';
  /** Current rain amount, fog density and road wetness, 0 to 1. */
  rain: number;
  fog: number;
  wetness: number;
  private from: { rain: number; fog: number };
  private blend = 1;
  private spellLeft: number;
  /** Lock to one weather and hour (photo mode, missions, tests). */
  locked = false;

  constructor(
    readonly config: WeatherConfig,
    private readonly rng: Rng,
  ) {
    this.hour = config.startHour;
    const k = config.kinds[this.kind] ?? { rain: 0.35, fog: 0.25 };
    this.rain = k.rain;
    this.fog = k.fog;
    this.wetness = Math.max(0.6, k.rain);
    this.from = { rain: k.rain, fog: k.fog };
    this.spellLeft = config.spell[0];
  }

  /** Daylight, 0 at night to 1 at midday, with a soft dawn (5–8) and dusk (18–21). */
  get light(): number {
    const h = this.hour;
    if (h < 5 || h >= 21) return 0;
    if (h < 8) return smooth((h - 5) / 3);
    if (h < 18) return 1;
    return 1 - smooth((h - 18) / 3);
  }

  /** How golden the light is: peaks at dawn and dusk. */
  get golden(): number {
    const h = this.hour;
    const d = Math.min(Math.abs(h - 6.5), Math.abs(h - 19.5));
    return Math.max(0, 1 - d / 1.6);
  }

  /** Tyre grip multiplier from the wet road. */
  get grip(): number {
    return 1 - (1 - this.config.wetGrip) * this.wetness;
  }

  /** Change the weather now (blends over blendSec). */
  set(kind: WeatherKind, spellSec?: number): void {
    this.from = { rain: this.rain, fog: this.fog };
    this.kind = kind;
    this.blend = 0;
    this.spellLeft = spellSec ?? this.rng.range(this.config.spell[0], this.config.spell[1]);
  }

  step(dt: number): void {
    const c = this.config;
    if (!this.locked) {
      this.hour = (this.hour + dt / c.secondsPerHour) % 24;
      this.spellLeft -= dt;
      if (this.spellLeft <= 0) this.set(this.pick());
    }
    const k = c.kinds[this.kind] ?? { rain: 0, fog: 0 };
    this.blend = Math.min(1, this.blend + dt / c.blendSec);
    const t = smooth(this.blend);
    this.rain = this.from.rain + (k.rain - this.from.rain) * t;
    this.fog = this.from.fog + (k.fog - this.from.fog) * t;
    if (this.rain > 0.1) this.wetness = Math.min(1, this.wetness + c.wetRate * this.rain * dt);
    else this.wetness = Math.max(0, this.wetness - c.dryRate * dt);
  }

  private pick(): WeatherKind {
    const entries = Object.entries(this.config.weights) as [WeatherKind, number][];
    // Never the same twice in a row, so the city visibly changes.
    const options = entries.filter(([k, w]) => k !== this.kind && w > 0);
    let total = 0;
    for (const [, w] of options) total += w;
    let r = this.rng.next() * total;
    for (const [k, w] of options) {
      r -= w;
      if (r < 0) return k;
    }
    return options[options.length - 1]?.[0] ?? this.kind;
  }
}

function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
