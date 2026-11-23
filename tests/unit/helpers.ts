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

/**
 * Known open stretches of Vey City for tests: a long straight east-west avenue
 * (z = -330, x from -380 to 400, with T-junctions only) and a north-south
 * avenue (x = 0, z from -770 to 60).
 */
export const EW = { x: -300, z: -330 } as const;
export const NS = { x: 0, z: -150 } as const;

/** Move the on-foot player somewhere and let the world catch up (streaming, sight). */
export function movePlayer(w: World, x: number, z: number): void {
  w.playerCtl.teleport(x, z);
  w.step(intents());
}

/** A building with a straight run of road due south of its south face: [building, road point 10 m south]. */
export function buildingWithRoadSouth(w: World): { b: { x: number; z: number; w: number; d: number; h: number }; x: number; z: number } {
  for (const b of w.content.map.buildings) {
    const x = b.x;
    const z = b.z + b.d / 2 + 10;
    if (b.w < 10 || !w.roads.onRoad(x, z)) continue;
    // The road must be clear for a run-up: road cells for 8 m south of the start.
    let ok = true;
    for (let k = 0; k <= 8; k += 2) if (!w.roads.onRoad(x, z + k)) ok = false;
    if (ok) return { b, x, z: z + 4 };
  }
  throw new Error('no building faces a road');
}
