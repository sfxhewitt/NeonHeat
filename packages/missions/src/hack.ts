import type { Rng } from '@neonheat/sim';

/**
 * Sequence-tap hack: a sequence of nodes lights up, then the player taps them
 * back in order before the timer runs out. About ten seconds end to end.
 * Pure logic, driven by tick(dt) and tap(i), so the UI and the test bot share it.
 */
export type HackPhase = 'show' | 'input' | 'success' | 'fail';

export interface HackConfig {
  nodes: number;
  baseLength: number;
  showStepSec: number;
  inputSecBase: number;
  inputSecPerNode: number;
}

export const DEFAULT_HACK: HackConfig = { nodes: 6, baseLength: 3, showStepSec: 0.5, inputSecBase: 2.5, inputSecPerNode: 0.9 };

export class HackSession {
  readonly sequence: number[];
  phase: HackPhase = 'show';
  /** Seconds into the current phase. */
  t = 0;
  inputIndex = 0;
  readonly inputTime: number;
  readonly showTime: number;
  failReason = '';

  constructor(
    rng: Rng,
    readonly difficulty: number,
    readonly config: HackConfig = DEFAULT_HACK,
  ) {
    const len = config.baseLength + difficulty;
    this.sequence = [];
    let last = -1;
    for (let i = 0; i < len; i++) {
      let n = rng.int(0, config.nodes - 1);
      if (n === last) n = (n + 1) % config.nodes;
      this.sequence.push(n);
      last = n;
    }
    this.showTime = len * config.showStepSec + 0.4;
    this.inputTime = config.inputSecBase + len * config.inputSecPerNode;
  }

  /** Node lit during the show phase, or -1. */
  get litNode(): number {
    if (this.phase !== 'show') return -1;
    const step = Math.floor(this.t / this.config.showStepSec);
    const within = this.t - step * this.config.showStepSec;
    if (step >= this.sequence.length || within > this.config.showStepSec * 0.75) return -1;
    return this.sequence[step]!;
  }

  get timeLeft(): number {
    return this.phase === 'input' ? Math.max(0, this.inputTime - this.t) : this.inputTime;
  }

  get done(): boolean {
    return this.phase === 'success' || this.phase === 'fail';
  }

  tick(dt: number): void {
    if (this.done) return;
    this.t += dt;
    if (this.phase === 'show' && this.t >= this.showTime) {
      this.phase = 'input';
      this.t = 0;
    } else if (this.phase === 'input' && this.t >= this.inputTime) {
      this.phase = 'fail';
      this.failReason = 'Timed out';
    }
  }

  /** Returns true if the tap was correct. */
  tap(node: number): boolean {
    if (this.phase !== 'input') return false;
    if (this.sequence[this.inputIndex] !== node) {
      this.phase = 'fail';
      this.failReason = 'Wrong node';
      return false;
    }
    this.inputIndex++;
    if (this.inputIndex >= this.sequence.length) this.phase = 'success';
    return true;
  }
}
