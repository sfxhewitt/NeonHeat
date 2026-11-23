/**
 * Offline DSP: pure functions that render sounds into Float32Arrays. No Web Audio, so every recipe
 * is testable in Node. The browser side copies these into AudioBuffers once, at runtime, and plays
 * them with one buffer source per hit (cheap on phones, and nothing is shipped as audio files).
 */
import type { Rand } from './mix';

const TAU = Math.PI * 2;

/** RBJ cookbook biquad, transposed direct form II. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(
    private readonly sr: number,
    type: 'lowpass' | 'highpass' | 'bandpass' = 'lowpass',
    freq = 1000,
    q = 0.707,
  ) {
    this.set(type, freq, q);
  }

  set(type: 'lowpass' | 'highpass' | 'bandpass', freq: number, q: number): this {
    const f = Math.min(Math.max(freq, 10), this.sr * 0.45);
    const w = (TAU * f) / this.sr;
    const cs = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(q, 0.05));
    const a0 = 1 + alpha;
    let b0: number;
    let b1: number;
    let b2: number;
    if (type === 'lowpass') {
      b0 = (1 - cs) / 2;
      b1 = 1 - cs;
      b2 = b0;
    } else if (type === 'highpass') {
      b0 = (1 + cs) / 2;
      b1 = -(1 + cs);
      b2 = b0;
    } else {
      // Constant 0 dB peak gain band-pass.
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cs) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** One-pole low-pass, for smoothing and darkening. */
export class OnePole {
  private y = 0;
  private a = 0;
  constructor(
    private readonly sr: number,
    freq: number,
  ) {
    this.setFreq(freq);
  }
  setFreq(freq: number): void {
    this.a = Math.exp((-TAU * freq) / this.sr);
  }
  process(x: number): number {
    this.y = x + this.a * (this.y - x);
    return this.y;
  }
}

/** A bank of high-Q band-pass resonators: struck metal, glass, wood and plastic. */
class Modes {
  private readonly filters: Biquad[];
  constructor(
    sr: number,
    freqs: readonly number[],
    q: number | readonly number[],
    private readonly gains: readonly number[],
  ) {
    this.filters = freqs.map((f, i) => new Biquad(sr, 'bandpass', f, typeof q === 'number' ? q : (q[i] ?? 10)));
  }
  process(x: number): number {
    let y = 0;
    for (let i = 0; i < this.filters.length; i++) y += this.filters[i]!.process(x) * (this.gains[i] ?? 1);
    return y;
  }
}

function len(sr: number, seconds: number): Float32Array {
  return new Float32Array(Math.max(1, Math.ceil(sr * seconds)));
}

/** Scale so the peak sits at `peak`. Silent buffers stay silent. */
export function normalise(buf: Float32Array, peak = 0.95): Float32Array {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]!));
  if (m < 1e-9) return buf;
  const k = peak / m;
  for (let i = 0; i < buf.length; i++) buf[i]! *= k;
  return buf;
}

/** Short fades at both ends so nothing clicks. */
function fadeEdges(buf: Float32Array, sr: number, inSec = 0.001, outSec = 0.01): Float32Array {
  const a = Math.min(buf.length, Math.ceil(inSec * sr));
  const b = Math.min(buf.length, Math.ceil(outSec * sr));
  for (let i = 0; i < a; i++) buf[i]! *= i / a;
  for (let i = 0; i < b; i++) buf[buf.length - 1 - i]! *= i / b;
  return buf;
}

/** Make a loop seamless by cross-fading its tail into its head. Returns a shorter buffer. */
function loopable(buf: Float32Array, sr: number, xfadeSec: number): Float32Array {
  const x = Math.min(Math.floor(xfadeSec * sr), Math.floor(buf.length / 3));
  const out = new Float32Array(buf.length - x);
  out.set(buf.subarray(0, out.length));
  for (let i = 0; i < x; i++) {
    const t = i / x;
    // Equal-power cross-fade of the tail over the head.
    out[i] = buf[i]! * Math.sin(t * Math.PI * 0.5) + buf[out.length + i]! * Math.cos(t * Math.PI * 0.5);
  }
  return out;
}

/** Add delayed, darkened copies: street slap-back from buildings. */
function addEchoes(buf: Float32Array, sr: number, taps: readonly [number, number][], cutoff = 2500): Float32Array {
  const src = buf.slice();
  for (const [delay, gain] of taps) {
    const d = Math.floor(delay * sr);
    const lp = new OnePole(sr, cutoff);
    for (let i = 0; i + d < buf.length; i++) buf[i + d]! += lp.process(src[i]!) * gain;
  }
  return buf;
}

function tanhSat(x: number, drive: number): number {
  return Math.tanh(x * drive) / Math.tanh(drive);
}

/** Bit and rate reduction for the lo-fi kit. */
function crush(buf: Float32Array, amount: number): Float32Array {
  if (amount <= 0) return buf;
  const hold = 1 + Math.round(amount * 5);
  const levels = Math.pow(2, 16 - amount * 10);
  let held = 0;
  for (let i = 0; i < buf.length; i++) {
    if (i % hold === 0) held = Math.round(buf[i]! * levels) / levels;
    buf[i] = held;
  }
  return buf;
}

/** Sum of exponentially decaying grains at random onsets: the envelope of a crunch or crackle. */
function grainEnvelope(n: number, sr: number, r: Rand, count: number, spread: number, decayMin: number, decayMax: number, start = 0): Float32Array {
  const env = new Float32Array(n);
  for (let g = 0; g < count; g++) {
    const at = Math.floor((start + Math.pow(r.next(), 1.6) * spread) * sr);
    const dec = r.range(decayMin, decayMax) * sr;
    const amp = r.range(0.3, 1) * (g === 0 ? 1.4 : 1);
    const end = Math.min(n, at + Math.ceil(dec * 6));
    for (let i = at; i < end; i++) env[i]! += amp * Math.exp(-(i - at) / dec);
  }
  return env;
}

// ---------------------------------------------------------------- drums

export interface KitParams {
  kickStartHz: number;
  kickEndHz: number;
  kickPitchDecay: number;
  kickDecay: number;
  kickDrive: number;
  kickClick: number;
  snareToneHz: number;
  snareDecay: number;
  snareNoiseHz: number;
  snareSnap: number;
  hatDecay: number;
  openHatDecay: number;
  hatHz: number;
  clapDecay: number;
  percHz: number;
  crush: number;
}

