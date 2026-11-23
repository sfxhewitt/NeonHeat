/**
 * Police sound: pooled sirens (wail far off, yelp up close, with doppler), the drone's rotor hum at
 * high HEAT, and scanner chatter.
 */
import type { AudioConfig } from './config';
import type { AudioEngine } from './engine';
import { allocateVoices, distanceGain, dopplerFactor, panFor, sirenHz, type VoiceCandidate } from './mix';
import type { AudioVehicleView, AudioWorldView } from './view';

interface SirenVoice {
  id: number;
  osc: OscillatorNode;
  gain: GainNode;
  pan: StereoPannerNode;
  mode: 'wail' | 'yelp';
  phase: number;
  /** Seconds this voice has had its car (fade in). */
  age: number;
}

export class PoliceAudio {
  private readonly sirens: SirenVoice[] = [];
  private readonly slots: number[];
  private readonly candidates: VoiceCandidate[] = [];
  private readonly byId = new Map<number, AudioVehicleView>();
  private allocTimer = 0;
  private drone: { hum: GainNode; pan: StereoPannerNode; oscs: OscillatorNode[]; level: number } | null = null;
  private chatterTimer = 3;
  private lastHeat = 0;
  /** Sirens carry further than engines: a wider listener for them. */
  private readonly far: AudioConfig['listener'];

  constructor(
    private readonly eng: AudioEngine,
    private readonly cfg: AudioConfig,
  ) {
    this.slots = new Array<number>(cfg.police.maxSirens).fill(-1);
    this.far = { ...cfg.listener, maxDistance: cfg.listener.maxDistance * 1.6, refDistance: cfg.listener.refDistance * 1.5 };
  }

