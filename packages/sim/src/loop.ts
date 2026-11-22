/**
 * Fixed-timestep accumulator. Feed it real elapsed time; it tells you how many
 * fixed steps to run and the interpolation factor for rendering between the
 * previous and current simulation states.
 */
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

export interface FixedStepOptions {
  dt?: number;
  /** Upper bound on steps per advance, to avoid the spiral of death. */
  maxSteps?: number;
}

export class FixedStepLoop {
  readonly dt: number;
  readonly maxSteps: number;
  private accumulator = 0;
  /** Steps dropped because a frame took too long. */
  droppedTime = 0;

  constructor(options: FixedStepOptions = {}) {
    this.dt = options.dt ?? SIM_DT;
    this.maxSteps = options.maxSteps ?? 5;
  }

  /**
   * Advance by `elapsed` seconds of real time, calling `step` once per fixed
   * step. Returns the interpolation alpha in [0, 1).
   */
  advance(elapsed: number, step: (dt: number) => void): number {
    this.accumulator += Math.max(0, elapsed);
    let steps = 0;
    while (this.accumulator >= this.dt) {
      if (steps >= this.maxSteps) {
        this.droppedTime += this.accumulator;
        this.accumulator = 0;
        break;
      }
      step(this.dt);
      this.accumulator -= this.dt;
      steps++;
    }
    return this.accumulator / this.dt;
  }

  reset(): void {
    this.accumulator = 0;
  }
}

/** Linear interpolation helper for render interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate between two angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