export function renderKick(sr: number, k: KitParams, r: Rand): Float32Array {
  const out = len(sr, Math.min(1.2, k.kickDecay * 5 + 0.02));
  const hp = new Biquad(sr, 'highpass', 1200, 0.7);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = k.kickEndHz + (k.kickStartHz - k.kickEndHz) * Math.exp(-t / k.kickPitchDecay);
    ph += (TAU * f) / sr;
    const amp = Math.exp(-t / k.kickDecay) * Math.min(1, t / 0.0015);
    const click = hp.process(r.next() * 2 - 1) * Math.exp(-t / 0.0018) * k.kickClick;
    out[i] = tanhSat(Math.sin(ph) * amp, 1 + k.kickDrive) + click;
  }
  return crush(normalise(fadeEdges(out, sr, 0.0005, 0.02)), k.crush);
}

export function renderSnare(sr: number, k: KitParams, r: Rand): Float32Array {
  const out = len(sr, k.snareDecay * 5 + 0.05);
  const hp = new Biquad(sr, 'highpass', k.snareNoiseHz, 0.8);
  const bp = new Biquad(sr, 'bandpass', 3800, 1.2);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = k.snareToneHz * (1 + 0.35 * Math.exp(-t / 0.01));
    p1 += (TAU * f) / sr;
    p2 += (TAU * f * 1.62) / sr;
    const tone = (Math.sin(p1) * 0.65 * Math.exp(-t / 0.055) + Math.sin(p2) * 0.3 * Math.exp(-t / 0.035)) * Math.min(1, t / 0.001);
    const w = r.next() * 2 - 1;
    const noise = hp.process(w) * Math.exp(-t / k.snareDecay) * 0.9;
    const snap = bp.process(w) * Math.exp(-t / 0.007) * k.snareSnap * 1.5;
    out[i] = tanhSat(tone + noise + snap, 1.4);
  }
  return crush(normalise(fadeEdges(out, sr)), k.crush);
}

const HAT_RATIOS = [1, 1.4471, 1.617, 1.9265, 2.5028, 2.6637];

export function renderHat(sr: number, decay: number, hz: number, crushAmt: number, r: Rand): Float32Array {
  const out = len(sr, decay * 6 + 0.01);
  const bp = new Biquad(sr, 'bandpass', hz, 0.9);
  const hp = new Biquad(sr, 'highpass', hz * 0.75, 0.7);
  const base = 205 * r.range(0.97, 1.03);
  const phases = HAT_RATIOS.map(() => r.next());
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let m = 0;
    for (let k = 0; k < HAT_RATIOS.length; k++) m += ((phases[k]! + (base * HAT_RATIOS[k]! * 2.1 * t)) % 1) < 0.5 ? 1 : -1;
    const x = m / 6 + (r.next() * 2 - 1) * 0.35;
    out[i] = hp.process(bp.process(x)) * Math.exp(-t / decay) * Math.min(1, t / 0.0005);
  }
  return crush(normalise(fadeEdges(out, sr)), crushAmt);
}

export function renderClap(sr: number, k: KitParams, r: Rand): Float32Array {
  const out = len(sr, k.clapDecay * 5 + 0.04);
  const bp = new Biquad(sr, 'bandpass', 1150, 1.4);
  const bp2 = new Biquad(sr, 'bandpass', 2400, 1.0);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let env = Math.exp(-t / k.clapDecay) * 0.7;
    for (const at of [0, 0.011, 0.022]) if (t >= at) env += Math.exp(-(t - at) / 0.0035);
    const w = r.next() * 2 - 1;
    out[i] = (bp.process(w) + bp2.process(w) * 0.4) * env;
  }
  return crush(normalise(fadeEdges(out, sr)), k.crush);
}

export function renderPerc(sr: number, k: KitParams, r: Rand): Float32Array {
  const out = len(sr, 0.25);
  let ph = 0;
  const hp = new Biquad(sr, 'highpass', 2000, 0.7);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    ph += (TAU * k.percHz * (1 + 0.6 * Math.exp(-t / 0.006))) / sr;
    out[i] = Math.sin(ph) * Math.exp(-t / 0.045) + hp.process(r.next() * 2 - 1) * Math.exp(-t / 0.002) * 0.4;
  }
  return crush(normalise(fadeEdges(out, sr)), k.crush);
}

// ---------------------------------------------------------------- weapons

export interface ShotRecipe {
  /** Transient crack: decay (s) and high-pass (Hz). */
  crack: number;
  crackHz: number;
  /** Body: band-passed noise. */
  body: number;
  bodyHz: number;
  bodyDecay: number;
  /** Low boom sine. */
  boom: number;
  boomHz: number;
  boomDecay: number;
  /** Air tail and street echoes. */
  tail: number;
  tailDecay: number;
  echo: number;
  drive: number;
  seconds: number;
}

export const SHOTS: Record<string, ShotRecipe> = {
  pistol: { crack: 0.005, crackHz: 1800, body: 0.8, bodyHz: 1600, bodyDecay: 0.028, boom: 0.85, boomHz: 150, boomDecay: 0.055, tail: 0.3, tailDecay: 0.22, echo: 1, drive: 2.2, seconds: 0.75 },
  smg: { crack: 0.0035, crackHz: 2400, body: 0.7, bodyHz: 2200, bodyDecay: 0.016, boom: 0.6, boomHz: 185, boomDecay: 0.03, tail: 0.18, tailDecay: 0.12, echo: 0.55, drive: 2.6, seconds: 0.4 },
  shotgun: { crack: 0.008, crackHz: 1100, body: 1, bodyHz: 850, bodyDecay: 0.075, boom: 1.2, boomHz: 72, boomDecay: 0.16, tail: 0.5, tailDecay: 0.45, echo: 1.3, drive: 3, seconds: 1.2 },
  rifle: { crack: 0.0025, crackHz: 3000, body: 0.85, bodyHz: 2000, bodyDecay: 0.035, boom: 1, boomHz: 95, boomDecay: 0.1, tail: 0.45, tailDecay: 0.55, echo: 1.4, drive: 2.8, seconds: 1.3 },
  launcher: { crack: 0, crackHz: 1000, body: 0.7, bodyHz: 480, bodyDecay: 0.05, boom: 1.3, boomHz: 62, boomDecay: 0.12, tail: 0.25, tailDecay: 0.2, echo: 0.6, drive: 1.8, seconds: 0.6 },
};

