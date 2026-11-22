import { Rng } from './rng';
import { SIM_DT } from './loop';
import type { Intents } from './intents';

export interface WorldOptions {
  seed: number;
}

/**
 * The deterministic simulation world. Pure TypeScript: no Three.js, no DOM.
 * Rendering reads its state; it never owns it.
 */
export class World {
  readonly rng: Rng;
  readonly seed: number;
  tick = 0;
  time = 0;
  /** Demo probe used by the M1 skeleton to prove interpolation. */
  readonly probe = { x: 0, z: 0, prevX: 0, prevZ: 0 };

  constructor(options: WorldOptions) {
    this.seed = options.seed;
    this.rng = new Rng(options.seed);
  }

  step(intents: Intents): void {
    const p = this.probe;
    p.prevX = p.x;
    p.prevZ = p.z;
    p.x += intents.moveX * 10 * SIM_DT;
    p.z -= intents.moveY * 10 * SIM_DT;
    this.tick++;
    this.time = this.tick * SIM_DT;
  }
}
