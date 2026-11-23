/**
 * Vehicle sound: a small pool of engine voices given to the nearest cars, each with its own
 * class-specific engine note, gear changes, tyre squeal and doppler. Horns and exhaust pops too.
 */
import type { AudioConfig, EngineClass } from './config';
import type { AudioEngine } from './engine';
import { allocateVoices, clamp, distanceGain, dopplerFactor, engineHz, gearFor, lateralSlip, panFor, targetRpm, type GearState, type VoiceCandidate } from './mix';
import type { AudioVehicleView, AudioWorldView } from './view';

interface EngineVoice {
  vehicleId: number;
  cls: EngineClass | null;
  clsName: string;
  osc: OscillatorNode;
  osc2: OscillatorNode;
  osc2Gain: GainNode;
  sub: OscillatorNode;
  subGain: GainNode;
  whine: OscillatorNode;
  whineGain: GainNode;
  noiseGain: GainNode;
  noiseFilter: BiquadFilterNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
  squealOsc: OscillatorNode;
  squealNoise: BiquadFilterNode;
  squealGain: GainNode;
  rpm: number;
  gear: number;
  throttle: number;
  shiftCut: number;
  lastThrottle: number;
  /** Seconds since this voice took its car (fades in). */
  age: number;
}

const gearScratch: GearState = { gear: 1, rpm: 0 };

export class VehicleAudio {
  private readonly voices: EngineVoice[] = [];
  private readonly slots: number[];
  private readonly candidates: VoiceCandidate[] = [];
  private readonly waves = new Map<string, PeriodicWave>();
  private allocTimer = 0;
  private noise: AudioBuffer | null = null;
  private readonly byId = new Map<number, AudioVehicleView>();

  constructor(
    private readonly eng: AudioEngine,
    private readonly cfg: AudioConfig,
  ) {
    this.slots = new Array<number>(cfg.vehicles.maxVoices).fill(-1);
  }

  classOf(variantId: string): string {
    return this.cfg.vehicles.variantClass[variantId] ?? this.cfg.vehicles.defaultClass;
  }

