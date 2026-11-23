import { describe, expect, it } from 'vitest';
import { rawContent, rawMissions } from '@neonheat/content';
import { MissionBot, MissionDirector, loadMissionContent, type MissionProgress, type MissionResult } from '@neonheat/missions';
import { loadContent, makeWorld, movePlayer } from './helpers';

const mc = loadMissionContent(rawContent, rawMissions);

interface Played {
  result: MissionResult | undefined;
  objectives: string[];
  fails: string[];
  simSeconds: number;
}

/**
 * Plays one mission headlessly with the bot, through the intent layer, in the
 * generated city with traffic, peds and police running. The player starts next
 * to the mission's payphone with the given progress. The director retries
 * failures from the checkpoint on its own, as a player would.
 */
async function play(id: string, progress: MissionProgress, maxSimSeconds = 420, seed = 1): Promise<Played> {
  const world = await makeWorld(seed, loadContent());
  const director = new MissionDirector(world, mc.missions, mc.squads, mc.dialogue, { autoRetry: true, crews: mc.crews });
  world.actors.configure(mc.actors);
  director.setProgress(progress);
  expect(director.available().map((m) => m.id)).toContain(id);
  const bot = new MissionBot(world, director);
  bot.missionId = id;
  const g = director.giverPos(mc.missions.find((m) => m.id === id)!)!;
  movePlayer(world, g.x + 2, g.z + 2);
  const fails: string[] = [];
  director.onFail = (r) => fails.push(r);
  const seen: string[] = [];
  let step = 0;
  for (; step < maxSimSeconds * 60 && director.completed.length === 0; step++) {
    world.step(bot.next(1 / 60));
    director.tick(1 / 60);
    const o = director.runner?.state === 'running' ? director.runner.view.id : null;
    if (o && seen[seen.length - 1] !== o) seen.push(o);
  }
  const result = director.completed[0];
  console.info(
    `${id}: completed=${!!result} in ${(step / 60).toFixed(1)} s sim, mission time ${result?.seconds.toFixed(1)} s, attempts ${result?.attempts}, objectives ${seen.join(' > ')}, fails ${JSON.stringify(fails)}`,
  );
  world.dispose();
  return { result, objectives: seen, fails, simSeconds: step / 60 };
}

const afterTutorial: MissionProgress = { completed: ['story_01_first_call'], respect: { glasshounds: 5 } };

describe('headless mission bot (regression: missions stay completable)', () => {
  it('Hot Chrome: reach, hack, deliver', { timeout: 240_000 }, async () => {
    const p = await play('glasshounds_03_hot_chrome', {
      completed: ['story_01_first_call', 'glasshounds_01_window_shopping', 'glasshounds_02_test_drive'],
      respect: { glasshounds: 16 },
    });
    expect(p.result).toBeDefined();
    expect(p.objectives.filter((o, i, a) => a.indexOf(o) === i)).toEqual(['goto_lot', 'hack_car', 'deliver']);
  });

  it('Scrap Value: steal, collect in a vehicle, deliver', { timeout: 240_000 }, async () => {
    const p = await play('rustmouth_01_scrap_value', afterTutorial);
    expect(p.result).toBeDefined();
    expect(p.objectives).toContain('salvage');
  });

  it('Handshake: collect on foot, hack a terminal', { timeout: 240_000 }, async () => {
    const p = await play('nullsaints_01_handshake', afterTutorial);
    expect(p.result).toBeDefined();
  });

  it('Test Drive: steal, race against an opponent', { timeout: 240_000 }, async () => {
    const p = await play('glasshounds_02_test_drive', { completed: ['story_01_first_call', 'glasshounds_01_window_shopping'], respect: { glasshounds: 11 } });
    expect(p.result).toBeDefined();
  });

  it('First Call (tutorial): steal, drive, walk, dodge, fight, escape HEAT, reach', { timeout: 240_000 }, async () => {
    const p = await play('story_01_first_call', { completed: [], respect: {} });
    expect(p.result).toBeDefined();
    expect(p.objectives).toContain('lose_heat');
  });
});
