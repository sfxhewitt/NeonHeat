/**
 * AudioEngine: the Web Audio context, the bus graph, unlocking, pausing and the pooled one-shot player.
 * Everything here tolerates a missing or locked AudioContext: calls become no-ops and nothing throws.
 */
import type { AudioConfig } from './config';
import { renderImpulse } from './dsp';
import { Rand } from './mix';

type Ctor = typeof AudioContext;

function audioContextCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export interface Volumes {
  enabled: boolean;
  master: number;
  music: number;
  sfx: number;
}

/** A pooled channel strip: gain -> stereo panner -> bus. Buffer sources are one-shot; the strips are reused. */
interface Strip {
  gain: GainNode;
  pan: StereoPannerNode;
  src: AudioBufferSourceNode | null;
  ends: number;
  level: number;
  started: number;
}

/** Per-recipe render job for the bank. */
interface Job {
  name: string;
  variant: number;
  render: (sr: number, r: Rand, variant: number) => Float32Array;
  rate: number;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  /** Buses (all null until the context exists). */
  master!: GainNode;
  music!: GainNode;
  /** Station output joins here; it passes the pause filter and the duck. */
  musicIn!: GainNode;
  sfx!: GainNode;
  /** World sounds (engines, guns, ambience): silenced while paused. */
  world!: GainNode;
  ambience!: GainNode;
  ui!: GainNode;
  reverbSend!: GainNode;
  private musicFilter!: BiquadFilterNode;
  private duck!: GainNode;
  private worldMute!: GainNode;
  private unlockedOnce = false;
  private hidden = false;
  private paused = false;
  private failed = false;
  private volumes: Volumes = { enabled: true, master: 1, music: 1, sfx: 1 };
  private readonly strips: Strip[] = [];
  private readonly uiStrips: Strip[] = [];
  private readonly buffers = new Map<string, AudioBuffer[]>();
  private readonly jobs: Job[] = [];
  private readonly rand = new Rand(0xb0a710);
  /** Called once when the context first exists, so the layers can build their graphs. */
  private readonly readyHooks: ((ctx: AudioContext) => void)[] = [];

  constructor(readonly cfg: AudioConfig) {}

  /** True once a context exists and is running. */
  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  onReady(fn: (ctx: AudioContext) => void): void {
    if (this.ctx) fn(this.ctx);
    else this.readyHooks.push(fn);
  }

  /** Listen for the first user gesture (and every later one: iOS can interrupt the context at any time). */
  attachUnlock(target: Pick<Window, 'addEventListener'>): void {
    const unlock = (): void => this.unlock();
    for (const ev of ['pointerdown', 'touchend', 'mousedown', 'click', 'keydown']) {
      target.addEventListener(ev, unlock, { capture: true, passive: true });
    }
  }

  /** Create or resume the context. Must run inside a user gesture the first time on iOS and Chrome. */
  unlock(): void {
    if (this.failed || this.hidden) return;
    try {
      if (!this.ctx) this.create();
      const ctx = this.ctx;
      if (!ctx) return;
      if (ctx.state !== 'running') ctx.resume().catch(() => undefined);
      if (!this.unlockedOnce) {
        // iOS Safari: playing a buffer inside the gesture fully unlocks output.
        const b = ctx.createBuffer(1, 1, ctx.sampleRate);
        const s = ctx.createBufferSource();
        s.buffer = b;
        s.connect(ctx.destination);
        s.start();
        this.unlockedOnce = true;
      }
    } catch (err) {
      this.failed = true;
      console.warn('Audio unavailable', err);
    }
  }

