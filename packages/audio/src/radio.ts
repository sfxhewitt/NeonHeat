/**
 * The car radio: plays the procedural sequencer through a small persistent synth band per station.
 * Notes are scheduled ahead on the audio clock (lookahead scheduling from the frame update), and the
 * mono parts reuse their oscillators for every note, so a bar costs a few drum buffer sources and a
 * handful of parameter automations. Stations run "live": switching away and back resumes mid-song.
 */
import type { AudioConfig, DrumKit, PartSynth, Station } from './config';
import { renderClap, renderHat, renderKick, renderPerc, renderSnare } from './dsp';
import { holdParam, type AudioEngine } from './engine';
import { midiHz } from './mix';
import {
  STEPS_PER_BAR,
  advance,
  buildTimeline,
  filterAt,
  identNotes,
  locate,
  stepEvents,
  swingOffset,
  type Cursor,
  type DrumPart,
  type SeqEvent,
  type Timeline,
} from './sequencer';

interface Mono {
  oscs: OscillatorNode[];
  filter: BiquadFilterNode;
  amp: GainNode;
  cfg: PartSynth;
}

interface Band {
  station: Station;
  index: number;
  tl: Timeline;
  out: GainNode;
  filter: BiquadFilterNode;
  pump: GainNode;
  drums: GainNode;
  delay: DelayNode;
  bass: Mono;
  arp: Mono;
  lead: Mono;
  pads: Mono[];
  sources: AudioScheduledSourceNode[];
  cursor: Cursor;
  /** station time = audio time + offset */
  offset: number;
  lastTrack: number;
}

export function kitName(station: Station, part: DrumPart): string {
  return `kit:${station.id}:${part}`;
}

export class RadioAudio {
  private band: Band | null = null;
  private readonly timelines = new Map<string, Timeline>();
  private readonly offsets = new Map<string, number>();
  private readonly events: SeqEvent[] = [];
  /** Called when a station starts (name shown on the HUD). */
  onStation: ((station: Station | null) => void) | null = null;

  constructor(
    private readonly eng: AudioEngine,
    private readonly cfg: AudioConfig,
  ) {}

  get stations(): readonly Station[] {
    return this.cfg.radio.stations;
  }

  get playing(): number {
    return this.band ? this.band.index : -1;
  }

  /** Queue every station's drum kit for rendering (after the sound effects). */
  registerKits(): void {
    for (const st of this.cfg.radio.stations) {
      const k = st.kit;
      this.eng.register(kitName(st, 'kick'), (sr, r) => renderKick(sr, k, r), 1);
      this.eng.register(kitName(st, 'snare'), (sr, r) => renderSnare(sr, k, r), 1);
      this.eng.register(kitName(st, 'hat'), (sr, r) => renderHat(sr, k.hatDecay, k.hatHz, k.crush, r), 1);
      this.eng.register(kitName(st, 'openHat'), (sr, r) => renderHat(sr, k.openHatDecay, k.hatHz * 0.9, k.crush, r), 1);
      this.eng.register(kitName(st, 'clap'), (sr, r) => renderClap(sr, k, r), 1);
      this.eng.register(kitName(st, 'perc'), (sr, r) => renderPerc(sr, k, r), 1);
    }
  }

  timeline(i: number): Timeline | null {
    const st = this.cfg.radio.stations[i];
    if (!st) return null;
    let tl = this.timelines.get(st.id);
    if (!tl) {
      tl = buildTimeline(st);
      this.timelines.set(st.id, tl);
      this.offsets.set(st.id, this.eng.random() * tl.seconds);
    }
    return tl;
  }

