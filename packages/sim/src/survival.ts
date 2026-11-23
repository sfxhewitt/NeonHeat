import { z } from 'zod';
import type { World } from './world';

const FateSchema = z.object({
  /** Share of banked credits lost. */
  creditFraction: z.number().min(0).max(1),
  respawnSec: z.number().nonnegative(),
  loseWeapons: z.boolean(),
  /** Respawn at the nearest map marker whose id starts with this (falling back to player_start). */
  marker: z.string(),
});

export const SurvivalConfigSchema = z.object({
  player: z.object({
    maxArmour: z.number().positive(),
    startArmour: z.number().nonnegative(),
    /** Share of incoming damage armour soaks up while it lasts. */
    armourAbsorb: z.number().min(0).max(1),
  }),
  /** Health ran out. */
  flatlined: FateSchema,
  /** Cuffed by the police. */
  booked: FateSchema,
  score: z.object({
    /** Crimes this close together chain into a multiplier. */
    chainWindowSec: z.number().positive(),
    multiplierStep: z.number().nonnegative(),
    maxMultiplier: z.number().min(1),
    /** Pending credits bank this long after HEAT reaches zero. */
    bankDelaySec: z.number().nonnegative(),
  }),
});
export type SurvivalConfig = z.infer<typeof SurvivalConfigSchema>;

export type Fate = 'alive' | 'flatlined' | 'booked';

/**
 * FLATLINED and BOOKED: the penalty (a share of credits and the weapons),
 * a short pause on the fate card, then a respawn at the nearest clinic or
 * precinct with HEAT cleared. Progress is kept.
 */
export class SurvivalSystem {
  fate: Fate = 'alive';
  /** Seconds until the respawn. */
  timer = 0;
  /** Credits lost on the last fate, for the card. */
  lastLoss = 0;

  constructor(
    private readonly world: World,
    public config: SurvivalConfig,
  ) {}

  get alive(): boolean {
    return this.fate === 'alive';
  }

  /** Called by the player controller when health reaches zero. */
  flatline(): void {
    if (this.fate !== 'alive') return;
    this.begin('flatlined');
  }

  /** The police cuffed the player. */
  book(): void {
    if (this.fate !== 'alive') return;
    const pc = this.world.playerCtl;
    if (pc.dead) return;
    if (pc.mode === 'driving') pc.exit();
    pc.busted = true;
    this.begin('booked');
  }

  private begin(fate: 'flatlined' | 'booked'): void {
    const w = this.world;
    const cfg = fate === 'flatlined' ? this.config.flatlined : this.config.booked;
    this.fate = fate;
    this.timer = cfg.respawnSec;
    const lost = w.score.penalise(cfg.creditFraction);
    this.lastLoss = lost;
    if (cfg.loseWeapons) w.combat.resetLoadout(w.content.weapons.respawnLoadout);
    w.events.push({ type: fate === 'flatlined' ? 'playerWasted' : 'playerBusted', x: w.player.x, z: w.player.z, creditsLost: lost });
  }

  step(dt: number): void {
    if (this.fate === 'alive') return;
    this.timer -= dt;
    if (this.timer <= 0) this.respawn();
  }

  /** Respawn now (also used by mission checkpoints). */
  respawn(): void {
    const fate = this.fate;
    this.fate = 'alive';
    this.timer = 0;
    const prefix = fate === 'booked' ? this.config.booked.marker : this.config.flatlined.marker;
    this.world.playerCtl.respawnAt(prefix);
  }

  /** Nearest marker whose id starts with `prefix`, else player_start, else the origin. */
  nearestMarker(prefix: string, x: number, z: number): { x: number; z: number } {
    const markers = this.world.content.map.markers;
    let best: [number, number, number] | null = null;
    let bd = Infinity;
    for (const [id, m] of Object.entries(markers)) {
      if (!id.startsWith(prefix)) continue;
      const d = Math.hypot(m.pos[0] - x, m.pos[2] - z);
      if (d < bd) {
        bd = d;
        best = m.pos;
      }
    }
    best ??= markers['player_start']?.pos ?? [0, 0, 0];
    return { x: best[0], z: best[2] };
  }
}
