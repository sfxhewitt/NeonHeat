import type { CrimeKind } from './heat';
import type { World } from './world';

/**
 * Street score: crimes earn credits, chained into a multiplier when they come
 * close together. Earnings stay pending while the police are on you and bank
 * once HEAT has been zero for a moment. Getting flatlined or booked loses
 * whatever is pending, plus a share of the bank.
 */
export class ScoreSystem {
  /** Banked credits (the app keeps the save in step with this). */
  credits = 0;
  /** Earned but not yet banked. */
  pending = 0;
  multiplier = 1;
  /** Seconds left to chain the next crime. */
  chainTimer = 0;
  private coolTimer = 0;

  constructor(private readonly world: World) {}

  private get cfg() {
    return this.world.content.survival.score;
  }

  crime(kind: CrimeKind): void {
    const base = this.world.content.heat.crimes[kind].credits;
    if (base <= 0) return;
    const c = this.cfg;
    if (this.chainTimer > 0) this.multiplier = Math.min(c.maxMultiplier, this.multiplier + c.multiplierStep);
    this.chainTimer = c.chainWindowSec;
    this.pending += Math.round(base * this.multiplier);
  }

  /** Lose all pending credits and `fraction` of the bank. Returns the banked credits lost. */
  penalise(fraction: number): number {
    const lost = Math.floor(this.credits * fraction);
    this.credits -= lost;
    this.pending = 0;
    this.multiplier = 1;
    this.chainTimer = 0;
    return lost;
  }

  /** Bank pending credits now (e.g. a respray). */
  bank(): void {
    if (this.pending <= 0) return;
    const amount = this.pending;
    this.credits += amount;
    this.pending = 0;
    this.world.events.push({ type: 'scoreBanked', amount });
  }

  step(dt: number): void {
    if (this.chainTimer > 0) {
      this.chainTimer -= dt;
      if (this.chainTimer <= 0) {
        this.chainTimer = 0;
        this.multiplier = 1;
      }
    }
    if (this.pending > 0 && this.world.heat.level === 0 && this.world.survival.alive) {
      this.coolTimer += dt;
      if (this.coolTimer >= this.cfg.bankDelaySec && this.chainTimer <= 0) this.bank();
    } else this.coolTimer = 0;
  }
}