export function renderShot(sr: number, p: ShotRecipe, r: Rand): Float32Array {
  const out = len(sr, p.seconds);
  const hp = new Biquad(sr, 'highpass', p.crackHz * r.range(0.9, 1.1), 0.7);
  const bp = new Biquad(sr, 'bandpass', p.bodyHz * r.range(0.9, 1.1), 0.9);
  const lp = new Biquad(sr, 'lowpass', 1600, 0.6);
  const boomHz = p.boomHz * r.range(0.93, 1.07);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const w = r.next() * 2 - 1;
    const crack = p.crack > 0 ? hp.process(w) * Math.exp(-t / p.crack) * 1.3 : 0;
    const body = bp.process(w) * Math.exp(-t / p.bodyDecay) * p.body * 2;
    ph += (TAU * boomHz * (1 + 1.6 * Math.exp(-t / 0.008))) / sr;
    const boom = Math.sin(ph) * Math.exp(-t / p.boomDecay) * p.boom * Math.min(1, t / 0.0008);
    const tail = lp.process(w) * p.tail * (1 - Math.exp(-t / 0.006)) * Math.exp(-t / p.tailDecay);
    out[i] = tanhSat(crack + body + boom + tail, p.drive);
  }
  if (p.echo > 0) addEchoes(out, sr, [
    [0.085 * r.range(0.9, 1.2), 0.22 * p.echo],
    [0.19 * r.range(0.9, 1.2), 0.12 * p.echo],
    [0.34 * r.range(0.9, 1.2), 0.06 * p.echo],
  ]);
  return normalise(fadeEdges(out, sr, 0.0002, 0.05));
}

/** Taser: a buzzing arc with spitting sparks. */
export function renderTaser(sr: number, r: Rand): Float32Array {
  const dur = 0.65;
  const out = len(sr, dur);
  const bp = new Biquad(sr, 'bandpass', 2600, 0.8);
  const hp = new Biquad(sr, 'highpass', 3000, 0.7);
  const sparks = grainEnvelope(out.length, sr, r, 40, dur, 0.0008, 0.003);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    ph += (TAU * (62 + 9 * Math.sin(TAU * 7 * t) + r.range(-6, 6))) / sr;
    const buzz = (Math.sin(ph) > 0 ? 1 : -1) * 0.35 + (r.next() * 2 - 1) * 0.15;
    const env = Math.min(1, t / 0.015) * Math.min(1, (dur - t) / 0.12);
    out[i] = (bp.process(buzz) * env + hp.process(r.next() * 2 - 1) * sparks[i]! * 0.8) * (1 + 0.4 * Math.sin(TAU * 31 * t));
  }
  return normalise(fadeEdges(out, sr));
}

/** Filtered-noise swish with a moving centre: swings, rolls, passing cars. */
export function renderWhoosh(sr: number, r: Rand, dur: number, f0: number, f1: number, q = 1.8): Float32Array {
  const out = len(sr, dur);
  const bp = new Biquad(sr, 'bandpass', f0, q);
  for (let i = 0; i < out.length; i++) {
    const t = i / out.length;
    if (i % 32 === 0) bp.set('bandpass', f0 + (f1 - f0) * Math.sin(t * Math.PI * 0.8), q);
    const env = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 2);
    out[i] = bp.process(r.next() * 2 - 1) * env;
  }
  return normalise(fadeEdges(out, sr));
}

export function renderPunch(sr: number, r: Rand): Float32Array {
  const out = len(sr, 0.25);
  const lp = new Biquad(sr, 'lowpass', 1400, 0.7);
  const hp = new Biquad(sr, 'highpass', 2500, 0.7);
  let ph = 0;
  const f0 = r.range(80, 105);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    ph += (TAU * f0 * (1 + Math.exp(-t / 0.01))) / sr;
    const w = r.next() * 2 - 1;
    out[i] = tanhSat(Math.sin(ph) * Math.exp(-t / 0.045) + lp.process(w) * Math.exp(-t / 0.02) * 0.8 + hp.process(w) * Math.exp(-t / 0.004) * 0.5, 1.8);
  }
  return normalise(fadeEdges(out, sr));
}

export function renderBatHit(sr: number, r: Rand): Float32Array {
  const out = len(sr, 0.35);
  const modes = new Modes(sr, [r.range(480, 560), r.range(1100, 1250), r.range(2300, 2600)], [18, 14, 10], [1, 0.6, 0.3]);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const ex = (r.next() * 2 - 1) * Math.exp(-t / 0.0015);
    ph += (TAU * 85 * (1 + Math.exp(-t / 0.012))) / sr;
    out[i] = modes.process(ex) * 3 + Math.sin(ph) * Math.exp(-t / 0.05) * 0.8;
  }
  return normalise(fadeEdges(out, sr));
}

export function renderDryClick(sr: number, r: Rand): Float32Array {
  const out = len(sr, 0.09);
  const modes = new Modes(sr, [3200, 5100], 25, [1, 0.5]);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let ex = (r.next() * 2 - 1) * Math.exp(-t / 0.0006);
    if (t > 0.028) ex += (r.next() * 2 - 1) * Math.exp(-(t - 0.028) / 0.0005) * 0.5;
    out[i] = modes.process(ex) * 4 + ex * 0.3;
  }
  return normalise(fadeEdges(out, sr), 0.7);
}

