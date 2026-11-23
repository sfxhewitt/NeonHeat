/**
 * The city around the player: rain, the low hum of the sprawl, distant sirens and horns, crowd
 * murmur near people, screams when they scatter, fires from wrecks, and the player's footsteps.
 */
import type { AudioConfig } from './config';
import type { AudioEngine } from './engine';
import { clamp, distanceGain, panFor } from './mix';
import type { AudioWorldView } from './view';

interface Loop {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

const PED_STATE: Record<string, number> = { wander: 0, flee: 1, cower: 2, down: 3 };

export class AmbienceAudio {
  private rain: Loop | null = null;
  private rainWash: Loop | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private hum: Loop | null = null;
  private traffic: Loop | null = null;
  private crowd: Loop | null = null;
  private fire: (Loop & { pan: StereoPannerNode }) | null = null;
  private distantTimer = 12;
  private stride = 0;
  private stepSide = 1;
  private screamCooldown = 0;
  private pedStates = new Uint8Array(0);

  constructor(
    private readonly eng: AudioEngine,
    private readonly cfg: AudioConfig,
  ) {}

  private loop(name: string, dest: AudioNode, gain = 0): Loop | null {
    const ctx = this.eng.ctx!;
    const buf = this.eng.buffer(name, 0);
    if (!buf) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
    src.start(ctx.currentTime, this.eng.random() * buf.duration);
    return { src, gain: g };
  }

