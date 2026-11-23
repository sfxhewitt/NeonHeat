/**
 * Pure mixing maths: no Web Audio, no DOM, so it runs (and is tested) in Node.
 */
import type { AudioConfig, EngineClass } from './config';

/** Small seeded PRNG (mulberry32). Audio is presentation, so it keeps its own stream away from the sim's. */
export class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export type ListenerConfig = AudioConfig['listener'];

/**
 * Distance gain: inverse-distance roll-off past `refDistance`, faded smoothly to silence over the
 * last fifth of `maxDistance`. Never increases with distance.
 */
export function distanceGain(d: number, l: ListenerConfig): number {
  if (d >= l.maxDistance) return 0;
  const dd = Math.max(d, l.refDistance);
  const inv = l.refDistance / (l.refDistance + l.rolloff * (dd - l.refDistance));
  const edge = l.maxDistance * 0.2;
  const fade = clamp((l.maxDistance - d) / edge, 0, 1);
  return inv * fade * fade * (3 - 2 * fade);
}

/** Stereo position from the horizontal offset on screen (top-down camera, north up). */
export function panFor(dx: number, l: ListenerConfig): number {
  return clamp(dx / l.panWidth, -l.maxPan, l.maxPan);
}

/**
 * Doppler pitch factor for a source at (dx, dz) from the listener moving with relative velocity
 * (rvx, rvz) = source velocity - listener velocity. Approaching > 1, receding < 1.
 */
export function dopplerFactor(dx: number, dz: number, rvx: number, rvz: number, l: ListenerConfig): number {
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) return 1;
  // Radial speed: positive when moving away.
  const vr = ((rvx * dx + rvz * dz) / d) * l.dopplerScale;
  const c = l.speedOfSound;
  return clamp(c / (c + clamp(vr, -c * 0.5, c * 0.5)), 0.5, 2);
}

export interface GearState {
  /** 1-based gear. */
  gear: number;
  /** Normalised rpm, 0 at idle and 1 at the redline. */
  rpm: number;
}

/**
 * Which gear a car is in at this speed, and how far up the rev range. Gear bands are spaced so low
 * gears are short; each upshift drops the revs to `shiftDropRpm`. Pure and allocation-free (writes `out`).
 */
export function gearFor(speed: number, topSpeed: number, cls: Pick<EngineClass, 'gears' | 'shiftDropRpm'>, out: GearState): GearState {
  const s = clamp(Math.abs(speed) / Math.max(topSpeed, 1), 0, 1.2);
  const n = cls.gears;
  // Band edges as fractions of top speed: (i/n)^0.75 makes low gears short.
  let lo = 0;
  for (let g = 1; g <= n; g++) {
    const hi = Math.pow(g / n, 0.75);
    if (s <= hi || g === n) {
      const t = clamp((s - lo) / Math.max(hi - lo, 1e-6), 0, 1.15);
      const base = g === 1 ? 0 : cls.shiftDropRpm;
      out.gear = g;
      out.rpm = clamp(base + (1 - base) * t, 0, 1.08);
      return out;
    }
    lo = hi;
  }
  out.gear = n;
  out.rpm = 1;
  return out;
}

/** Engine crank frequency (Hz) for a normalised rpm. Strictly increasing in rpm. */
export function engineHz(cls: Pick<EngineClass, 'idleHz' | 'redlineHz'>, rpm: number): number {
  const r = clamp(rpm, 0, 1.2);
  // Slight curve: revs climb faster at the top, like a real tacho needle.
  return cls.idleHz + (cls.redlineHz - cls.idleHz) * (0.575 * r + 0.425 * r * r);
}

/** Target rpm including load: throttle at low speed flares the revs (launch, wheelspin, burnouts). */
export function targetRpm(gear: GearState, throttle: number, speed: number, topSpeed: number): number {
  const slow = 1 - clamp(Math.abs(speed) / (topSpeed * 0.18), 0, 1);
  const flare = throttle * slow * 0.55;
  return clamp(Math.max(gear.rpm, flare) + throttle * 0.05, 0, 1.08);
}

/** Lateral slip of a car (m/s): the sideways part of its velocity. */
export function lateralSlip(vx: number, vz: number, yaw: number): number {
  return Math.abs(vx * Math.cos(yaw) - vz * Math.sin(yaw));
}

export interface VoiceCandidate {
  id: number;
  /** Distance to the listener (m). */
  dist: number;
  /** Always keep a voice (the player's car). */
  pinned: boolean;
}

/**
 * Give at most `cap` voices to the nearest candidates. A playing source keeps its voice unless a
 * new one is closer by more than `hysteresis` metres, so voices do not flicker between two cars.
 * `slots` holds the id playing on each voice (-1 = free) and is updated in place; returns the number
 * of assigned voices. Candidates beyond `maxDist` never get a voice.
 */
export function allocateVoices(candidates: readonly VoiceCandidate[], slots: number[], cap: number, hysteresis: number, maxDist: number): number {
  const n = Math.min(cap, slots.length);
  // Rank: pinned first, then by distance with a bonus for already playing.
  const playing = new Set<number>();
  for (let i = 0; i < n; i++) if (slots[i]! >= 0) playing.add(slots[i]!);
  const ranked = candidates
    .filter((c) => c.pinned || c.dist < maxDist)
    .map((c) => ({ c, score: c.pinned ? -1e9 : c.dist - (playing.has(c.id) ? hysteresis : 0) }))
    .sort((a, b) => a.score - b.score || a.c.id - b.c.id);
  const keep = new Set<number>();
  for (let i = 0; i < ranked.length && keep.size < n; i++) keep.add(ranked[i]!.c.id);
  // Free voices whose source lost its place; keep the others where they are (no re-trigger).
  for (let i = 0; i < slots.length; i++) {
    if (i >= n || !keep.has(slots[i]!)) slots[i] = -1;
    else keep.delete(slots[i]!);
  }
  // Newcomers take free voices.
  for (const id of keep) {
    const free = slots.indexOf(-1);
    if (free < 0 || free >= n) break;
    slots[free] = id;
  }
  let used = 0;
  for (let i = 0; i < n; i++) if (slots[i]! >= 0) used++;
  return used;
}

/** Map an impact strength to a 0..1 level. */
export function impactLevel(strength: number, min: number, full: number): number {
  if (strength <= min) return 0;
  return clamp((strength - min) / Math.max(full - min, 1e-6), 0, 1);
}

/** Siren frequency for a mode at phase t (seconds since the siren started). Wail sweeps slowly, yelp fast. */
export function sirenHz(mode: 'wail' | 'yelp', t: number, cfg: Pick<AudioConfig['police'], 'wailLowHz' | 'wailHighHz' | 'wailPeriod' | 'yelpPeriod'>): number {
  const period = mode === 'wail' ? cfg.wailPeriod : cfg.yelpPeriod;
  const ph = (((t / period) % 1) + 1) % 1;
  // Wail: slow rise, slightly faster fall. Yelp: fast rising sweep that snaps back.
  const shape = mode === 'wail' ? (ph < 0.55 ? Math.sin((ph / 0.55) * Math.PI * 0.5) : Math.cos(((ph - 0.55) / 0.45) * Math.PI * 0.5)) : Math.sqrt(ph);
  return cfg.wailLowHz + (cfg.wailHighHz - cfg.wailLowHz) * shape;
}

/** MIDI note to frequency (A4 = 440 Hz). */
export function midiHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}