export function renderReload(sr: number, r: Rand): Float32Array {
  const out = len(sr, 0.9);
  const metal = new Modes(sr, [1800, 2650, 4100], [22, 18, 14], [1, 0.7, 0.4]);
  const slide = new Biquad(sr, 'bandpass', 1500, 1.5);
  const clicks: [number, number][] = [
    [0, 0.6],
    [0.43, 1],
    [0.62, 0.7],
    [0.7, 0.9],
  ];
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let ex = 0;
    for (const [at, a] of clicks) if (t >= at) ex += (r.next() * 2 - 1) * Math.exp(-(t - at) / 0.0012) * a;
    let s = 0;
    if (t > 0.12 && t < 0.3) {
      const u = (t - 0.12) / 0.18;
      if (i % 32 === 0) slide.set('bandpass', 900 + 1800 * u, 1.5);
      s = slide.process(r.next() * 2 - 1) * Math.sin(Math.PI * u) * 0.25;
    }
    out[i] = metal.process(ex) * 3 + s + (t > 0.43 && t < 0.5 ? Math.sin(TAU * 110 * t) * Math.exp(-(t - 0.43) / 0.02) * 0.4 : 0);
  }
  return normalise(fadeEdges(out, sr), 0.8);
}

// ---------------------------------------------------------------- impacts

/** Metal crunch: grains of crumple ringing a bank of sheet-metal modes. `heavy` 0..1. */
export function renderCrunch(sr: number, r: Rand, heavy: number): Float32Array {
  const dur = 0.45 + heavy * 0.75;
  const out = len(sr, dur);
  const grains = grainEnvelope(out.length, sr, r, Math.round(3 + heavy * 9), 0.04 + heavy * 0.16, 0.004, 0.02);
  const debris = grainEnvelope(out.length, sr, r, Math.round(heavy * 22), dur * 0.7, 0.0008, 0.003, 0.08);
  const freqs = Array.from({ length: 7 }, () => r.range(320, 4200));
  const modes = new Modes(sr, freqs, freqs.map(() => r.range(14, 40)), freqs.map(() => r.range(0.4, 1)));
  const smallModes = new Modes(sr, [r.range(2500, 3500), r.range(4200, 6000)], 30, [1, 0.7]);
  const bp = new Biquad(sr, 'bandpass', 1300, 0.7);
  const lp = new Biquad(sr, 'lowpass', 500, 0.7);
  let ph = 0;
  const thumpHz = 95 - heavy * 35;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const w = r.next() * 2 - 1;
    const ex = w * grains[i]!;
    ph += (TAU * thumpHz * (1 + 0.8 * Math.exp(-t / 0.015))) / sr;
    const thump = Math.sin(ph) * Math.exp(-t / (0.05 + heavy * 0.09)) * (0.8 + heavy * 0.5);
    const rumble = lp.process(w) * Math.exp(-t / (0.08 + heavy * 0.2)) * heavy;
    out[i] = tanhSat(thump + rumble + bp.process(ex) * 1.1 + modes.process(ex) * 2.4 + smallModes.process(w * debris[i]!) * 1.5, 1.6);
  }
  return normalise(fadeEdges(out, sr, 0.0003, 0.05));
}

/** Glass: a bright crash and a shower of shards tinkling down. */
export function renderGlass(sr: number, r: Rand, size: number): Float32Array {
  const dur = 1.1 + size * 0.4;
  const out = len(sr, dur);
  const hp = new Biquad(sr, 'highpass', 2600, 0.7);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i] = hp.process(r.next() * 2 - 1) * Math.exp(-t / 0.05) * 0.9;
  }
  const shards = Math.round(35 + size * 45);
  for (let s = 0; s < shards; s++) {
    const at = Math.min(dur - 0.1, -Math.log(1 - r.next() * 0.98) * 0.16);
    const f = r.range(2400, 9500);
    const dec = r.range(0.012, 0.07);
    const amp = r.range(0.15, 0.6) * Math.exp(-at / 0.5);
    const start = Math.floor(at * sr);
    const end = Math.min(out.length, start + Math.ceil(dec * 6 * sr));
    const ph = r.next() * TAU;
    for (let i = start; i < end; i++) {
      const t = (i - start) / sr;
      out[i]! += (Math.sin(ph + TAU * f * t) + 0.4 * Math.sin(TAU * f * 2.76 * t)) * amp * Math.exp(-t / dec);
    }
  }
  return normalise(fadeEdges(out, sr, 0.0003, 0.05), 0.9);
}

/** Struck material by name: wood, plastic, metal (clang) or a light street sign. */
export function renderStruck(sr: number, r: Rand, material: 'wood' | 'plastic' | 'metal'): Float32Array {
  const dur = material === 'metal' ? 1.4 : material === 'wood' ? 0.45 : 0.4;
  const out = len(sr, dur);
  let modes: Modes;
  let exDecay = 0.002;
  if (material === 'metal') {
    const base = r.range(240, 420);
    modes = new Modes(sr, [1, 2.32, 4.25, 6.63, 9.38].map((k) => base * k), [90, 80, 70, 60, 50], [1, 0.7, 0.45, 0.3, 0.2]);
    exDecay = 0.0012;
  } else if (material === 'wood') {
    modes = new Modes(sr, [r.range(170, 220), r.range(330, 420), r.range(600, 760), r.range(1200, 1500)], [10, 12, 14, 12], [1, 0.7, 0.5, 0.3]);
  } else {
    modes = new Modes(sr, [r.range(230, 300), r.range(560, 680), r.range(1300, 1500)], [7, 8, 9], [1, 0.6, 0.3]);
    exDecay = 0.004;
  }
  const grains = grainEnvelope(out.length, sr, r, material === 'wood' ? 5 : 3, material === 'wood' ? 0.07 : 0.03, exDecay, exDecay * 3);
  const rattle = grainEnvelope(out.length, sr, r, 10, dur * 0.6, 0.001, 0.003, 0.06);
  const lp = new Biquad(sr, 'lowpass', 900, 0.7);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const w = r.next() * 2 - 1;
    ph += (TAU * 85 * (1 + Math.exp(-t / 0.01))) / sr;
    const thump = Math.sin(ph) * Math.exp(-t / 0.05) * 0.7;
    out[i] = tanhSat(modes.process(w * grains[i]!) * 3 + thump + lp.process(w * rattle[i]!) * 0.5, 1.4);
  }
  return normalise(fadeEdges(out, sr, 0.0003, 0.05));
}

