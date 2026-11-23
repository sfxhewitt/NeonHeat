/**
 * Interface sounds and music stings, synthesised live (a handful of nodes each, short-lived).
 */
import type { AudioConfig } from './config';
import type { AudioEngine } from './engine';
import { midiHz } from './mix';

export type UiSound =
  | 'blip'
  | 'back'
  | 'select'
  | 'pickup'
  | 'cash'
  | 'heatUp'
  | 'heatDown'
  | 'hackNode'
  | 'hackGood'
  | 'hackOk'
  | 'hackFail'
  | 'hackStart'
  | 'checkpoint'
  | 'deny';

export type StingName = 'missionStart' | 'missionComplete' | 'missionFail' | 'wasted' | 'busted' | 'respawn';

/** Hack panel notes: a minor pentatonic, one per node. */
const HACK_NOTES = [69, 72, 74, 76, 79, 81, 84, 86];

export class UiAudio {
  constructor(
    private readonly eng: AudioEngine,
    private readonly cfg: AudioConfig,
  ) {}

  /** One enveloped oscillator note into `dest`. */
  private note(dest: AudioNode, t: number, freq: number, dur: number, type: OscillatorType, gain: number, opts: { attack?: number; glide?: number; detune?: number; cutoff?: number; q?: number } = {}): void {
    const ctx = this.eng.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (opts.glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.glide), t + dur);
    if (opts.detune) o.detune.value = opts.detune;
    const g = ctx.createGain();
    const a = opts.attack ?? 0.004;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.01, dur));
    if (opts.cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.cutoff;
      f.Q.value = opts.q ?? 0.7;
      o.connect(f).connect(g);
    } else o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** A short noise burst (drawer, impact, riser). */
  private noise(dest: AudioNode, t: number, dur: number, gain: number, type: BiquadFilterType, freq: number, sweepTo?: number, attack = 0.002): void {
    const ctx = this.eng.ctx!;
    const n = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = this.eng.random() * 2 - 1;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(dest);
    s.start(t);
  }

  private ready(): AudioContext | null {
    const ctx = this.eng.ctx;
    return ctx && ctx.state === 'running' ? ctx : null;
  }

  play(name: UiSound, arg = 0): void {
    const ctx = this.ready();
    if (!ctx) return;
    const d = this.eng.ui;
    const t = ctx.currentTime + 0.005;
    switch (name) {
      case 'blip':
        this.note(d, t, 1320, 0.06, 'sine', 0.35, { glide: 1760 });
        this.note(d, t, 2640, 0.03, 'sine', 0.08);
        break;
      case 'select':
        this.note(d, t, 880, 0.05, 'triangle', 0.35);
        this.note(d, t + 0.05, 1320, 0.09, 'triangle', 0.35);
        break;
      case 'back':
        this.note(d, t, 990, 0.08, 'sine', 0.3, { glide: 620 });
        break;
      case 'deny':
        this.note(d, t, 196, 0.16, 'square', 0.14, { cutoff: 900 });
        this.note(d, t + 0.09, 185, 0.18, 'square', 0.14, { cutoff: 900 });
        break;
      case 'pickup':
        [76, 80, 83, 88].forEach((m, i) => this.note(d, t + i * 0.045, midiHz(m), 0.22, 'triangle', 0.28));
        this.note(d, t + 0.18, midiHz(95), 0.5, 'sine', 0.1);
        break;
      case 'cash': {
        // "Ka": the drawer thunk. "Ching": a bright bell with inharmonic partials, then a second strike.
        this.noise(d, t, 0.06, 0.5, 'lowpass', 900);
        this.note(d, t, 140, 0.08, 'sine', 0.4, { glide: 70 });
        for (const [at, base] of [
          [0.07, 1568],
          [0.16, 2093],
        ] as const) {
          [1, 2.76, 5.4, 8.93].forEach((k, i) => this.note(d, t + at, base * k, 0.9 / (1 + i), 'sine', 0.22 / (1 + i * 1.5), { attack: 0.002 }));
        }
        this.noise(d, t + 0.1, 0.35, 0.08, 'highpass', 6000);
        break;
      }
      case 'heatUp': {
        // Two-tone alert; climbs with the level.
        const lv = Math.max(1, arg);
        const base = 74 + lv;
        for (let k = 0; k < 2; k++) {
          this.note(d, t + k * 0.2, midiHz(base), 0.09, 'square', 0.13, { cutoff: 2600 });
          this.note(d, t + k * 0.2 + 0.1, midiHz(base + 5), 0.09, 'square', 0.13, { cutoff: 2600 });
        }
        break;
      }
      case 'heatDown':
        [79, 74, 71].forEach((m, i) => this.note(d, t + i * 0.09, midiHz(m), 0.2, 'sine', 0.22));
        break;
      case 'hackStart':
        this.note(d, t, 220, 0.25, 'sawtooth', 0.12, { glide: 880, cutoff: 2400 });
        this.noise(d, t, 0.25, 0.1, 'bandpass', 800, 5000);
        break;
      case 'hackNode': {
        const m = HACK_NOTES[Math.abs(arg) % HACK_NOTES.length]!;
        this.note(d, t, midiHz(m), 0.22, 'square', 0.16, { cutoff: 3200, q: 4 });
        this.note(d, t, midiHz(m + 12), 0.12, 'sine', 0.1);
        break;
      }
      case 'hackGood': {
        const m = HACK_NOTES[Math.abs(arg) % HACK_NOTES.length]!;
        this.note(d, t, midiHz(m), 0.16, 'triangle', 0.3);
        this.note(d, t, midiHz(m + 7), 0.16, 'sine', 0.12);
        break;
      }
      case 'hackOk':
        [69, 72, 76, 81, 84].forEach((m, i) => this.note(d, t + i * 0.06, midiHz(m), 0.3, 'triangle', 0.24));
        break;
      case 'hackFail':
        this.note(d, t, 110, 0.4, 'sawtooth', 0.2, { cutoff: 700 });
        this.note(d, t, 116.5, 0.4, 'sawtooth', 0.2, { cutoff: 700 });
        break;
      case 'checkpoint':
        this.note(d, t, midiHz(81), 0.16, 'triangle', 0.25);
        this.note(d, t + 0.08, midiHz(88), 0.3, 'triangle', 0.25);
        break;
    }
  }

  /** Music stings. They duck the radio while they play. */
  sting(name: StingName): void {
    const ctx = this.ready();
    if (!ctx) return;
    const d = this.eng.ui;
    const g = this.cfg.ui.stingGain;
    const t = ctx.currentTime + 0.01;
    const chord = (at: number, notes: number[], dur: number, type: OscillatorType, gain: number, cutoff: number): void => {
      for (const m of notes)
        for (const det of [-7, 7]) this.note(d, t + at, midiHz(m), dur, type, (gain * g) / notes.length, { attack: 0.01, detune: det, cutoff });
    };
    switch (name) {
      case 'missionStart':
        this.eng.duckMusic(0.8, 1.6);
        this.note(d, t, 110, 0.9, 'sine', 0.5 * g, { glide: 40 });
        this.noise(d, t, 0.5, 0.25 * g, 'bandpass', 300, 4000, 0.3);
        chord(0.02, [48, 55, 58, 62, 67], 1.6, 'sawtooth', 0.6, 1800);
        this.note(d, t + 0.02, midiHz(84), 1.2, 'sine', 0.15 * g);
        break;
      case 'missionComplete':
        this.eng.duckMusic(1, 2.6);
        [60, 64, 67, 72, 76, 79].forEach((m, i) => this.note(d, t + i * 0.07, midiHz(m), 0.35, 'triangle', 0.3 * g));
        chord(0.42, [48, 60, 64, 67, 71, 74], 2.2, 'sawtooth', 0.7, 3200);
        this.note(d, t + 0.42, 70, 0.6, 'sine', 0.5 * g, { glide: 45 });
        this.note(d, t + 0.42, midiHz(91), 1.8, 'sine', 0.1 * g);
        break;
      case 'missionFail':
        this.eng.duckMusic(1, 2.4);
        [67, 63, 60, 55].forEach((m, i) => this.note(d, t + i * 0.16, midiHz(m), 0.5, 'triangle', 0.25 * g));
        this.note(d, t + 0.1, 220, 1.6, 'sawtooth', 0.25 * g, { glide: 45, cutoff: 1200 });
        this.note(d, t + 0.1, 226, 1.6, 'sawtooth', 0.25 * g, { glide: 47, cutoff: 1200 });
        chord(0.66, [43, 50, 51, 58], 1.6, 'sawtooth', 0.5, 900);
        break;
      case 'wasted':
        // A heart monitor flatlining over a low drone.
        this.eng.duckMusic(1, 3);
        for (let k = 0; k < 2; k++) this.note(d, t + k * 0.42, 1000, 0.1, 'sine', 0.25 * g);
        this.note(d, t + 0.84, 1000, 2.2, 'sine', 0.22 * g, { attack: 0.005 });
        this.note(d, t, 55, 2.8, 'sawtooth', 0.3 * g, { cutoff: 300, attack: 0.4 });
        break;
      case 'busted':
        this.eng.duckMusic(1, 2.4);
        for (let k = 0; k < 3; k++) {
          this.note(d, t + k * 0.24, midiHz(76), 0.11, 'square', 0.16 * g, { cutoff: 2400 });
          this.note(d, t + k * 0.24 + 0.12, midiHz(72), 0.11, 'square', 0.16 * g, { cutoff: 2400 });
        }
        chord(0.75, [45, 52, 55, 60], 1.6, 'sawtooth', 0.5, 1000);
        this.noise(d, t + 0.75, 0.3, 0.4 * g, 'lowpass', 400);
        break;
      case 'respawn':
        this.note(d, t, midiHz(72), 0.4, 'sine', 0.2 * g, { attack: 0.05 });
        this.note(d, t + 0.12, midiHz(79), 0.6, 'sine', 0.2 * g, { attack: 0.05 });
        break;
    }
  }
}
