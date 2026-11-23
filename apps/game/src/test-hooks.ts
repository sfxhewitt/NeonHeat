import type { Intents } from '@neonheat/sim';
import type { Game } from './game';

export interface NeonTestHooks {
  game: Game;
  ready: boolean;
  setIntents: (i: Partial<Intents> | null) => void;
  stats: () => Game['stats'] & { avgFrameMs: number };
  /** Step the sim synchronously (no rendering). */
  fastForward: (seconds: number) => void;
  mission: () => { state: string; objective: string; completed: number; hackOpen: boolean; trace: number; credits: number };
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
        ? { moveX: 0, moveY: 0, steer: 0, throttle: 0, brake: 0, scheme: 'classic', handbrake: false, fire: false, interact: false, dodge: false, nextWeapon: false, ...i }
        : null;
    },
    fastForward: (seconds) => game.fastForward(seconds),
    mission: () => {
      const d = game.director;
      return {
        state: d.runner?.state ?? 'idle',
        objective: d.runner?.view.id ?? '',
        completed: d.completed.length,
        hackOpen: d.hack !== null,
        trace: game.world.trace,
        credits: game.saves.current.credits,
      };
    },
    stats: () => {
      const ft = game.frameTimes;
      const avg = ft.length ? ft.reduce((a, b) => a + b, 0) / ft.length : 0;
      return { ...game.stats, avgFrameMs: avg };
    },
  };
}