  /** Tune to a station (-1 = off). `ident` plays static and the station jingle first. */
  tune(index: number, ident: boolean): void {
    const ctx = this.eng.ctx;
    if (!ctx) return;
    if (this.band && this.band.index === index) return;
    this.stopBand(ident ? 0.12 : this.cfg.radio.fadeSec);
    const st = this.cfg.radio.stations[index];
    if (!st) {
      this.onStation?.(null);
      return;
    }
    const tl = this.timeline(index)!;
    const r = this.cfg.radio;
    let start = ctx.currentTime + 0.05;
    if (ident) {
      this.eng.play('static', 0.5, 0, 1, 0, true);
      this.jingle(st, ctx.currentTime + r.staticSec * 0.7);
      start = ctx.currentTime + r.identSec;
    }
    this.band = this.buildBand(ctx, st, index, tl, start);
    this.onStation?.(st);
  }

  /** Radio off: fade the band out and free its nodes. */
  off(fade = this.cfg.radio.fadeSec): void {
    this.stopBand(fade);
  }

  private stopBand(fade: number): void {
    const b = this.band;
    const ctx = this.eng.ctx;
    if (!b || !ctx) return;
    this.band = null;
    const t = ctx.currentTime;
    holdParam(b.out.gain, t);
    b.out.gain.setTargetAtTime(0, t, Math.max(0.01, fade / 3));
    for (const s of b.sources) {
      try {
        s.stop(t + fade + 0.2);
      } catch {
        /* already stopped */
      }
    }
    setTimeout(() => b.out.disconnect(), (fade + 0.5) * 1000);
  }

