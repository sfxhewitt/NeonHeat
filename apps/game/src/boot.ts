import '@neonheat/ui/ui.css';
import { Game } from './game';
import { installTestHooks } from './test-hooks';

export async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay') as HTMLElement;
  const game = new Game(canvas, overlay);
  const seed = Number(new URLSearchParams(location.search).get('seed') ?? '1');
  await game.init(seed);
  installTestHooks(game);
  game.start();
}
