import { Anim, Look, type SimEvent, type World } from '@neonheat/sim';
import type { Particles } from '@neonheat/engine';

/** Seconds between emissions (visual only; keeps particle counts steady whatever the frame rate). */
const TICK = 0.05;

/**
 * Living-city effects that sit outside the people and vehicle views: flames on
 * burning wrecks that die down as the fire is fought, the hose jet from each
 * firefighter on the job, and a burst of steam when a fire goes out.
 */
export class LifeLayer {
  private timer = 0;

  constructor(private readonly particles: Particles) {}

  onEvent(e: SimEvent): void {
    if (e.type === 'fireOut') this.particles.steam(e.x, e.z);
  }

  update(w: World, dt: number): void {
    this.timer -= dt;
    // Catch up on slow frames (a few emissions at most) so effects keep their density.
    for (let k = 0; k < 4 && this.timer <= 0; k++) {
      this.timer += TICK;
      this.emit(w);
    }
    if (this.timer < 0) this.timer = 0;
  }

  private emit(w: World): void {
    const s = w.services;
    for (const v of w.vehicles) {
      if (!v.active || !v.destroyed) continue;
      const b = s.burnOf(v.id);
      if (b > 0.01) this.particles.flame(v.x, v.z, b);
    }
    const tags = w.peds.tags;
    for (const p of w.peds.peds) {
      if (!p.active || p.state !== 'wander' || tags.look[p.id] !== Look.firefighter || tags.anim[p.id] !== Anim.hose) continue;
      // From the nozzle, a little ahead of the firefighter, to the fire.
      const fx = Math.sin(p.facing);
      const fz = Math.cos(p.facing);
      this.particles.spray(p.x + fx * 0.9, p.z + fz * 0.9, tags.lookX[p.id]!, tags.lookZ[p.id]!);
    }
  }
}
