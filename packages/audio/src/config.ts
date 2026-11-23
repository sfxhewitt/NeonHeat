import { z } from 'zod';

/**
 * Every tunable of the sound layer. Authored in content/data/audio.json and validated here.
 * Synthesis recipes live in code; levels, voice counts, ranges and the radio stations live in data.
 */

const Gain = z.number().min(0).max(4);

export const EngineClassSchema = z.object({
  /** Crank-rotation frequency at idle and at the redline (Hz). Firing harmonics sit above it. */
  idleHz: z.number().positive(),
  redlineHz: z.number().positive(),
  gears: z.number().int().min(1).max(8),
  /** Normalised rpm each gear above first starts at after an upshift (0..1). */
  shiftDropRpm: z.number().min(0).max(0.95),
  /** Harmonic weights of the engine's periodic wave, fundamental first. Shapes the character. */
  harmonics: z.array(z.number()).min(2).max(32),
  /** Low-pass cutoff at idle and at full load and revs (Hz). */
  cutoffIdle: z.number().positive(),
  cutoffMax: z.number().positive(),
  resonance: z.number().min(0).max(30),
  /** Sub-octave sine level (body) and detuned second oscillator level (width). */
  sub: Gain,
  detuneCents: z.number().min(0).max(60),
  detuneLevel: Gain,
  /** Rough intake/exhaust noise level. */
  noise: Gain,
  /** Electric or supercharger whine: frequency ratio over crank Hz (0 = none) and level. */
  whineRatio: z.number().min(0),
  whineLevel: Gain,
  /** Exhaust pops on lift-off at high revs. */
  pops: z.boolean(),
  gain: Gain,
});
export type EngineClass = z.infer<typeof EngineClassSchema>;

export const PartSynthSchema = z.object({
  wave: z.enum(['sine', 'square', 'sawtooth', 'triangle']),
  octave: z.number().int().min(-3).max(3),
  gain: Gain,
  cutoff: z.number().positive(),
  resonance: z.number().min(0).max(30),
  /** Filter envelope depth in Hz added at note start, decaying with `decay`. */
  envAmount: z.number().min(0),
  attack: z.number().min(0.001),
  decay: z.number().min(0.005),
  sustain: z.number().min(0).max(1),
  release: z.number().min(0.005),
  detuneCents: z.number().min(0).max(50),
  /** Send to the shared reverb and to the tempo delay. */
  reverb: z.number().min(0).max(1),
  delay: z.number().min(0).max(1),
});
export type PartSynth = z.infer<typeof PartSynthSchema>;

export const DrumKitSchema = z.object({
  kickStartHz: z.number().positive(),
  kickEndHz: z.number().positive(),
  kickPitchDecay: z.number().positive(),
  kickDecay: z.number().positive(),
  kickDrive: z.number().min(0).max(10),
  kickClick: z.number().min(0).max(1),
  snareToneHz: z.number().positive(),
  snareDecay: z.number().positive(),
  snareNoiseHz: z.number().positive(),
  snareSnap: z.number().min(0).max(1),
  hatDecay: z.number().positive(),
  openHatDecay: z.number().positive(),
  hatHz: z.number().positive(),
  clapDecay: z.number().positive(),
  percHz: z.number().positive(),
  /** Bit-crush / lo-fi amount, 0 = clean. */
  crush: z.number().min(0).max(1),
  gains: z.object({ kick: Gain, snare: Gain, hat: Gain, openHat: Gain, clap: Gain, perc: Gain }),
  reverb: z.number().min(0).max(1),
});
export type DrumKit = z.infer<typeof DrumKitSchema>;

/** Step-pattern strings: 16 characters per bar. X accent, x hit, o ghost, . rest. */
const Pattern = z.string().regex(/^[Xxo.\-~]{16}$/);

export const SectionSchema = z.object({
  name: z.string(),
  bars: z.number().int().min(1).max(64),
  /** Parts playing in this section. */
  layers: z.array(z.enum(['kick', 'snare', 'hat', 'openHat', 'clap', 'perc', 'bass', 'pad', 'arp', 'lead'])),
  /** Master filter of the station, 0..1 of its open range (builds and breakdowns). */
  filter: z.number().min(0).max(1),
  /** Add a drum fill on the last bar. */
  fill: z.boolean().default(false),
});
export type Section = z.infer<typeof SectionSchema>;

