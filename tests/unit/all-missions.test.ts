import { describe, expect, it } from 'vitest';
import { rawContent, rawMissions } from '@neonheat/content';
import { MissionBot, MissionDirector, loadMissionContent, type MissionProgress } from '@neonheat/missions';
import { loadContent, makeWorld, movePlayer } from './helpers';

/**
 * Opt-in soak: the bot plays every mission in the game, start to finish.
 * Slow (minutes), so it runs only with ALL_MISSIONS=1, or a comma list of ids.
 */
const mc = loadMissionContent(rawContent, rawMissions);
const only = process.env.ALL_MISSIONS;
const ids = !only ? [] : only === '1' ? mc.missions.map((m) => m.id) : only.split(',');

function progressFor(id: string): MissionProgress {
  const done = new Set<string>();
  const respect: Record<string, number> = {};
  const visit = (mid: string): void => {
    const m = mc.missions.find((x) => x.id === mid);
    if (!m) return;
    for (const p of m.prerequisites?.missions ?? []) {
      if (!done.has(p)) {
        done.add(p);
        visit(p);
      }
    }
    for (const [crew, v] of Object.entries(m.prerequisites?.respect ?? {})) respect[crew] = Math.max(respect[crew] ?? 0, v);
  };
  visit(id);
  return { completed: [...done], respect };
}

describe.skipIf(ids.length === 0)('every mission is completable by the bot', () => {
  for (const id of ids) {
    it(id, { timeout: 600_000 }, async () => {
      const world = await makeWorld(1, loadContent());
      const director = new MissionDirector(world, mc.missions, mc.squads, mc.dialogue, { autoRetry: true, crews: mc.crews });
      world.actors.configure(mc.actors);
      director.setProgress(progressFor(id));
      expect(director.available().map((m) => m.id)).toContain(id);
      const bot = new MissionBot(world, director);
      bot.missionId = id;
      const g = director.giverPos(mc.missions.find((m) => m.id === id)!)!;
      movePlayer(world, g.x + 2, g.z + 2);
      const fails: string[] = [];
      director.onFail = (r) => fails.push(`${director.runner?.view.id ?? '?'}: ${r}`);
      const seen: string[] = [];
      let step = 0;
      for (; step < 600 * 60 && director.completed.length === 0; step++) {
        world.step(bot.next(1 / 60));
        director.tick(1 / 60);
        const o = director.runner?.state === 'running' ? director.runner.view.id : null;
        if (o && seen[seen.length - 1] !== o) seen.push(o);
      }
      const r = director.completed[0];
      console.info(`RESULT ${id} ok=${!!r} sim=${(step / 60).toFixed(0)}s mission=${r?.seconds.toFixed(0)}s attempts=${r?.attempts} obj=${seen.join('>')} fails=${JSON.stringify(fails.slice(0, 6))}`);
      world.dispose();
      expect(r).toBeDefined();
    });
  }
});
