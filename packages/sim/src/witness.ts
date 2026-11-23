import { CRIME_KINDS, type CrimeKind } from './heat';
import type { World } from './world';

/** A pedestrian on the phone to the police (pooled). */
export interface WitnessReport {
  active: boolean;
  pedId: number;
  /** Seconds until the call goes through. */
  timer: number;
  /** HEAT points still to add when it does. */
  points: number;
  kind: CrimeKind;
  x: number;
  z: number;
}

/**
 * Who saw it? A crime counts in full straight away when a police unit (car,
 * officer or drone) sees it. Otherwise only a small share counts, capped at
 * HEAT 1, and the nearest pedestrian with line of sight phones the rest in a
 * few seconds later, unless they are knocked down first.
 */
export class WitnessSystem {
  readonly reports: WitnessReport[] = [];
  private readonly lastCrime = new Float64Array(CRIME_KINDS.length).fill(-1e9);

  constructor(private readonly world: World) {
    const n = world.content.heat.witness.maxPending;
    for (let i = 0; i < n; i++) this.reports.push({ active: false, pedId: -1, timer: 0, points: 0, kind: 'gunfire', x: 0, z: 0 });
  }

  pendingCount(): number {
    let n = 0;
    for (const r of this.reports) if (r.active) n++;
    return n;
  }

  /** Report a crime committed at (x, z) (normally where the player stands). */
  crime(kind: CrimeKind, x: number, z: number): void {
    const w = this.world;
    const cfg = w.content.heat;
    const def = cfg.crimes[kind];
    w.score.crime(kind);
    const k = CRIME_KINDS.indexOf(kind);
    if (w.time - this.lastCrime[k]! < def.cooldownSec) return;
    this.lastCrime[k] = w.time;
    if (def.heat <= 0) return;
    if (w.police.policeSees(x, z)) {
      w.heat.addPoints(def.heat, x, z);
      w.events.push({ type: 'crimeReported', kind, x, z, by: 'police' });
      return;
    }
    const frac = cfg.witness.unwitnessedFraction;
    w.heat.addUnwitnessed(def.heat * frac, x, z);
    const ped = this.nearestWitness(x, z);
    if (ped < 0) return;
    const rest = def.heat * (1 - frac);
    for (const r of this.reports) {
      if (r.active && r.pedId === ped) {
        // Already on the phone: they add it to the call.
        r.points += rest;
        r.kind = kind;
        r.x = x;
        r.z = z;
        return;
      }
    }
    const r = this.reports.find((q) => !q.active);
    if (!r) return;
    r.active = true;
    r.pedId = ped;
    r.timer = cfg.witness.callDelaySec;
    r.points = rest;
    r.kind = kind;
    r.x = x;
    r.z = z;
  }

  private nearestWitness(x: number, z: number): number {
    const w = this.world;
    const radius = w.content.heat.witness.pedRadius;
    let best = -1;
    let bd = radius;
    for (const p of w.peds.peds) {
      if (!p.active || p.state === 'down') continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d >= bd) continue;
      if (!w.police.lineOfSight(p.x, p.z, x, z)) continue;
      bd = d;
      best = p.id;
    }
    return best;
  }

  step(dt: number): void {
    const w = this.world;
    for (const r of this.reports) {
      if (!r.active) continue;
      const p = w.peds.peds[r.pedId]!;
      if (!p.active || p.state === 'down' || !w.survival.alive) {
        r.active = false;
        continue;
      }
      r.timer -= dt;
      if (r.timer > 0) continue;
      r.active = false;
      w.heat.addPoints(r.points, r.x, r.z);
      w.events.push({ type: 'crimeReported', kind: r.kind, x: r.x, z: r.z, by: 'witness' });
    }
  }

  clear(): void {
    for (const r of this.reports) r.active = false;
  }
}