export const StationSchema = z.object({
  id: z.string(),
  name: z.string(),
  frequency: z.string(),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  seed: z.number().int(),
  tracks: z.number().int().min(1).max(16),
  bpm: z.number().min(50).max(200),
  /** Each track moves the tempo by up to this many BPM, seeded. */
  bpmJitter: z.number().min(0).max(20),
  /** MIDI note of the station's home key and how far tracks may transpose from it (semitones). */
  root: z.number().int().min(24).max(72),
  transpose: z.number().int().min(0).max(7),
  scale: z.enum(['minor', 'dorian', 'phrygian', 'major', 'mixolydian', 'harmonicMinor', 'minorPentatonic', 'majorPentatonic']),
  /** Chord progressions as scale degrees (0-based), one chord per `chordBars` bars. */
  progressions: z.array(z.array(z.number().int().min(0).max(6)).min(1).max(8)).min(1),
  chordBars: z.number().int().min(1).max(4),
  swing: z.number().min(0).max(0.5),
  drums: z.object({
    kick: z.array(Pattern).min(1),
    snare: z.array(Pattern).min(1),
    hat: z.array(Pattern).min(1),
    openHat: z.array(Pattern).min(1),
    clap: z.array(Pattern).min(1),
    perc: z.array(Pattern).min(1),
    /** Chance per empty sixteenth of a seeded ghost hat or perc hit. */
    ghostChance: z.number().min(0).max(1),
  }),
  bassRhythms: z.array(Pattern).min(1),
  /** How the bass picks notes: root-heavy, octave bounce, walking through chord tones, or acid lines. */
  bassStyle: z.enum(['root', 'octave', 'walk', 'acid', 'reese']),
  arp: z.object({
    mode: z.enum(['up', 'down', 'updown', 'random', 'pattern']),
    /** Steps per arp note (1 = sixteenths, 2 = eighths). */
    rate: z.number().int().min(1).max(4),
    octaves: z.number().int().min(1).max(3),
  }),
  leadRhythms: z.array(Pattern).min(1),
  /** Note density of the lead motif, 0..1. */
  leadDensity: z.number().min(0).max(1),
  form: z.array(SectionSchema).min(1),
  kit: DrumKitSchema,
  bass: PartSynthSchema,
  pad: PartSynthSchema,
  arpSynth: PartSynthSchema,
  lead: PartSynthSchema,
  /** Station-wide character: master low-pass range (Hz), vinyl crackle, tape wobble depth (cents), side-chain pump. */
  filterMin: z.number().positive(),
  filterMax: z.number().positive(),
  crackle: Gain,
  wobbleCents: z.number().min(0).max(60),
  pump: z.number().min(0).max(1),
  delayBeats: z.number().positive(),
  delayFeedback: z.number().min(0).max(0.9),
  gain: Gain,
});
export type Station = z.infer<typeof StationSchema>;

