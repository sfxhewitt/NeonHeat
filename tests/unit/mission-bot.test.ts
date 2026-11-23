import { describe, expect, it } from 'vitest';
import { rawContent, rawMissions } from '@neonheat/content';
import { MissionBot, MissionDirector, loadMissionContent } from '@neonheat/missions';
import { loadContent, makeWorld } from './helpers';

describe('headless mission bot', () => {
  it('completes Hot Chrome end to end from the street (traffic, peds and police running)', async () => {
    const world = await makeWorld(1, loadContent());
    const mc = loadMissionContent(rawContent, rawMissions);
    const director = new MissionDirector(world, mc.missions, mc.squads, mc.dialogue, { autoRetry: true });
    const bot = new MissionBot(world, director);
    const fails: string[] = [];
    director.onFail = (r) => fails.push(r);
    const objectivesSeen = new Set<string>();
    const maxSteps = 60 * 60 * 10;
    let step = 0;
    for (; step < maxSteps && director.completed.length === 0; step++) {
      world.step(bot.next(1 / 60));
      director.tick(1 / 60);
      if (director.runner?.state === 'running') objectivesSeen.add(director.runner.view.id);
    }
    const r = director.completed[0];
    console.info(
      `Hot Chrome: completed=${!!r} in ${(step / 60).toFixed(1)} s sim, mission time ${r?.seconds.toFixed(1)} s, attempts ${r?.attempts}, fails ${JSON.stringify(fails)}`,
    );
    expect(r).toBeDefined();
    expect([...objectivesSeen]).toEqual(['goto_lot', 'hack_car', 'deliver']);
    expect(director.host.dialogueLog).toContain('gh_03_intro');
  }, 180_000);
});