  private build(ctx: AudioContext): void {
    if (this.sirens.length > 0 || this.cfg.police.maxSirens === 0) return;
    // A siren horn: odd harmonics, a little even, through a horn-shaped band.
    const wave = ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]), new Float32Array([0, 1, 0.18, 0.42, 0.08, 0.2, 0.04, 0.1]));
    for (let i = 0; i < this.cfg.police.maxSirens; i++) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      const bp = ctx.createBiquadFilter();
      bp.type = 'peaking';
      bp.frequency.value = 1400;
      bp.gain.value = 6;
      bp.Q.value = 0.8;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 4200;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      osc.connect(bp).connect(lp).connect(gain).connect(pan).connect(this.eng.world);
      osc.start();
      this.sirens.push({ id: -1, osc, gain, pan, mode: 'wail', phase: i * 1.37, age: 0 });
    }
  }

  update(dt: number, lx: number, lz: number, lvx: number, lvz: number, w: AudioWorldView): void {
    const ctx = this.eng.ctx;
    if (!ctx) return;
    this.build(ctx);
    const pc = this.cfg.police;
    const L = this.cfg.listener;
    const heat = w.heat.level;
    const t = ctx.currentTime;

    this.byId.clear();
    for (const v of w.vehicles) if (v.active && v.role === 'police' && !v.destroyed) this.byId.set(v.id, v);
    this.allocTimer -= dt;
    if (this.allocTimer <= 0) {
      this.allocTimer = 0.1;
      const c = this.candidates;
      c.length = 0;
      if (heat > 0) for (const v of this.byId.values()) c.push({ id: v.id, dist: Math.hypot(v.x - lx, v.z - lz), pinned: false });
      allocateVoices(c, this.slots, pc.maxSirens, 6, L.maxDistance * 1.6);
    }
    for (let i = 0; i < this.sirens.length; i++) {
      const s = this.sirens[i]!;
      const car = this.byId.get(this.slots[i]!);
      if (!car) {
        if (s.id !== -1) s.gain.gain.setTargetAtTime(0, t, 0.25);
        s.id = -1;
        continue;
      }
      if (s.id !== car.id) {
        s.id = car.id;
        s.age = 0;
      }
      s.age += dt;
      const dx = car.x - lx;
      const dz = car.z - lz;
      const d = Math.hypot(dx, dz);
      if (s.mode === 'wail' && d < pc.yelpDistance) s.mode = 'yelp';
      else if (s.mode === 'yelp' && d > pc.yelpDistance + pc.yelpHysteresis) s.mode = 'wail';
      s.phase += dt;
      const dop = dopplerFactor(dx, dz, car.vx - lvx, car.vz - lvz, L);
      // Ramp to where the sweep will be a little ahead: smooth at any frame rate.
      const ahead = 0.05;
      s.osc.frequency.cancelScheduledValues(t);
      s.osc.frequency.setValueAtTime(Math.max(50, s.osc.frequency.value), t);
      s.osc.frequency.linearRampToValueAtTime(sirenHz(s.mode, s.phase + ahead, pc) * dop, t + ahead);
      const level = pc.sirenGain * distanceGain(d, this.far) * Math.min(1, s.age / 0.4);
      s.gain.gain.setTargetAtTime(level, t, 0.08);
      s.pan.pan.setTargetAtTime(panFor(dx, L), t, 0.06);
    }

    this.updateDrone(ctx, lx, lz, w);

    // Scanner chatter while wanted; a burst straight away when HEAT rises.
    if (heat > this.lastHeat && heat >= pc.chatterMinHeat && heat > 0) this.chatterTimer = Math.min(this.chatterTimer, 0.8);
    this.lastHeat = heat;
    if (heat >= Math.max(1, pc.chatterMinHeat)) {
      this.chatterTimer -= dt;
      if (this.chatterTimer <= 0) {
        this.chatterTimer = pc.chatterIntervalMin + this.eng.random() * (pc.chatterIntervalMax - pc.chatterIntervalMin);
        this.eng.play('chatter', pc.chatterGain, (this.eng.random() - 0.5) * 0.3);
      }
    } else this.chatterTimer = Math.max(this.chatterTimer, 2);
  }

  private updateDrone(ctx: AudioContext, lx: number, lz: number, w: AudioWorldView): void {
    const pc = this.cfg.police;
    const d = w.police?.drone;
    const want = !!d && d.active && w.heat.level >= pc.droneMinHeat;
    const t = ctx.currentTime;
    if (want && !this.drone) {
      // Rotor hum: two detuned saws chopped by a blade-rate tremolo, plus a motor whine.
      const hum = ctx.createGain();
      hum.gain.value = 0;
      const pan = ctx.createStereoPanner();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      const chop = ctx.createGain();
      chop.gain.value = 0.6;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 31;
      const depth = ctx.createGain();
      depth.gain.value = 0.4;
      lfo.connect(depth).connect(chop.gain);
      lp.connect(chop).connect(hum).connect(pan).connect(this.eng.world);
      const oscs: OscillatorNode[] = [lfo];
      for (const [f, type, g] of [
        [pc.droneHz, 'sawtooth', 0.5],
        [pc.droneHz * 1.012, 'sawtooth', 0.4],
        [pc.droneHz * 9.4, 'sine', 0.06],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = g;
        o.connect(og).connect(lp);
        oscs.push(o);
      }
      for (const o of oscs) o.start(t);
      this.drone = { hum, pan, oscs, level: 0 };
    }
    if (!this.drone) return;
    if (!want) {
      this.drone.hum.gain.setTargetAtTime(0, t, 0.4);
      const dr = this.drone;
      for (const o of dr.oscs) o.stop(t + 2);
      setTimeout(() => dr.pan.disconnect(), 2500);
      this.drone = null;
      return;
    }
    const dx = d!.x - lx;
    const dz = d!.z - lz;
    // It flies overhead: never closer than its altitude.
    const dist = Math.max(14, Math.hypot(dx, dz));
    this.drone.hum.gain.setTargetAtTime(pc.droneGain * distanceGain(dist, this.cfg.listener), t, 0.2);
    this.drone.pan.pan.setTargetAtTime(panFor(dx, this.cfg.listener), t, 0.1);
  }
}
