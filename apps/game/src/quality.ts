import { tierFromFrameTimes, type TierName } from '@neonheat/engine';
import type { Game } from './game';

const KEY = 'neonheat.benchmark.v1';

export function storedBenchmarkTier(): TierName | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'low' || v === 'mid' || v === 'high' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Short first-boot benchmark: render the populated block at the high tier for a
 * moment and pick a tier from the median frame time. Stored, so it runs once.
 */
export async function runBenchmark(game: Game): Promise<TierName> {
  game.applyQuality('high');
  const cfg = game.content.quality.benchmark;
  const start = game.frameTimes.length;
  await new Promise((r) => setTimeout(r, cfg.seconds * 1000));
  // Skip the first frames (shader compilation).
  const samples = game.frameTimes.slice(start + 10);
  const tier = tierFromFrameTimes(samples, cfg);
  try {
    localStorage.setItem(KEY, tier);
  } catch {
    /* storage unavailable: benchmark again next boot */
  }
  return tier;
}