  private build(ctx: AudioContext): void {
    if (this.voices.length > 0) return;
    // Shared looping noise for intake roar and tyre hiss.
    const n = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      d[i] = (s / 4294967296) * 2 - 1;
    }
    for (const [name, c] of Object.entries(this.cfg.vehicles.classes)) {
      const real = new Float32Array(c.harmonics.length + 1);
      const imag = new Float32Array(c.harmonics.length + 1);
      c.harmonics.forEach((h, i) => (imag[i + 1] = h));
      this.waves.set(name, ctx.createPeriodicWave(real, imag));
    }
    for (let i = 0; i < this.cfg.vehicles.maxVoices; i++) this.voices.push(this.makeVoice(ctx));
  }

  private makeVoice(ctx: AudioContext): EngineVoice {
    const dest = this.eng.world;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    gain.connect(pan).connect(dest);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.connect(gain);
    const osc = ctx.createOscillator();
    osc.connect(filter);
    const osc2 = ctx.createOscillator();
    const osc2Gain = ctx.createGain();
    osc2.connect(osc2Gain).connect(filter);
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    const subGain = ctx.createGain();
    sub.connect(subGain).connect(gain);
    const whine = ctx.createOscillator();
    whine.type = 'sine';
    const whineGain = ctx.createGain();
    whineGain.gain.value = 0;
    whine.connect(whineGain).connect(gain);
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = this.noise;
    noiseSrc.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.Q.value = 1.2;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    noiseSrc.connect(noiseFilter).connect(noiseGain).connect(filter);
    // Tyre squeal: a wavering tone plus band-passed hiss.
    const squealGain = ctx.createGain();
    squealGain.gain.value = 0;
    squealGain.connect(pan);
    const squealOsc = ctx.createOscillator();
    squealOsc.type = 'triangle';
    squealOsc.frequency.value = 1000;
    const sqOscGain = ctx.createGain();
    sqOscGain.gain.value = 0.5;
    squealOsc.connect(sqOscGain).connect(squealGain);
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 17;
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 45;
    wobble.connect(wobbleDepth).connect(squealOsc.frequency);
    const sqNoiseSrc = ctx.createBufferSource();
    sqNoiseSrc.buffer = this.noise;
    sqNoiseSrc.loop = true;
    sqNoiseSrc.loopStart = 0.5;
    const squealNoise = ctx.createBiquadFilter();
    squealNoise.type = 'bandpass';
    squealNoise.frequency.value = 1900;
    squealNoise.Q.value = 3;
    sqNoiseSrc.connect(squealNoise).connect(squealGain);
    const t = ctx.currentTime;
    for (const o of [osc, osc2, sub, whine, squealOsc, wobble]) o.start(t);
    noiseSrc.start(t);
    sqNoiseSrc.start(t, 0.5);
    return {
      vehicleId: -1,
      cls: null,
      clsName: '',
      osc,
      osc2,
      osc2Gain,
      sub,
      subGain,
      whine,
      whineGain,
      noiseGain,
      noiseFilter,
      filter,
      gain,
      pan,
      squealOsc,
      squealNoise,
      squealGain,
      rpm: 0,
      gear: 1,
      throttle: 0,
      shiftCut: 0,
      lastThrottle: 0,
      age: 0,
    };
  }

  private assignClass(v: EngineVoice, clsName: string): void {
    if (v.clsName === clsName) return;
    const c = this.cfg.vehicles.classes[clsName]!;
    v.cls = c;
    v.clsName = clsName;
    const wave = this.waves.get(clsName)!;
    v.osc.setPeriodicWave(wave);
    v.osc2.setPeriodicWave(wave);
    v.osc2.detune.value = c.detuneCents;
    v.osc2Gain.gain.value = c.detuneLevel;
    v.subGain.gain.value = c.sub;
    v.filter.Q.value = c.resonance;
  }

  /** Per frame: allocate voices to the nearest cars and drive each voice from its car. */
  update(dt: number, lx: number, lz: number, lvx: number, lvz: number, w: AudioWorldView): void {
    const ctx = this.eng.ctx;
    if (!ctx) return;
    this.build(ctx);
    const vc = this.cfg.vehicles;
    const L = this.cfg.listener;
    const playerId = w.player.vehicle ? w.player.vehicle.id : -1;
    this.byId.clear();
    for (const v of w.vehicles) if (v.active) this.byId.set(v.id, v);

    this.allocTimer -= dt;
    if (this.allocTimer <= 0) {
      this.allocTimer = 1 / 15;
      const c = this.candidates;
      c.length = 0;
      for (const v of w.vehicles) {
        if (!v.active || v.destroyed || v.role === 'parked') continue;
        c.push({ id: v.id, dist: Math.hypot(v.x - lx, v.z - lz), pinned: v.id === playerId });
      }
      allocateVoices(c, this.slots, vc.maxVoices, vc.hysteresis, L.maxDistance);
    }

    const t = ctx.currentTime;
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i]!;
      const id = this.slots[i]!;
      const car = id >= 0 ? this.byId.get(id) : undefined;
      if (!car || car.destroyed || car.role === 'parked') {
        if (voice.vehicleId !== -1) {
          voice.gain.gain.setTargetAtTime(0, t, 0.08);
          voice.squealGain.gain.setTargetAtTime(0, t, 0.05);
          voice.vehicleId = -1;
        }
        continue;
      }
      if (voice.vehicleId !== car.id) {
        voice.vehicleId = car.id;
        voice.age = 0;
        voice.rpm = -1;
        voice.gear = 1;
      }
      this.drive(voice, car, car.id === playerId, dt, t, lx, lz, lvx, lvz);
    }
  }

  private drive(v: EngineVoice, car: AudioVehicleView, isPlayer: boolean, dt: number, t: number, lx: number, lz: number, lvx: number, lvz: number): void {
    const vc = this.cfg.vehicles;
    const L = this.cfg.listener;
    this.assignClass(v, this.classOf(car.variantId));
    const c = v.cls!;
    v.age += dt;
    const fx = Math.sin(car.yaw);
    const fz = Math.cos(car.yaw);
    const fwd = car.vx * fx + car.vz * fz;
    const speed = Math.abs(fwd);
    const top = car.params.topSpeed;
    const ctl = car.controls;
    const pedal = Math.max(ctl.throttle, fwd < -0.5 ? ctl.brake : 0);
    v.throttle += (pedal - v.throttle) * Math.min(1, dt * 10);

    const g = gearFor(speed, top, c, gearScratch);
    let target = targetRpm(g, ctl.handbrake ? Math.max(pedal, 0.2) : v.throttle, speed, top);
    if (car.drifting && v.throttle > 0.3) target = Math.min(1.05, target + 0.18);
    if (v.rpm < 0) v.rpm = target;
    if (g.gear !== v.gear) {
      if (g.gear > v.gear && v.throttle > 0.2) v.shiftCut = vc.shiftCutSec;
      v.gear = g.gear;
    }
    // Upshift: revs drop quickly; otherwise they chase the target smoothly.
    const rate = g.gear > 1 && v.rpm > target + 0.15 ? vc.rpmRate * 2.5 : vc.rpmRate;
    v.rpm += (target - v.rpm) * Math.min(1, dt * rate);
    v.shiftCut = Math.max(0, v.shiftCut - dt);
    const cut = v.shiftCut > 0 ? 0.45 : 1;

    // Exhaust pops when the player lifts off at high revs.
    if (isPlayer && c.pops && v.lastThrottle > 0.6 && ctl.throttle < 0.1 && v.rpm > 0.55) this.pops();
    v.lastThrottle = ctl.throttle;

    const dx = car.x - lx;
    const dz = car.z - lz;
    const dist = Math.hypot(dx, dz);
    const dop = isPlayer ? 1 : dopplerFactor(dx, dz, car.vx - lvx, car.vz - lvz, L);
    const hz = engineHz(c, v.rpm) * dop;
    const load = clamp(v.throttle * cut, 0, 1);
    const tc = 0.03;
    v.osc.frequency.setTargetAtTime(hz, t, tc);
    v.osc2.frequency.setTargetAtTime(hz, t, tc);
    v.sub.frequency.setTargetAtTime(hz * 0.5, t, tc);
    if (c.whineRatio > 0) {
      v.whine.frequency.setTargetAtTime(hz * c.whineRatio, t, tc);
      v.whineGain.gain.setTargetAtTime(c.whineLevel * (0.25 + 0.75 * v.rpm), t, 0.05);
    } else v.whineGain.gain.setTargetAtTime(0, t, 0.05);
    v.noiseFilter.frequency.setTargetAtTime(hz * 6, t, tc);
    v.noiseGain.gain.setTargetAtTime(c.noise * (0.3 + load), t, 0.05);
    const cutoff = c.cutoffIdle + (c.cutoffMax - c.cutoffIdle) * clamp(0.35 * v.rpm + 0.65 * load * (0.5 + 0.5 * v.rpm), 0, 1);
    v.filter.frequency.setTargetAtTime(cutoff * cut, t, 0.04);

    const base = isPlayer ? vc.playerGain : car.role === 'traffic' && speed < 1 ? vc.idleGain : vc.otherGain;
    const fadeIn = Math.min(1, v.age / 0.3);
    const level = c.gain * base * (0.55 + 0.45 * load) * (isPlayer ? 1 : distanceGain(dist, L)) * fadeIn;
    v.gain.gain.setTargetAtTime(level, t, 0.05);
    v.pan.pan.setTargetAtTime(isPlayer ? panFor(dx, L) * 0.4 : panFor(dx, L), t, 0.05);

    // Tyres: sideways slip, handbrake slides and hard braking all squeal.
    const slip = lateralSlip(car.vx, car.vz, car.yaw);
    let sq = clamp((slip - vc.squealSlipMin) / Math.max(vc.squealSlipFull - vc.squealSlipMin, 0.1), 0, 1);
    if (ctl.handbrake && speed > 6) sq = Math.max(sq, 0.55);
    if (ctl.brake > 0.6 && fwd > 12) sq = Math.max(sq, 0.35);
    if (speed < 2.5) sq = 0;
    const sqLevel = sq * vc.squealGain * (isPlayer ? 1 : distanceGain(dist, L) * 0.8);
    v.squealGain.gain.setTargetAtTime(sqLevel, t, sq > 0 ? 0.04 : 0.09);
    v.squealOsc.frequency.setTargetAtTime(820 + slip * 28 + speed * 4, t, 0.05);
    v.squealNoise.frequency.setTargetAtTime(1500 + slip * 60, t, 0.05);
  }

  private popsCooldown = 0;
  private pops(): void {
    const now = this.eng.now;
    if (now < this.popsCooldown) return;
    this.popsCooldown = now + 0.8;
    const n = 2 + Math.floor(this.eng.random() * 3);
    for (let i = 0; i < n; i++) this.eng.play('pop', this.cfg.vehicles.playerGain * (0.5 + this.eng.random() * 0.5), 0, 0.85 + this.eng.random() * 0.3, 0.05 + i * (0.06 + this.eng.random() * 0.08));
  }

  /** A two-tone horn at a position (traffic complaining, or a future horn button). */
  horn(gain: number, pan: number, length = 0.4, pitch = 1): void {
    const ctx = this.eng.ctx;
    if (!ctx || ctx.state !== 'running' || gain < 0.003) return;
    const t = ctx.currentTime + 0.02;
    const out = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    lp.Q.value = 1.5;
    lp.connect(out).connect(p).connect(this.eng.world);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(gain * this.cfg.vehicles.hornGain, t + 0.015);
    out.gain.setValueAtTime(gain * this.cfg.vehicles.hornGain, t + length);
    out.gain.linearRampToValueAtTime(0, t + length + 0.05);
    for (const f of [392, 494]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f * pitch;
      o.detune.value = (this.eng.random() - 0.5) * 12;
      o.connect(lp);
      o.start(t);
      o.stop(t + length + 0.08);
    }
    setTimeout(() => p.disconnect(), (length + 0.3) * 1000);
  }

  /** Silence every voice (radio-style mute on game over or when audio is disabled). */
  silence(): void {
    const ctx = this.eng.ctx;
    if (!ctx) return;
    for (const v of this.voices) {
      v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      v.squealGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    }
  }
}