/** A body hit: soft, low and short. Deliberately not gory. */
export function renderThud(sr: number, r: Rand): Float32Array {
  const out = len(sr, 0.22);
  const lp = new Biquad(sr, 'lowpass', 700, 0.7);
  const hp = new Biquad(sr, 'highpass', 2500, 0.7);
  let ph = 0;
  const f0 = r.range(65, 85);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const w = r.next() * 2 - 1;
    ph += (TAU * f0 * (1 + 0.5 * Math.exp(-t / 0.012))) / sr;
    out[i] = Math.sin(ph) * Math.exp(-t / 0.06) + lp.process(w) * Math.exp(-t / 0.03) * 0.7 + hp.process(w) * Math.exp(-t / 0.05) * 0.12;
  }
  return normalise(fadeEdges(out, sr));
}

export function renderKerb(sr: number, r: Rand): Float32Array {
  const out = len(sr, 0.35);
  const lp = new Biquad(sr, 'lowpass', 320, 0.8);
  const clunk = new Modes(sr, [r.range(150, 190), r.range(380, 450)], [8, 10], [1, 0.4]);
  const rattle = grainEnvelope(out.length, sr, r, 6, 0.15, 0.001, 0.004, 0.03);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const w = r.next() * 2 - 1;
    ph += (TAU * 58 * (1 + 0.6 * Math.exp(-t / 0.02))) / sr;
    const ex = w * Math.exp(-t / 0.003);
    out[i] = Math.sin(ph) * Math.exp(-t / 0.09) + lp.process(w) * Math.exp(-t / 0.06) * 0.8 + clunk.process(ex) * 2 + clunk.process(w * rattle[i]!) * 0.6;
  }
  return normalise(fadeEdges(out, sr));
}

/** Wet footstep: heel, scuff and a little splash. */
export function renderFootstep(sr: number, r: Rand): Float32Array {
  const out = len(sr, 0.16);
  const bp = new Biquad(sr, 'bandpass', r.range(900, 1400), 1.2);
  const hp = new Biquad(sr, 'highpass', 3200, 0.7);
  let ph = 0;
  const f0 = r.range(95, 125);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const w = r.next() * 2 - 1;
    ph += (TAU * f0 * (1 + Math.exp(-t / 0.006))) / sr;
    const heel = Math.sin(ph) * Math.exp(-t / 0.02) * 0.6;
    const scuff = bp.process(w) * Math.exp(-t / 0.014) * 0.7;
    const splash = hp.process(w) * Math.min(1, t / 0.006) * Math.exp(-t / 0.045) * 0.45;
    out[i] = heel + scuff + splash;
  }
  return normalise(fadeEdges(out, sr), 0.85);
}

export function renderExplosion(sr: number, r: Rand, size: number): Float32Array {
  const dur = 2.6 + size * 0.8;
  const out = len(sr, dur);
  const blast = new Biquad(sr, 'lowpass', 1500, 0.7);
  const rumble = new Biquad(sr, 'lowpass', 160, 0.7);
  const hp = new Biquad(sr, 'highpass', 1800, 0.7);
  const crackle = grainEnvelope(out.length, sr, r, Math.round(90 + size * 60), 1.4, 0.0006, 0.003, 0.05);
  let brown = 0;
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const w = r.next() * 2 - 1;
    brown = (brown + w * 0.06) * 0.996;
    if (i % 64 === 0) blast.set('lowpass', 200 + 1600 * Math.exp(-t / 0.18), 0.7);
    const crack = w * Math.exp(-t / 0.007) * 0.9;
    const body = blast.process(w) * Math.min(1, t / 0.003) * Math.exp(-t / 0.38) * 1.4;
    p1 += (TAU * (30 + 55 * Math.exp(-t / 0.12))) / sr;
    p2 += (TAU * 44) / sr;
    const boom = Math.sin(p1) * Math.exp(-t / 0.55) * 1.2 + Math.sin(p2) * Math.exp(-t / 0.9) * 0.4 * Math.min(1, t / 0.02);
    const tail = rumble.process(brown) * 6 * Math.exp(-t / (0.9 + size * 0.4));
    const debris = hp.process(w) * crackle[i]! * 0.35 * Math.exp(-t / 0.8);
    out[i] = tanhSat(crack + body + boom + tail + debris, 2.2);
  }
  addEchoes(out, sr, [
    [0.14, 0.3],
    [0.31, 0.18],
    [0.55, 0.1],
  ], 900);
  return normalise(fadeEdges(out, sr, 0.0002, 0.3));
}

export function renderRicochet(sr: number, r: Rand): Float32Array {
  const out = len(sr, 0.45);
  const hp = new Biquad(sr, 'highpass', 2000, 0.7);
  const f0 = r.range(2800, 3600);
  const f1 = r.range(1100, 1500);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const f = (f1 + (f0 - f1) * Math.exp(-t / 0.12)) * (1 + 0.03 * Math.sin(TAU * 38 * t));
    ph += (TAU * f) / sr;
    out[i] = Math.sin(ph) * Math.min(1, t / 0.01) * Math.exp(-t / 0.12) * 0.6 + hp.process(r.next() * 2 - 1) * Math.exp(-t / 0.004);
  }
  return normalise(fadeEdges(out, sr), 0.8);
}

export function renderBulletHit(sr: number, r: Rand, metal: boolean): Float32Array {
  const out = len(sr, metal ? 0.3 : 0.18);
  const modes = metal ? new Modes(sr, [r.range(1700, 2300), r.range(3100, 3900), r.range(5200, 6400)], [40, 35, 30], [1, 0.6, 0.4]) : new Modes(sr, [r.range(1800, 2800)], 3, [1]);
  const debris = grainEnvelope(out.length, sr, r, metal ? 2 : 6, 0.08, 0.0008, 0.002, 0.01);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const w = r.next() * 2 - 1;
    const ex = w * (Math.exp(-t / 0.0012) + debris[i]! * 0.4);
    out[i] = modes.process(ex) * (metal ? 4 : 2) + ex * 0.3;
  }
  return normalise(fadeEdges(out, sr), 0.85);
}

/** Car door: a padded thump and the latch. */
export function renderDoor(sr: number, r: Rand): Float32Array {
  const out = len(sr, 0.3);
  const lp = new Biquad(sr, 'lowpass', 600, 0.7);
  const latch = new Modes(sr, [r.range(1600, 2000), r.range(2900, 3400)], 20, [1, 0.5]);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const w = r.next() * 2 - 1;
    ph += (TAU * 105 * (1 + 0.4 * Math.exp(-t / 0.02))) / sr;
    const ex = t >= 0.012 ? w * Math.exp(-(t - 0.012) / 0.001) : 0;
    out[i] = Math.sin(ph) * Math.exp(-t / 0.05) * 0.9 + lp.process(w) * Math.exp(-t / 0.025) * 0.6 + latch.process(ex) * 2;
  }
  return normalise(fadeEdges(out, sr), 0.8);
}