export const AudioConfigSchema = z.object({
  buses: z.object({
    master: Gain,
    music: Gain,
    sfx: Gain,
    ui: Gain,
    ambience: Gain,
    reverbReturn: Gain,
    compressor: z.object({
      threshold: z.number().max(0),
      knee: z.number().min(0).max(40),
      ratio: z.number().min(1).max(20),
      attack: z.number().min(0).max(1),
      release: z.number().min(0).max(1),
    }),
    /** Brick-wall-ish limiter after the compressor (dB). */
    limiterThreshold: z.number().max(0),
    /** Master high-pass: sub-bass phones cannot play only eats headroom (Hz). */
    highpassHz: z.number().min(10).max(200),
    reverbSeconds: z.number().min(0.2).max(6),
    /** When paused: music level multiplier and low-pass cutoff (Hz). */
    pausedMusic: z.number().min(0).max(1),
    pausedCutoff: z.number().positive(),
    /** Music ducking under stings and explosions. */
    duckAmount: z.number().min(0).max(1),
    duckRelease: z.number().positive(),
  }),
  listener: z.object({
    refDistance: z.number().positive(),
    maxDistance: z.number().positive(),
    rolloff: z.number().min(0),
    panWidth: z.number().positive(),
    maxPan: z.number().min(0).max(1),
    speedOfSound: z.number().positive(),
    dopplerScale: z.number().min(0),
  }),
  vehicles: z.object({
    maxVoices: z.number().int().min(1).max(16),
    /** Metres closer a new car must be before it steals a voice from a playing one. */
    hysteresis: z.number().min(0),
    playerGain: Gain,
    otherGain: Gain,
    idleGain: Gain,
    /** Exponential smoothing rate of engine rpm (1/s) and the gear-shift throttle cut (s). */
    rpmRate: z.number().positive(),
    shiftCutSec: z.number().min(0).max(0.5),
    /** Lateral slip (m/s) where tyre squeal starts and where it is at full level. */
    squealSlipMin: z.number().min(0),
    squealSlipFull: z.number().positive(),
    squealGain: Gain,
    hornGain: Gain,
    defaultClass: z.string(),
    /** Vehicle variant id -> engine class. */
    variantClass: z.record(z.string(), z.string()),
    classes: z.record(z.string(), EngineClassSchema),
  }),
  impacts: z.object({
    minStrength: z.number().min(0),
    fullStrength: z.number().positive(),
    glassStrength: z.number().positive(),
    cooldownSec: z.number().min(0),
    gain: Gain,
    kerbGain: Gain,
    kerbMinStrength: z.number().min(0),
    explosionGain: Gain,
    propGain: Gain,
    bodyGain: Gain,
  }),
  weapons: z.object({
    gain: Gain,
    /** Per-weapon level multipliers; unknown weapons use `pistol`. */
    levels: z.record(z.string(), Gain),
    bulletHitGain: Gain,
    ricochetChance: z.number().min(0).max(1),
  }),
  police: z.object({
    sirenGain: Gain,
    maxSirens: z.number().int().min(0).max(8),
    wailLowHz: z.number().positive(),
    wailHighHz: z.number().positive(),
    wailPeriod: z.number().positive(),
    yelpPeriod: z.number().positive(),
    /** Closer than this a unit switches from wail to yelp (m); hysteresis in metres. */
    yelpDistance: z.number().min(0),
    yelpHysteresis: z.number().min(0),
    droneMinHeat: z.number().int().min(1),
    droneGain: Gain,
    droneHz: z.number().positive(),
    chatterMinHeat: z.number().int().min(0),
    chatterGain: Gain,
    chatterIntervalMin: z.number().positive(),
    chatterIntervalMax: z.number().positive(),
  }),
  ambience: z.object({
    rainGain: Gain,
    rainInCarCutoff: z.number().positive(),
    humGain: Gain,
    distantSirenGain: Gain,
    distantSirenIntervalMin: z.number().positive(),
    distantSirenIntervalMax: z.number().positive(),
    distantHornChance: z.number().min(0).max(1),
    crowdGain: Gain,
    crowdRadius: z.number().positive(),
    crowdFull: z.number().positive(),
    screamGain: Gain,
    screamCooldownSec: z.number().min(0),
    footstepGain: Gain,
    footstepStride: z.number().positive(),
    fireGain: Gain,
  }),
  ui: z.object({
    gain: Gain,
    stingGain: Gain,
  }),
  sfx: z.object({
    /** Hard cap on simultaneous one-shot voices; the quietest-oldest is dropped. */
    maxOneShots: z.number().int().min(4).max(64),
    /** Variants rendered per one-shot recipe. */
    variants: z.number().int().min(1).max(6),
  }),
  radio: z.object({
    lookaheadSec: z.number().min(0.05).max(1),
    identSec: z.number().min(0).max(5),
    staticSec: z.number().min(0).max(2),
    fadeSec: z.number().min(0.01).max(3),
    defaultStation: z.number().int().min(-1),
    stations: z.array(StationSchema).min(1),
  }),
});
export type AudioConfig = z.infer<typeof AudioConfigSchema>;

export function parseAudioConfig(raw: unknown): AudioConfig {
  const r = AudioConfigSchema.safeParse(raw);
  if (!r.success) throw new Error(`audio.json: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const c = r.data;
  for (const [variant, cls] of Object.entries(c.vehicles.variantClass)) {
    if (!(cls in c.vehicles.classes)) throw new Error(`audio.json: variant ${variant} uses unknown engine class ${cls}`);
  }
  if (!(c.vehicles.defaultClass in c.vehicles.classes)) throw new Error('audio.json: defaultClass must be a known engine class');
  return c;
}
