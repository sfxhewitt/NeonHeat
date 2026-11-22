import { tierFromFrameTimes, type TierName } from '@neonheat/engine';
import type { Game } from './game';

const KEY = 'neonheat.benchmark.v3';

export function storedBenchmarkTier(): TierName | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'low' || v === 'mid' || v === 'high' || v === 'ultra' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Short first-boot benchmark: render the populated block at the top (ultra)
 * tier for a moment and pick a tier from the median frame time. Stored, so it runs once.
 */
export async function runBenchmark(game: Game): Promise<TierName> {
  game.applyQuality('ultra');
  game.holdResolution = true;
  const cfg = game.content.quality.benchmark;
  const start = game.frameTimes.length;
  // Shader compilation can take seconds on first boot, so wait for real samples rather than a fixed
  // window: skip the first frames, then collect at least 40 (or give up after three windows).
  const skip = 10;
  const t0 = performance.now();
  const samples = (): number[] => game.frameTimes.slice(start + skip);
  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    const elapsed = (performance.now() - t0) / 1000;
    const n = samples().length;
    if ((elapsed >= cfg.seconds && n >= 40) || elapsed >= cfg.seconds * 3) break;
  }
  game.holdResolution = false;
  let got = samples();
  // A very slow device may not even get past the warm-up frames: judge it on everything it did
  // render, and if it could not finish a single frame in that time it belongs on the lowest tier.
  if (got.length < 5) got = game.frameTimes.slice(start);
  const tier = got.length === 0 ? 'low' : tierFromFrameTimes(got, cfg);
  if (got.length >= 5) {
    try {
      localStorage.setItem(KEY, tier);
    } catch {
      /* storage unavailable: benchmark again next boot */
    }
  }
  return tier;
}