/** Exhaust pop on lift-off. */
export function renderPop(sr: number, r: Rand): Float32Array {
  const out = len(sr, 0.12);
  const lp = new Biquad(sr, 'lowpass', r.range(1000, 1800), 0.9);
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    ph += (TAU * 70 * (1 + Math.exp(-t / 0.005))) / sr;
    out[i] = tanhSat(lp.process(r.next() * 2 - 1) * Math.exp(-t / 0.01) * 2 + Math.sin(ph) * Math.exp(-t / 0.02), 2.5);
  }
  return normalise(fadeEdges(out, sr), 0.9);
}

/** Water jet from a burst hydrant. */
export function renderSpray(sr: number, r: Rand): Float32Array {
  const dur = 1.8;
  const out = len(sr, dur);
  const bp = new Biquad(sr, 'bandpass', 2600, 0.5);
  const hp = new Biquad(sr, 'highpass', 5000, 0.7);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const w = r.next() * 2 - 1;
    const env = Math.min(1, t / 0.04) * Math.exp(-t / 0.9) * (1 + 0.15 * Math.sin(TAU * 9 * t));
    out[i] = (bp.process(w) + hp.process(w) * 0.4) * env;
  }
  return normalise(fadeEdges(out, sr, 0.001, 0.2), 0.8);
}

/** Electrical fizz from a smashed vending machine or lamp. */
export function renderFizz(sr: number, r: Rand): Float32Array {
  const dur = 0.8;
  const out = len(sr, dur);
  const sparks = grainEnvelope(out.length, sr, r, 30, dur * 0.8, 0.0005, 0.004);
  const hp = new Biquad(sr, 'highpass', 2500, 0.7);
  const bp = new Biquad(sr, 'bandpass', 240, 2);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const buzz = bp.process(Math.sin(TAU * 120 * t) > 0.2 ? 1 : -1) * Math.exp(-t / 0.3) * 0.5;
    out[i] = hp.process(r.next() * 2 - 1) * sparks[i]! + buzz;
  }
  return normalise(fadeEdges(out, sr), 0.8);
}

/** Tuning static between stations. */
export function renderStatic(sr: number, r: Rand, dur: number): Float32Array {
  const out = len(sr, dur);
  const bp = new Biquad(sr, 'bandpass', 1900, 0.45);
  const pops = grainEnvelope(out.length, sr, r, Math.round(dur * 40), dur, 0.0005, 0.002);
  let amp = 1;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    if (i % Math.floor(sr * 0.015) === 0) amp = r.range(0.35, 1);
    const env = Math.min(1, t / 0.02) * Math.min(1, (dur - t) / 0.06);
    const whistle = Math.sin(TAU * (1200 + 900 * Math.sin(TAU * 1.7 * t)) * t) * 0.08;
    out[i] = (bp.process(r.next() * 2 - 1) * amp + pops[i]! * (r.next() * 2 - 1) + whistle) * env;
  }
  return normalise(out, 0.8);
}

// ---------------------------------------------------------------- loops

/** Rain on the street: a dense patter of droplets with heavier plinks. Loops seamlessly. */
export function renderRainLoop(sr: number, r: Rand, seconds = 5): Float32Array {
  const xf = 0.4;
  const raw = len(sr, seconds + xf);
  // Droplets spread evenly through the loop (the grain helper bunches onsets towards the start).
  const fine = new Float32Array(raw.length);
  for (let g = 0; g < (seconds + xf) * 900; g++) {
    const at = Math.floor(r.next() * raw.length);
    const dec = r.range(0.0003, 0.0015) * sr;
    const amp = Math.pow(r.next(), 3);
    const end = Math.min(raw.length, at + Math.ceil(dec * 6));
    for (let i = at; i < end; i++) fine[i]! += amp * Math.exp(-(i - at) / dec);
  }
  const hp = new Biquad(sr, 'highpass', 2500, 0.6);
  for (let i = 0; i < raw.length; i++) raw[i] = hp.process((r.next() * 2 - 1) * fine[i]!);
  for (let d = 0; d < (seconds + xf) * 14; d++) {
    const at = Math.floor(r.next() * raw.length);
    const f = r.range(1200, 3400);
    const amp = r.range(0.15, 0.45);
    const end = Math.min(raw.length, at + Math.ceil(0.03 * sr));
    for (let i = at; i < end; i++) {
      const t = (i - at) / sr;
      raw[i]! += Math.sin(TAU * f * (1 + t * 8) * t) * amp * Math.exp(-t / 0.006);
    }
  }
  return normalise(loopable(raw, sr, xf), 0.8);
}

const VOWELS: readonly (readonly [number, number, number])[] = [
  [800, 1200, 2600],
  [500, 1800, 2550],
  [300, 2200, 2950],
  [500, 900, 2450],
  [350, 700, 2400],
  [700, 1650, 2500],
  [600, 1150, 2450],
];

/** Formant voice synthesis: a band-limited glottal saw through three formant filters. */
interface VoiceSeg {
  dur: number;
  f0a: number;
  f0b: number;
  /** Formants at the start and end of the segment. */
  va: readonly [number, number, number];
  vb: readonly [number, number, number];
  ampA: number;
  ampB: number;
  /** Breath (aspiration) mix 0..1. */
  breath: number;
}

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

