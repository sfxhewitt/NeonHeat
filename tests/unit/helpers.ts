import { rawContent } from '@neonheat/content';
import { World, emptyIntents, initPhysics, parseSimContent, type Intents, type SimContent } from '@neonheat/sim';

export function loadContent(): SimContent {
  return parseSimContent(structuredClone(rawContent) as never);
}

export async function makeWorld(seed = 1, content: SimContent = loadContent()): Promise<World> {
  const rapier = await initPhysics();
  return new World({ seed, content, rapier });
}

export function intents(patch: Partial<Intents> = {}): Intents {
  return { ...emptyIntents(), ...patch };
}

export function run(world: World, seconds: number, input: Intents | ((t: number) => Intents)): void {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) world.step(typeof input === 'function' ? input(world.time) : input);
}
