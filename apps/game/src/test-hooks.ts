import type { Intents } from '@neonheat/sim';
import type { Game } from './game';

export interface NeonTestHooks {
  game: Game;
  ready: boolean;
  setIntents: (i: Partial<Intents> | null) => void;
  stats: () => Game['stats'] & { avgFrameMs: number };
}

declare global {
  interface Window {
    __neon?: NeonTestHooks;
  }
}

/** Hooks used by Playwright to drive the game with injected intents and read stats. */
export function installTestHooks(game: Game): void {
  window.__neon = {
    game,
    ready: false,
    setIntents: (i) => {
      game.input.override = i
        ? { moveX: 0, moveY: 0, steer: 0, throttle: 0, brake: 0, scheme: 'classic', handbrake: false, fire: false, interact: false, dodge: false, ...i }
        : null;
    },
    stats: () => {
      const ft = game.frameTimes;
      const avg = ft.length ? ft.reduce((a, b) => a + b, 0) / ft.length : 0;
      return { ...game.stats, avgFrameMs: avg };
    },
  };
}