  private mono(ctx: AudioContext, cfg: PartSynth, dest: AudioNode, sends: { reverb: AudioNode; delay: AudioNode }, sources: AudioScheduledSourceNode[], wobble: AudioNode | null, gainScale = 1): Mono {
    const out = ctx.createGain();
    out.gain.value = cfg.gain * gainScale;
    out.connect(dest);
    if (cfg.reverb > 0) {
      const s = ctx.createGain();
      s.gain.value = cfg.reverb;
      out.connect(s).connect(sends.reverb);
    }
    if (cfg.delay > 0) {
      const s = ctx.createGain();
      s.gain.value = cfg.delay;
      out.connect(s).connect(sends.delay);
    }
    const amp = ctx.createGain();
    amp.gain.value = 0;
    amp.connect(out);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cfg.cutoff;
    filter.Q.value = cfg.resonance;
    filter.connect(amp);
    const oscs: OscillatorNode[] = [];
    const n = cfg.detuneCents > 0 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator();
      o.type = cfg.wave;
      o.detune.value = n === 2 ? (i === 0 ? -cfg.detuneCents : cfg.detuneCents) : 0;
      if (wobble) wobble.connect(o.detune);
      const g = ctx.createGain();
      g.gain.value = 1 / n;
      o.connect(g).connect(filter);
      oscs.push(o);
      sources.push(o);
    }
    return { oscs, filter, amp, cfg };
  }

  private buildBand(ctx: AudioContext, st: Station, index: number, tl: Timeline, start: number): Band {
    const sources: AudioScheduledSourceNode[] = [];
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, ctx.currentTime);
    out.gain.setTargetAtTime(st.gain, start, this.cfg.radio.fadeSec / 3);
    out.connect(this.eng.musicIn);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = st.filterMax;
    filter.Q.value = 0.8;
    filter.connect(out);
    const pump = ctx.createGain();
    pump.connect(filter);
    const drums = ctx.createGain();
    drums.connect(filter);
    if (st.kit.reverb > 0) {
      const s = ctx.createGain();
      s.gain.value = st.kit.reverb;
      drums.connect(s).connect(this.eng.reverbSend);
    }
    // Tempo delay with a darkening feedback loop.
    const delayIn = ctx.createGain();
    const delay = ctx.createDelay(2);
    const fb = ctx.createGain();
    fb.gain.value = st.delayFeedback;
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 2800;
    delayIn.connect(delay);
    delay.connect(dlp).connect(fb).connect(delay);
    const delayOut = ctx.createGain();
    delayOut.gain.value = 0.6;
    delay.connect(delayOut).connect(pump);
    // Tape wobble for the lo-fi stations.
    let wobble: GainNode | null = null;
    if (st.wobbleCents > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.55;
      wobble = ctx.createGain();
      wobble.gain.value = st.wobbleCents;
      lfo.connect(wobble);
      sources.push(lfo);
    }
    const sends = { reverb: this.eng.reverbSend, delay: delayIn };
    const bass = this.mono(ctx, st.bass, pump, sends, sources, wobble);
    const arp = this.mono(ctx, st.arpSynth, pump, sends, sources, wobble);
    const lead = this.mono(ctx, st.lead, pump, sends, sources, wobble);
    if (st.lead.wave !== 'sine') {
      // Lead vibrato.
      const vib = ctx.createOscillator();
      vib.frequency.value = 5.2;
      const depth = ctx.createGain();
      depth.gain.value = 9;
      vib.connect(depth);
      for (const o of lead.oscs) depth.connect(o.detune);
      sources.push(vib);
    }
    const padBus = ctx.createGain();
    padBus.connect(pump);
    const pads = [0, 1, 2, 3].map(() => this.mono(ctx, st.pad, padBus, sends, sources, wobble, 0.3));
    // Slow filter drift on the pads.
    const padLfo = ctx.createOscillator();
    padLfo.frequency.value = 0.07;
    const padDepth = ctx.createGain();
    padDepth.gain.value = st.pad.cutoff * 0.35;
    padLfo.connect(padDepth);
    for (const p of pads) padDepth.connect(p.filter.frequency);
    sources.push(padLfo);
    if (st.crackle > 0) {
      const buf = this.eng.buffer('crackleLoop', 0);
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const g = ctx.createGain();
        g.gain.value = st.crackle;
        src.connect(g).connect(out);
        sources.push(src);
      }
    }
    for (const s of sources) s.start(ctx.currentTime);
    // Find where the station is, then nudge its clock so the next bar line lands exactly on `start`.
    const cursor = locate(tl, start + (this.offsets.get(st.id) ?? 0));
    while (cursor.step % STEPS_PER_BAR !== 0) advance(tl, cursor);
    const offset = cursor.time - start;
    this.offsets.set(st.id, offset);
    return { station: st, index, tl, out, filter, pump, drums, delay, bass, arp, lead, pads, sources, cursor, offset, lastTrack: -1 };
  }

  /** Schedule everything due within the lookahead. Call every frame. */
  update(): void {
    const b = this.band;
    const ctx = this.eng.ctx;
    if (!b || !ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const horizon = now + this.cfg.radio.lookaheadSec;
    // Fell behind (a long hitch): jump to where the station is now.
    if (b.cursor.time - b.offset < now - 0.3) {
      locate(b.tl, now + b.offset + 0.05, b.cursor);
      advance(b.tl, b.cursor);
    }
    let guard = 0;
    while (b.cursor.time - b.offset < horizon && guard++ < 96) {
      const tr = b.tl.tracks[b.cursor.track]!;
      const at = b.cursor.time - b.offset + swingOffset(b.station, tr, b.cursor.step);
      if (at >= now - 0.01) this.scheduleStep(ctx, b, Math.max(at, now), b.cursor.track, b.cursor.step);
      advance(b.tl, b.cursor);
    }
  }

  private scheduleStep(ctx: AudioContext, b: Band, t: number, trackIndex: number, step: number): void {
    const st = b.station;
    const tr = b.tl.tracks[trackIndex]!;
    if (trackIndex !== b.lastTrack) {
      b.lastTrack = trackIndex;
      b.delay.delayTime.setValueAtTime(Math.min(1.9, st.delayBeats * (60 / tr.bpm)), t);
    }
    if (step % STEPS_PER_BAR === 0) {
      const f = filterAt(tr, step);
      b.filter.frequency.setTargetAtTime(st.filterMin * Math.pow(st.filterMax / st.filterMin, f), t, tr.stepDur * 4);
    }
    const evs = stepEvents(st, tr, step, this.events);
    const sd = tr.stepDur;
    for (const e of evs) {
      switch (e.part) {
        case 'kick':
        case 'snare':
        case 'hat':
        case 'openHat':
        case 'clap':
        case 'perc':
          this.drum(ctx, b, e.part, st.kit, e.vel, t);
          if (e.part === 'kick' && st.pump > 0) {
            b.pump.gain.setValueAtTime(1 - st.pump, t);
            b.pump.gain.setTargetAtTime(1, t + 0.01, sd * 1.2);
          }
          break;
        case 'bass':
          this.trigger(b.bass, t, e.midi, e.vel, e.len * sd * 0.92, e.slide);
          break;
        case 'arp':
          this.trigger(b.arp, t, e.midi, e.vel, e.len * sd * 0.8, false);
          break;
        case 'lead':
          this.trigger(b.lead, t, e.midi, e.vel, e.len * sd * 0.95, e.len > 1);
          break;
        case 'pad': {
          const p = b.pads[e.voice];
          if (p) this.trigger(p, t, e.midi, e.vel, e.len * sd, true, 0.03);
          break;
        }
      }
    }
  }

  private drum(ctx: AudioContext, b: Band, part: DrumPart, kit: DrumKit, vel: number, t: number): void {
    const buf = this.eng.buffer(kitName(b.station, part), 0);
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = vel * kit.gains[part];
    src.connect(g).connect(b.drums);
    src.start(t);
  }

  /** Play a note on a reusable mono synth: soft re-trigger, optional glide, filter envelope. */
  private trigger(m: Mono, t: number, midi: number, vel: number, dur: number, legato: boolean, glide = 0.035): void {
    const c = m.cfg;
    const f = midiHz(midi);
    for (const o of m.oscs) {
      o.frequency.cancelScheduledValues(t);
      if (legato) o.frequency.setTargetAtTime(f, t, glide);
      else o.frequency.setValueAtTime(f, t);
    }
    const a = m.amp.gain;
    a.cancelScheduledValues(t);
    a.setTargetAtTime(vel, t, Math.max(0.001, c.attack / 4));
    a.setTargetAtTime(vel * c.sustain, t + c.attack, Math.max(0.002, c.decay / 4));
    a.setTargetAtTime(0, t + Math.max(dur, c.attack), Math.max(0.003, c.release / 4));
    if (c.envAmount > 0) {
      const fq = m.filter.frequency;
      fq.cancelScheduledValues(t);
      fq.setTargetAtTime(c.cutoff + c.envAmount * vel, t, 0.002);
      fq.setTargetAtTime(c.cutoff, t + 0.006, Math.max(0.005, c.decay / 3));
    }
  }

  /** The station ident: a short bright figure through the reverb. */
  private jingle(st: Station, t0: number): void {
    const ctx = this.eng.ctx!;
    const out = ctx.createGain();
    out.gain.value = 0.35 * st.gain;
    out.connect(this.eng.musicIn);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    out.connect(send).connect(this.eng.reverbSend);
    let end = t0;
    for (const n of identNotes(st)) {
      const t = t0 + n.at;
      for (const [mult, type, g] of [
        [1, st.lead.wave, 0.6],
        [2, 'sine', 0.3],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = midiHz(n.midi) * mult;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(5000, t);
        lp.frequency.exponentialRampToValueAtTime(900, t + n.len);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(n.vel * g, t + 0.008);
        env.gain.exponentialRampToValueAtTime(0.0001, t + n.len + 0.2);
        o.connect(lp).connect(env).connect(out);
        o.start(t);
        o.stop(t + n.len + 0.3);
      }
      end = Math.max(end, t + n.len + 0.3);
    }
    setTimeout(() => out.disconnect(), (end - ctx.currentTime + 1.5) * 1000);
  }
}