  private ensure(ctx: AudioContext): void {
    const a = this.cfg.ambience;
    const amb = this.eng.ambience;
    if (!this.rainFilter) {
      this.rainFilter = ctx.createBiquadFilter();
      this.rainFilter.type = 'lowpass';
      this.rainFilter.frequency.value = 16000;
      this.rainFilter.connect(amb);
    }
    if (!this.rain) this.rain = this.loop('rainLoop', this.rainFilter, a.rainGain);
    if (!this.rainWash && this.eng.has('pinkLoop')) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      lp.connect(this.rainFilter);
      this.rainWash = this.loop('pinkLoop', lp, a.rainGain * 0.35);
      if (!this.rainWash) lp.disconnect();
    }
    if (!this.hum && this.eng.has('brownLoop')) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 170;
      lp.connect(amb);
      this.hum = this.loop('brownLoop', lp, a.humGain);
      if (!this.hum) lp.disconnect();
    }
    if (!this.traffic && this.eng.has('pinkLoop')) {
      // Distant traffic wash: band-passed pink noise that slowly swells and fades.
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 420;
      bp.Q.value = 0.6;
      const swell = ctx.createGain();
      swell.gain.value = 0.7;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.06;
      const depth = ctx.createGain();
      depth.gain.value = 0.3;
      lfo.connect(depth).connect(swell.gain);
      bp.connect(swell).connect(amb);
      this.traffic = this.loop('pinkLoop', bp, a.humGain * 0.8);
      if (this.traffic) lfo.start();
      else bp.disconnect();
    }
    if (!this.crowd) this.crowd = this.loop('crowdLoop', amb, 0);
  }

  update(dt: number, lx: number, lz: number, w: AudioWorldView): void {
    const ctx = this.eng.ctx;
    if (!ctx) return;
    this.ensure(ctx);
    const a = this.cfg.ambience;
    const t = ctx.currentTime;
    const inCar = w.player.vehicle !== null;
    // Inside a car the rain drums on the roof: darker.
    this.rainFilter?.frequency.setTargetAtTime(inCar ? a.rainInCarCutoff : 16000, t, 0.15);

    // Crowd: people within range, nearer ones count more. Down or fleeing people stop chatting.
    let crowd = 0;
    const peds = w.peds?.peds ?? [];
    if (this.pedStates.length < peds.length) this.pedStates = new Uint8Array(peds.length);
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i]!;
      const code = PED_STATE[p.state] ?? 0;
      const prev = this.pedStates[i]!;
      this.pedStates[i] = p.active ? code : 0;
      if (!p.active) continue;
      const d = Math.hypot(p.x - lx, p.z - lz);
      if (code === 0 && d < a.crowdRadius) crowd += 1 - d / a.crowdRadius;
      // Someone starts to flee: now and then, a scream or a shout.
      if (code === 1 && prev !== 1 && d < 45 && this.screamCooldown <= 0 && this.eng.random() < 0.55) {
        this.screamCooldown = a.screamCooldownSec * (0.7 + this.eng.random() * 0.6);
        const kinds = ['scream', 'yelp', 'hey', 'scream'];
        this.vocal(kinds[Math.floor(this.eng.random() * kinds.length)]!, p.x - lx, d);
      }
    }
    this.screamCooldown -= dt;
    this.crowd?.gain.gain.setTargetAtTime(a.crowdGain * clamp(crowd / a.crowdFull, 0, 1) * (inCar ? 0.5 : 1), t, 0.6);

    this.updateFire(ctx, lx, lz, w);
    this.updateFootsteps(dt, w);

    // Far-off sirens and horns, only while the player is not wanted (it would read as a pursuit).
    this.distantTimer -= dt;
    if (this.distantTimer <= 0) {
      this.distantTimer = a.distantSirenIntervalMin + this.eng.random() * (a.distantSirenIntervalMax - a.distantSirenIntervalMin);
      if (w.heat.level === 0) {
        if (this.eng.random() < a.distantHornChance) this.distantHorn(ctx);
        else this.distantSiren(ctx);
      }
    }
  }

  /** A vocal burst at an offset from the listener. */
  vocal(kind: string, dx: number, dist: number, gain = 1): void {
    const L = this.cfg.listener;
    const g = this.cfg.ambience.screamGain * gain * distanceGain(dist, L);
    this.eng.play(`vocal:${kind}`, g, panFor(dx, L), 0.95 + this.eng.random() * 0.1);
  }

  private updateFire(ctx: AudioContext, lx: number, lz: number, w: AudioWorldView): void {
    let best = 45;
    let bx = 0;
    for (const v of w.vehicles) {
      if (!v.active || !v.destroyed) continue;
      const d = Math.hypot(v.x - lx, v.z - lz);
      if (d < best) {
        best = d;
        bx = v.x - lx;
      }
    }
    const t = ctx.currentTime;
    if (best < 45 && !this.fire && this.eng.has('fireLoop')) {
      const pan = ctx.createStereoPanner();
      pan.connect(this.eng.ambience);
      const l = this.loop('fireLoop', pan, 0);
      if (l) this.fire = { ...l, pan };
      else pan.disconnect();
    }
    if (!this.fire) return;
    this.fire.gain.gain.setTargetAtTime(best < 45 ? this.cfg.ambience.fireGain * distanceGain(best, this.cfg.listener) : 0, t, 0.3);
    this.fire.pan.pan.setTargetAtTime(panFor(bx, this.cfg.listener), t, 0.2);
  }

  private updateFootsteps(dt: number, w: AudioWorldView): void {
    const pc = w.playerCtl;
    if (w.player.vehicle || pc.mode === 'driving') {
      this.stride = 0;
      return;
    }
    const speed = Math.hypot(pc.vx, pc.vz);
    if (speed < 0.6) {
      this.stride = Math.min(this.stride, this.cfg.ambience.footstepStride * 0.6);
      return;
    }
    this.stride += speed * dt;
    const stride = this.cfg.ambience.footstepStride * (speed > 8 ? 1.6 : 1);
    if (this.stride >= stride) {
      this.stride -= stride;
      this.stepSide = -this.stepSide;
      const g = this.cfg.ambience.footstepGain * clamp(0.5 + speed / 10, 0.5, 1.1);
      this.eng.play('footstep', g, this.stepSide * 0.06, 0.92 + this.eng.random() * 0.16);
    }
  }

  private distantSiren(ctx: AudioContext): void {
    const p = this.cfg.police;
    const t = ctx.currentTime;
    const dur = 7 + this.eng.random() * 5;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = (p.wailLowHz + p.wailHighHz) / 2;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 1 / (p.wailPeriod * (0.9 + this.eng.random() * 0.3));
    const depth = ctx.createGain();
    depth.gain.value = (p.wailHighHz - p.wailLowHz) / 2;
    lfo.connect(depth).connect(osc.frequency);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = ctx.createGain();
    const level = this.cfg.ambience.distantSirenGain;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(this.eng.random() * 1.4 - 0.7, t);
    pan.pan.linearRampToValueAtTime(this.eng.random() * 1.4 - 0.7, t + dur);
    osc.connect(lp).connect(g).connect(pan).connect(this.eng.ambience);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + dur + 0.1);
    lfo.stop(t + dur + 0.1);
    setTimeout(() => pan.disconnect(), (dur + 0.5) * 1000);
  }

  private distantHorn(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const g = ctx.createGain();
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.eng.random() * 1.6 - 0.8;
    lp.connect(g).connect(pan).connect(this.eng.ambience);
    const level = this.cfg.ambience.distantSirenGain * 0.8;
    const blasts = 1 + Math.floor(this.eng.random() * 3);
    let at = t;
    for (let i = 0; i < blasts; i++) {
      const len = 0.15 + this.eng.random() * 0.4;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(level, at + 0.02);
      g.gain.setValueAtTime(level, at + len);
      g.gain.linearRampToValueAtTime(0, at + len + 0.04);
      at += len + 0.12;
    }
    const pitch = 0.85 + this.eng.random() * 0.3;
    for (const f of [370, 466]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f * pitch;
      o.connect(lp);
      o.start(t);
      o.stop(at + 0.1);
    }
    setTimeout(() => pan.disconnect(), (at - t + 0.5) * 1000);
  }
}