function renderVoiceInto(out: Float32Array, offset: number, sr: number, r: Rand, segs: readonly VoiceSeg[], formantScale: number, jitter: number, vibrato: number): number {
  const f1 = new Biquad(sr, 'bandpass', 800, 8);
  const f2 = new Biquad(sr, 'bandpass', 1200, 10);
  const f3 = new Biquad(sr, 'bandpass', 2600, 14);
  let phase = r.next();
  let i = offset;
  let jit = 0;
  for (const s of segs) {
    const n = Math.floor(s.dur * sr);
    for (let k = 0; k < n && i < out.length; k++, i++) {
      const u = k / Math.max(1, n);
      if (k % 32 === 0) {
        const fa = (j: 0 | 1 | 2): number => (s.va[j] + (s.vb[j] - s.va[j]) * u) * formantScale;
        f1.set('bandpass', fa(0), fa(0) / 90);
        f2.set('bandpass', fa(1), fa(1) / 110);
        f3.set('bandpass', fa(2), fa(2) / 160);
        jit += (r.range(-1, 1) * jitter - jit) * 0.3;
      }
      const t = i / sr;
      const f0 = (s.f0a + (s.f0b - s.f0a) * u) * (1 + jit + vibrato * Math.sin(TAU * 5.6 * t));
      const dt = f0 / sr;
      phase += dt;
      if (phase >= 1) phase -= 1;
      const saw = 2 * phase - 1 - polyBlep(phase, dt);
      const amp = s.ampA + (s.ampB - s.ampA) * u;
      const src = saw * (1 - s.breath) + (r.next() * 2 - 1) * s.breath * 1.6;
      out[i]! += (f1.process(src) + f2.process(src) * 0.65 + f3.process(src) * 0.35) * amp;
    }
  }
  return i;
}

export type VocalKind = 'scream' | 'yelp' | 'hey' | 'ow' | 'hurt';

/** Short vocal burst for a fleeing or struck pedestrian (formant synthesis, no samples). */
export function renderVocal(sr: number, r: Rand, kind: VocalKind): Float32Array {
  const pitch = r.range(0.88, 1.18);
  const fem = r.chance(0.5);
  const fs = fem ? r.range(1.08, 1.2) : r.range(0.92, 1.02);
  const p = (hz: number): number => hz * pitch * (fem ? 1.6 : 1);
  const A = VOWELS[0]!;
  const E = VOWELS[1]!;
  const I = VOWELS[2]!;
  const O = VOWELS[3]!;
  const U = VOWELS[4]!;
  const AE = VOWELS[5]!;
  const UH = VOWELS[6]!;
  let segs: VoiceSeg[];
  switch (kind) {
    case 'scream':
      segs = [
        { dur: 0.07, f0a: p(250), f0b: p(330), va: A, vb: A, ampA: 0, ampB: 0.9, breath: 0.25 },
        { dur: 0.42, f0a: p(330), f0b: p(350), va: A, vb: AE, ampA: 0.9, ampB: 1, breath: 0.2 },
        { dur: 0.22, f0a: p(350), f0b: p(260), va: AE, vb: A, ampA: 1, ampB: 0, breath: 0.3 },
      ];
      break;
    case 'yelp':
      segs = [
        { dur: 0.05, f0a: p(200), f0b: p(270), va: O, vb: O, ampA: 0, ampB: 1, breath: 0.2 },
        { dur: 0.12, f0a: p(270), f0b: p(230), va: O, vb: A, ampA: 1, ampB: 0.8, breath: 0.15 },
        { dur: 0.1, f0a: p(230), f0b: p(170), va: A, vb: U, ampA: 0.8, ampB: 0, breath: 0.3 },
      ];
      break;
    case 'hey':
      segs = [
        { dur: 0.06, f0a: p(140), f0b: p(140), va: E, vb: E, ampA: 0, ampB: 0.5, breath: 1 },
        { dur: 0.16, f0a: p(140), f0b: p(175), va: E, vb: E, ampA: 0.6, ampB: 1, breath: 0.15 },
        { dur: 0.14, f0a: p(175), f0b: p(125), va: E, vb: I, ampA: 1, ampB: 0, breath: 0.2 },
      ];
      break;
    case 'ow':
      segs = [
        { dur: 0.05, f0a: p(150), f0b: p(190), va: A, vb: A, ampA: 0, ampB: 1, breath: 0.2 },
        { dur: 0.14, f0a: p(190), f0b: p(170), va: A, vb: O, ampA: 1, ampB: 0.8, breath: 0.15 },
        { dur: 0.13, f0a: p(170), f0b: p(120), va: O, vb: U, ampA: 0.8, ampB: 0, breath: 0.25 },
      ];
      break;
    case 'hurt':
      segs = [
        { dur: 0.04, f0a: p(110), f0b: p(120), va: UH, vb: UH, ampA: 0, ampB: 1, breath: 0.4 },
        { dur: 0.16, f0a: p(120), f0b: p(90), va: UH, vb: A, ampA: 1, ampB: 0, breath: 0.45 },
      ];
      break;
  }
  const total = segs.reduce((a, s) => a + s.dur, 0) + 0.02;
  const out = len(sr, total);
  renderVoiceInto(out, 0, sr, r, segs, fs, kind === 'hurt' ? 0.06 : 0.015, kind === 'scream' ? 0.025 : 0.008);
  return normalise(fadeEdges(out, sr, 0.002, 0.02), 0.9);
}

function babbleSegs(r: Rand, f0: number, seconds: number, syllable: [number, number], pause: number): VoiceSeg[] {
  const segs: VoiceSeg[] = [];
  let t = 0;
  let v = r.pick(VOWELS);
  let f = f0;
  while (t < seconds) {
    if (r.chance(pause)) {
      const d = r.range(0.12, 0.5);
      segs.push({ dur: d, f0a: f, f0b: f, va: v, vb: v, ampA: 0, ampB: 0, breath: 0 });
      t += d;
      continue;
    }
    const d = r.range(syllable[0], syllable[1]);
    const nv = r.pick(VOWELS);
    const nf = f0 * r.range(0.85, 1.25);
    segs.push({ dur: d * 0.25, f0a: f, f0b: nf, va: v, vb: nv, ampA: 0.1, ampB: 1, breath: 0.12 });
    segs.push({ dur: d * 0.75, f0a: nf, f0b: nf * r.range(0.9, 1.05), va: nv, vb: nv, ampA: 1, ampB: 0.15, breath: 0.1 });
    v = nv;
    f = nf;
    t += d;
  }
  return segs;
}