  private create(): void {
    const C = audioContextCtor();
    if (!C) {
      this.failed = true;
      return;
    }
    const ctx = new C({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const b = this.cfg.buses;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = b.compressor.threshold;
    comp.knee.value = b.compressor.knee;
    comp.ratio.value = b.compressor.ratio;
    comp.attack.value = b.compressor.attack;
    comp.release.value = b.compressor.release;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = b.limiterThreshold;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    this.master = ctx.createGain();
    comp.connect(limiter).connect(this.master).connect(ctx.destination);

    this.music = ctx.createGain();
    this.music.connect(comp);
    this.duck = ctx.createGain();
    this.duck.connect(this.music);
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 20000;
    this.musicFilter.Q.value = 0.5;
    this.musicFilter.connect(this.duck);
    this.musicIn = ctx.createGain();
    this.musicIn.connect(this.musicFilter);

    this.sfx = ctx.createGain();
    this.sfx.connect(comp);
    this.worldMute = ctx.createGain();
    this.worldMute.connect(this.sfx);
    this.world = ctx.createGain();
    this.world.connect(this.worldMute);
    this.ambience = ctx.createGain();
    this.ambience.gain.value = b.ambience;
    this.ambience.connect(this.world);
    this.ui = ctx.createGain();
    this.ui.gain.value = this.cfg.ui.gain;
    this.ui.connect(this.sfx);

    // One shared reverb (generated impulse): music sends to it, and the world sends a little.
    const verb = ctx.createConvolver();
    const ir = renderImpulse(ctx.sampleRate, new Rand(77), b.reverbSeconds);
    const irBuf = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
    irBuf.copyToChannel(ir[0] as Float32Array<ArrayBuffer>, 0);
    irBuf.copyToChannel(ir[1] as Float32Array<ArrayBuffer>, 1);
    verb.buffer = irBuf;
    this.reverbSend = ctx.createGain();
    const ret = ctx.createGain();
    ret.gain.value = b.reverbReturn;
    this.reverbSend.connect(verb).connect(ret).connect(comp);
    const worldVerb = ctx.createGain();
    worldVerb.gain.value = 0.12;
    this.world.connect(worldVerb).connect(this.reverbSend);

    for (let i = 0; i < this.cfg.sfx.maxOneShots; i++) this.strips.push(this.makeStrip(this.world));
    for (let i = 0; i < 6; i++) this.uiStrips.push(this.makeStrip(this.ui));

    ctx.onstatechange = () => {
      // iOS reports 'interrupted' (calls, Siri); try again on the next gesture or visibility change.
      if ((ctx.state as string) === 'interrupted' && !this.hidden) ctx.resume().catch(() => undefined);
    };
    this.applyVolumes();
    this.applyPause();
    for (const fn of this.readyHooks.splice(0)) fn(ctx);
  }

  private makeStrip(dest: AudioNode): Strip {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    gain.connect(pan).connect(dest);
    return { gain, pan, src: null, ends: 0, level: 0, started: 0 };
  }

  /** Tab hidden or app backgrounded: suspend the whole context (saves battery). */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    const ctx = this.ctx;
    if (!ctx) return;
    if (hidden) ctx.suspend().catch(() => undefined);
    else if (this.unlockedOnce) ctx.resume().catch(() => undefined);
  }

  /** Game paused: world sounds go quiet, music dips behind a low-pass, UI stays. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.applyPause();
  }

  private applyPause(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const b = this.cfg.buses;
    this.worldMute.gain.setTargetAtTime(this.paused ? 0 : 1, t, 0.05);
    this.musicFilter.frequency.setTargetAtTime(this.paused ? b.pausedCutoff : 20000, t, 0.12);
    holdParam(this.duck.gain, t);
    this.duck.gain.setTargetAtTime(this.paused ? b.pausedMusic : 1, t, 0.12);
  }

  setVolumes(v: Volumes): void {
    this.volumes = v;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const b = this.cfg.buses;
    const v = this.volumes;
    const t = ctx.currentTime;
    // Perceptual curve: slider position squared.
    this.master.gain.setTargetAtTime(v.enabled ? b.master * v.master * v.master : 0, t, 0.03);
    this.music.gain.setTargetAtTime(b.music * v.music * v.music, t, 0.03);
    this.sfx.gain.setTargetAtTime(b.sfx * v.sfx * v.sfx, t, 0.03);
  }

  /** Dip the music for a sting or a big bang. */
  duckMusic(amount: number, hold: number): void {
    const ctx = this.ctx;
    if (!ctx || this.paused) return;
    const t = ctx.currentTime;
    const g = this.duck.gain;
    holdParam(g, t);
    g.setTargetAtTime(1 - amount * this.cfg.buses.duckAmount, t, 0.03);
    g.setTargetAtTime(1, t + hold, this.cfg.buses.duckRelease);
  }

  // -------------------------------------------------------------- sample bank

  /** Queue a recipe for rendering (spread across frames by `pump`). `rate` 0 = context rate. */
  register(name: string, render: Job['render'], variants = this.cfg.sfx.variants, rate = 0): void {
    if (this.buffers.has(name) || this.jobs.some((j) => j.name === name)) return;
    for (let v = 0; v < variants; v++) this.jobs.push({ name, variant: v, render, rate });
  }

  /** Render queued sounds for up to `budgetMs` this frame. */
  pump(budgetMs: number): void {
    const ctx = this.ctx;
    if (!ctx || this.jobs.length === 0) return;
    const t0 = performance.now();
    while (this.jobs.length > 0 && performance.now() - t0 < budgetMs) {
      const j = this.jobs.shift()!;
      const sr = j.rate > 0 ? Math.min(j.rate, ctx.sampleRate) : ctx.sampleRate;
      try {
        const data = j.render(sr, new Rand(hash(j.name) + j.variant * 7919), j.variant);
        const buf = ctx.createBuffer(1, data.length, sr);
        buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
        const list = this.buffers.get(j.name) ?? [];
        list.push(buf);
        this.buffers.set(j.name, list);
      } catch (err) {
        console.warn(`Audio render failed: ${j.name}`, err);
      }
    }
  }

  get pending(): number {
    return this.jobs.length;
  }

  has(name: string): boolean {
    return this.buffers.has(name);
  }

  /** A rendered buffer (random variant), or null while it is still queued. */
  buffer(name: string, variant = -1): AudioBuffer | null {
    const list = this.buffers.get(name);
    if (!list || list.length === 0) return null;
    return list[variant >= 0 ? variant % list.length : Math.floor(this.rand.next() * list.length)]!;
  }

  /**
   * Play a rendered one-shot on a pooled strip. When every strip is busy the quietest (then oldest)
   * voice is cut. Returns false if nothing played.
   */
  play(name: string, gain: number, pan = 0, rate = 1, delay = 0, ui = false): boolean {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || gain < 0.002) return false;
    const buf = this.buffer(name);
    if (!buf) return false;
    const pool = ui ? this.uiStrips : this.strips;
    const t = ctx.currentTime + delay;
    let pick: Strip | null = null;
    for (const s of pool) {
      if (s.ends <= ctx.currentTime) {
        pick = s;
        break;
      }
      if (!pick || s.level < pick.level || (s.level === pick.level && s.started < pick.started)) pick = s;
    }
    if (!pick) return false;
    if (pick.ends > ctx.currentTime && pick.level > gain * 1.5) return false;
    if (pick.src) {
      try {
        pick.src.stop(t);
      } catch {
        /* already stopped */
      }
      pick.src.disconnect();
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(pick.gain);
    pick.gain.gain.setValueAtTime(gain, t);
    pick.pan.pan.setValueAtTime(pan, t);
    src.start(t);
    pick.src = src;
    pick.level = gain;
    pick.started = t;
    pick.ends = t + buf.duration / rate;
    return true;
  }

  /** Random number for variation (not the sim's RNG: audio is presentation only). */
  random(): number {
    return this.rand.next();
  }
}

/** Freeze an AudioParam's automation at time t, keeping its current value (no jumps). */
export function holdParam(p: AudioParam, t: number): void {
  const q = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof q.cancelAndHoldAtTime === 'function') q.cancelAndHoldAtTime(t);
  else {
    const v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
