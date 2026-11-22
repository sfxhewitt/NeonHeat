import '@neonheat/ui/ui.css';
import { showTitle } from '@neonheat/ui';
import type { TierName } from '@neonheat/engine';
import { Game } from './game';
import { installTestHooks } from './test-hooks';
import { runBenchmark, storedBenchmarkTier } from './quality';

function isTier(v: string | null): v is TierName {
  return v === 'low' || v === 'mid' || v === 'high';
}

export async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay') as HTMLElement;
  const params = new URLSearchParams(location.search);
  const game = new Game(canvas, overlay);
  const seed = Number(params.get('seed') ?? '1');
  await game.init(seed);
  installTestHooks(game);
  game.start();

  // Quality: URL override > settings > stored benchmark > run the benchmark now (behind the title).
  const forced = params.get('quality');
  let benchmarked = storedBenchmarkTier();
  let status = '';
  const pick = (): TierName => {
    if (isTier(forced)) return forced;
    if (game.settings.quality !== 'auto') return game.settings.quality;
    return benchmarked ?? 'mid';
  };
  game.onSettingsChanged = () => game.applyQuality(pick());
  const benchmark = (async () => {
    if (!isTier(forced) && game.settings.quality === 'auto' && !benchmarked) {
      status = 'Calibrating graphics…';
      benchmarked = await runBenchmark(game);
    }
    game.applyQuality(pick());
    status = `Graphics: ${game.tier}`;
  })();

  if (params.has('autostart')) {
    await benchmark;
    window.__neon!.ready = true;
    return;
  }
  game.setPaused(true);
  await showTitle(overlay, () => status);
  await benchmark;
  enterFullscreen();
  game.setPaused(false);
  window.__neon!.ready = true;
}

/** On phones, go full screen and lock landscape where the browser allows it. */
function enterFullscreen(): void {
  if (!matchMedia('(pointer: coarse)').matches) return;
  const el = document.documentElement;
  el.requestFullscreen?.({ navigationUI: 'hide' })
    .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
    .catch(() => undefined);
}