/** Crowd murmur: several unintelligible talkers, darkened by distance. Loops seamlessly. */
export function renderCrowdLoop(sr: number, r: Rand, seconds = 7, talkers = 6): Float32Array {
  const xf = 0.5;
  const raw = len(sr, seconds + xf);
  for (let k = 0; k < talkers; k++) {
    const f0 = r.chance(0.5) ? r.range(95, 135) : r.range(170, 230);
    const tmp = len(sr, seconds + xf);
    renderVoiceInto(tmp, 0, sr, r, babbleSegs(r, f0, seconds + xf, [0.11, 0.26], 0.2), f0 > 150 ? 1.12 : 1, 0.02, 0.006);
    const g = r.range(0.5, 1);
    for (let i = 0; i < raw.length; i++) raw[i]! += tmp[i]! * g;
  }
  const lp = new Biquad(sr, 'lowpass', 2200, 0.6);
  for (let i = 0; i < raw.length; i++) raw[i] = lp.process(raw[i]!);
  return normalise(loopable(raw, sr, xf), 0.8);
}

/** A police radio transmission: squelch, a garbled voice through a narrow band, squelch tail. */
export function renderChatter(sr: number, r: Rand): Float32Array {
  const words = r.range(0.9, 2.1);
  const tail = 0.16;
  const out = len(sr, 0.06 + words + tail);
  const f0 = r.chance(0.6) ? r.range(105, 135) : r.range(180, 215);
  renderVoiceInto(out, Math.floor(0.06 * sr), sr, r, babbleSegs(r, f0, words, [0.08, 0.18], 0.12), f0 > 150 ? 1.1 : 1, 0.02, 0.004);
  const bp = new Biquad(sr, 'bandpass', 1500, 0.9);
  const hp = new Biquad(sr, 'highpass', 400, 0.7);
  const nb = new Biquad(sr, 'bandpass', 2400, 0.7);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const voice = tanhSat(hp.process(bp.process(out[i]! * 1.6)), 3) * 0.8;
    const open = t < 0.06 ? Math.exp(-t / 0.02) : 0;
    const close = t > 0.06 + words ? Math.exp(-(t - 0.06 - words) / 0.05) : 0;
    const hiss = nb.process(r.next() * 2 - 1) * (0.05 + open * 0.8 + close * 0.9);
    out[i] = voice + hiss;
  }
  return normalise(fadeEdges(out, sr), 0.8);
}

/** Fire: hiss, low roar and spitting crackles. Loops seamlessly. */
export function renderFireLoop(sr: number, r: Rand, seconds = 4): Float32Array {
  const xf = 0.4;
  const raw = len(sr, seconds + xf);
  const roar = new Biquad(sr, 'lowpass', 220, 0.7);
  const hiss = new Biquad(sr, 'highpass', 3500, 0.7);
  const pops = new Float32Array(raw.length);
  for (let g = 0; g < (seconds + xf) * 28; g++) {
    const at = Math.floor(r.next() * raw.length);
    const dec = r.range(0.0006, 0.004) * sr;
    const amp = Math.pow(r.next(), 2);
    const end = Math.min(raw.length, at + Math.ceil(dec * 6));
    for (let i = at; i < end; i++) pops[i]! += amp * Math.exp(-(i - at) / dec);
  }
  const popF = new Biquad(sr, 'bandpass', 1800, 0.8);
  let brown = 0;
  for (let i = 0; i < raw.length; i++) {
    const t = i / sr;
    const w = r.next() * 2 - 1;
    brown = (brown + w * 0.05) * 0.995;
    raw[i] = roar.process(brown) * 4 * (0.8 + 0.2 * Math.sin(TAU * 0.7 * t)) + hiss.process(w) * 0.05 + popF.process(w * pops[i]!) * 1.5;
  }
  return normalise(loopable(raw, sr, xf), 0.8);
}

/** Vinyl crackle for the lo-fi station. Loops seamlessly. */
export function renderCrackleLoop(sr: number, r: Rand, seconds = 3): Float32Array {
  const xf = 0.3;
  const raw = len(sr, seconds + xf);
  const hp = new Biquad(sr, 'highpass', 1200, 0.7);
  const lp = new Biquad(sr, 'lowpass', 5000, 0.7);
  for (let i = 0; i < raw.length; i++) raw[i] = lp.process(hp.process(r.next() * 2 - 1)) * 0.04;
  for (let g = 0; g < (seconds + xf) * 18; g++) {
    const at = Math.floor(r.next() * raw.length);
    const amp = Math.pow(r.next(), 3) * (r.chance(0.5) ? 1 : -1);
    const dec = r.range(0.0002, 0.0012) * sr;
    const end = Math.min(raw.length, at + Math.ceil(dec * 6));
    for (let i = at; i < end; i++) raw[i]! += amp * Math.exp(-(i - at) / dec);
  }
  return normalise(loopable(raw, sr, xf), 0.7);
}

/** Looping noise: white, pink (Paul Kellet) or brown. */
export function renderNoise(sr: number, r: Rand, seconds: number, colour: 'white' | 'pink' | 'brown'): Float32Array {
  const xf = 0.25;
  const raw = len(sr, seconds + xf);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let brown = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = r.next() * 2 - 1;
    if (colour === 'white') raw[i] = w;
    else if (colour === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      raw[i] = b0 + b1 + b2 + w * 0.1848;
    } else {
      brown = (brown + w * 0.02) * 0.998;
      raw[i] = brown;
    }
  }
  return normalise(loopable(raw, sr, xf), 0.9);
}

/** Stereo reverb impulse: early reflections, then a decaying tail that darkens as it goes. */
export function renderImpulse(sr: number, r: Rand, seconds: number): [Float32Array, Float32Array] {
  const n = Math.ceil(sr * seconds);
  const ch: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  for (const out of ch) {
    const lp = new OnePole(sr, 9000);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if (i % 256 === 0) lp.setFreq(9000 * Math.exp(-t / (seconds * 0.35)) + 400);
      const env = Math.pow(1 - t / seconds, 2) * Math.exp(-t / (seconds * 0.28));
      out[i] = lp.process(r.next() * 2 - 1) * env * Math.min(1, t / 0.008);
    }
    for (let k = 0; k < 8; k++) {
      const at = Math.floor(r.range(0.006, 0.07) * sr);
      if (at < n) out[at]! += r.range(-0.6, 0.6);
    }
  }
  normalise(ch[0], 0.6);
  normalise(ch[1], 0.6);
  return ch;
}
