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
  /** Make a job available by marking its prerequisite chain done (progress only, not the save), and point the bot at it. */
  unlockJob: (id: string) => { x: number; z: number } | null;
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
        ? { moveX: 0, moveY: 0, steer: 0, throttle: 0, brake: 0, scheme: 'classic', handbrake: false, fire: false, interact: false, dodge: false, nextWeapon: false, activity: false, ...i }
        : null;
    },
    fastForward: (seconds) => game.fastForward(seconds),
    unlockJob: (id) => {
      const d = game.director;
      const done = new Set<string>();
      const respect: Record<string, number> = {};
      const visit = (mid: string): void => {
        const m = d.missions.find((x) => x.id === mid);
        if (!m) return;
        for (const p of m.prerequisites?.missions ?? []) {
          if (done.has(p)) continue;
          done.add(p);
          visit(p);
        }
        for (const [crew, v] of Object.entries(m.prerequisites?.respect ?? {})) respect[crew] = Math.max(respect[crew] ?? 0, v);
      };
      visit(id);
      d.setProgress({ completed: [...done], respect });
      if (game.bot) game.bot.missionId = id;
      const g = d.givers.find((x) => x.missionId === id);
      return g ? { x: g.x, z: g.z } : null;
    },
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
