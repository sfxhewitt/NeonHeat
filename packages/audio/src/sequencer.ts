/**
 * The radio's procedural composer. Pure and deterministic: a station definition plus a track index
 * always produces the same track, and a step index always produces the same notes. No Web Audio here,
 * so it is unit tested in Node; `radio.ts` turns the events into sound.
 */
import type { Section, Station } from './config';
import { Rand } from './mix';

export const STEPS_PER_BAR = 16;

export const SCALES: Record<Station['scale'], readonly number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  minorPentatonic: [0, 3, 5, 7, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
};

export type DrumPart = 'kick' | 'snare' | 'hat' | 'openHat' | 'clap' | 'perc';
export type Part = DrumPart | 'bass' | 'pad' | 'arp' | 'lead';
export const DRUM_PARTS: readonly DrumPart[] = ['kick', 'snare', 'hat', 'openHat', 'clap', 'perc'];

/** Semitones above the scale root of a (possibly negative or multi-octave) scale degree. */
export function degreeSemis(scale: readonly number[], deg: number): number {
  const n = scale.length;
  const oct = Math.floor(deg / n);
  return scale[((deg % n) + n) % n]! + 12 * oct;
}

/** Parse a step-pattern string into 16 velocities (0 = rest). */
export function parsePattern(p: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < STEPS_PER_BAR; i++) {
    const ch = p[i] ?? '.';
    out.push(ch === 'X' ? 1 : ch === 'x' ? 0.78 : ch === 'o' ? 0.42 : 0);
  }
  return out;
}

export interface BassStep {
  vel: number;
  /** Scale degrees above the current chord's root. */
  deg: number;
  oct: number;
  /** Length in steps (ties extend it). */
  len: number;
  slide: boolean;
  accent: boolean;
}

export interface LeadNote {
  step: number;
  deg: number;
  len: number;
  vel: number;
}

export interface TrackSection extends Section {
  startBar: number;
  /** Filter level the previous section ended on (sweeps glide from it). */
  fromFilter: number;
}

export interface Track {
  index: number;
  bpm: number;
  /** Seconds per sixteenth. */
  stepDur: number;
  root: number;
  bars: number;
  steps: number;
  progression: number[];
  /** Main and alternate drum bars (velocities per step). */
  drums: Record<DrumPart, { main: number[]; alt: number[] }>;
  bass: BassStep[];
  /** A two-bar motif and its answering variation. */
  lead: { a: LeadNote[]; b: LeadNote[] };
  arpOrder: number[];
  sections: TrackSection[];
  seconds: number;
}

export interface SeqEvent {
  part: Part;
  /** Pad voice index; 0 for monophonic parts and drums. */
  voice: number;
  midi: number;
  vel: number;
  /** Length in steps. */
  len: number;
  slide: boolean;
}

function trackSeed(station: Station, index: number): number {
  return (Math.imul(station.seed ^ 0x5bd1e995, 2654435761) + Math.imul(index + 1, 40503)) >>> 0;
}

/** Compose track `index` of a station. Same inputs, same track. */
export function buildTrack(station: Station, index: number): Track {
  const r = new Rand(trackSeed(station, index));
  const bpm = Math.round((station.bpm + r.range(-station.bpmJitter, station.bpmJitter)) * 10) / 10;
  const root = station.root + (index === 0 ? 0 : r.int(-station.transpose, station.transpose));
  const progression = [...r.pick(station.progressions)];
  // Occasionally rotate the progression so tracks sharing one still feel different.
  if (progression.length > 2 && r.chance(0.35)) progression.push(progression.shift()!);

  const drums = {} as Track['drums'];
  for (const part of DRUM_PARTS) {
    const variants = station.drums[part];
    const main = parsePattern(r.pick(variants));
    const alt = parsePattern(r.pick(variants));
    if (part === 'hat' || part === 'perc') {
      for (let i = 0; i < STEPS_PER_BAR; i++) {
        if (main[i] === 0 && r.chance(station.drums.ghostChance)) main[i] = 0.3;
        if (alt[i] === 0 && r.chance(station.drums.ghostChance * 1.5)) alt[i] = 0.3;
      }
    }
    drums[part] = { main, alt };
  }

  const bass = composeBass(station, r);
  const lead = composeLead(station, r);
  const arpOrder = composeArp(station, r);

  const sections: TrackSection[] = [];
  let bar = 0;
  let prevFilter = 0.2;
  for (const s of station.form) {
    const long = s.name.startsWith('main') || s.name.startsWith('drop');
    const bars = long && r.chance(0.35) ? s.bars * 2 : s.bars;
    sections.push({ ...s, bars, startBar: bar, fromFilter: prevFilter });
    prevFilter = s.filter;
    bar += bars;
  }
  const stepDur = 60 / bpm / 4;
  return {
    index,
    bpm,
    stepDur,
    root,
    bars: bar,
    steps: bar * STEPS_PER_BAR,
    progression,
    drums,
    bass,
    lead,
    arpOrder,
    sections,
    seconds: bar * STEPS_PER_BAR * stepDur,
  };
}

function composeBass(station: Station, r: Rand): BassStep[] {
  const pattern = r.pick(station.bassRhythms);
  const out: BassStep[] = [];
  for (let i = 0; i < STEPS_PER_BAR; i++) {
    const ch = pattern[i] ?? '.';
    const on = ch === 'X' || ch === 'x' || ch === '~' || ch === 'o';
    let deg = 0;
    let oct = 0;
    switch (station.bassStyle) {
      case 'root':
        deg = i % 8 === 6 && r.chance(0.5) ? 4 : 0;
        break;
      case 'octave':
        oct = i % 4 === 2 ? 1 : 0;
        break;
      case 'walk':
        deg = i === 0 ? 0 : r.pick([0, 2, 4, 4, 5, 6, -1]);
        break;
      case 'acid':
        deg = r.pick([0, 0, 0, 2, 3, 4, 6, 7]);
        oct = r.chance(0.25) ? 1 : 0;
        break;
      case 'reese':
        deg = i >= 8 && r.chance(0.3) ? r.pick([2, 4, -1]) : 0;
        break;
    }
    out.push({ vel: on ? (ch === 'X' ? 1 : ch === 'o' ? 0.5 : 0.8) : 0, deg, oct, len: 1, slide: ch === '~', accent: ch === 'X' });
  }
  // Ties: '-' extends the previous note.
  for (let i = 0; i < STEPS_PER_BAR; i++) {
    if ((pattern[i] ?? '.') !== '-') continue;
    for (let j = i - 1; j >= 0; j--) {
      if (out[j]!.vel > 0) {
        out[j]!.len++;
        break;
      }
      if ((pattern[j] ?? '.') !== '-') break;
    }
  }
  return out;
}

function composeLead(station: Station, r: Rand): Track['lead'] {
  const make = (answer: boolean): LeadNote[] => {
    const notes: LeadNote[] = [];
    let deg = r.pick([0, 2, 4, 7]);
    for (let bar = 0; bar < 2; bar++) {
      const rhythm = parsePattern(r.pick(station.leadRhythms));
      for (let i = 0; i < STEPS_PER_BAR; i++) {
        if (rhythm[i] === 0 || !r.chance(0.35 + station.leadDensity * 0.65)) continue;
        const strong = i % 4 === 0;
        // Melodic random walk; land on chord tones (0, 2, 4) on strong beats.
        deg += r.pick([-2, -1, -1, 1, 1, 2, 3, -3]);
        if (strong) deg = Math.round(deg / 2) * 2;
        deg = Math.max(-2, Math.min(9, deg));
        notes.push({ step: bar * STEPS_PER_BAR + i, deg, len: 1, vel: rhythm[i]! });
      }
    }
    if (answer && notes.length > 0) notes[notes.length - 1]!.deg = r.pick([0, 4, 7]);
    // Each note lasts until the next one (legato), capped at a half bar.
    for (let i = 0; i < notes.length; i++) {
      const next = notes[i + 1]?.step ?? 2 * STEPS_PER_BAR;
      notes[i]!.len = Math.max(1, Math.min(8, next - notes[i]!.step));
    }
    return notes;
  };
  return { a: make(false), b: make(true) };
}

function composeArp(station: Station, r: Rand): number[] {
  const tones = 4 * station.arp.octaves;
  const up = Array.from({ length: tones }, (_, i) => i);
  switch (station.arp.mode) {
    case 'up':
      return up;
    case 'down':
      return up.reverse();
    case 'updown':
      return [...up, ...up.slice(1, -1).reverse()];
    case 'random':
      return Array.from({ length: 8 }, () => r.int(0, tones - 1));
    case 'pattern': {
      const motif = [0, 2, 1, 3, 2, 4, 3, 1].map((i) => Math.min(tones - 1, i + (r.chance(0.3) ? 4 : 0)));
      return motif;
    }
  }
}

/** The section playing at a bar. */
export function sectionAt(track: Track, bar: number): TrackSection {
  const ss = track.sections;
  for (let i = ss.length - 1; i >= 0; i--) if (bar >= ss[i]!.startBar) return ss[i]!;
  return ss[0]!;
}

/** Station master filter (0..1) at a step: glides from the previous section's level over two bars. */
export function filterAt(track: Track, step: number): number {
  const bar = Math.floor(step / STEPS_PER_BAR);
  const s = sectionAt(track, bar);
  const t = Math.min(1, (step - s.startBar * STEPS_PER_BAR) / (2 * STEPS_PER_BAR));
  return s.fromFilter + (s.filter - s.fromFilter) * t;
}

/** Chord (scale degree of its root) at a bar. */
export function chordAt(station: Station, track: Track, bar: number): number {
  const i = Math.floor(bar / station.chordBars) % track.progression.length;
  return track.progression[i]!;
}

/** Close-voiced chord for the pad: four tones folded into one octave above the window floor. */
export function voiceChord(station: Station, track: Track, chordDeg: number, out: number[]): number[] {
  const scale = SCALES[station.scale];
  const floor = track.root + 12 * station.pad.octave + 3;
  out.length = 0;
  for (const k of [0, 2, 4, 6]) {
    let m = track.root + 12 * station.pad.octave + degreeSemis(scale, chordDeg + k);
    while (m < floor) m += 12;
    while (m >= floor + 12) m -= 12;
    out.push(m);
  }
  out.sort((a, b) => a - b);
  return out;
}

const chordScratch: number[] = [];

/**
 * All notes that start on step `step` of a track. Writes into `out` (cleared first) and returns it.
 * Deterministic; allocation-free apart from growing `out` the first few times.
 */
export function stepEvents(station: Station, track: Track, step: number, out: SeqEvent[]): SeqEvent[] {
  out.length = 0;
  const s = ((step % track.steps) + track.steps) % track.steps;
  const bar = Math.floor(s / STEPS_PER_BAR);
  const i = s % STEPS_PER_BAR;
  const sec = sectionAt(track, bar);
  const barInSec = bar - sec.startBar;
  const lastBar = barInSec === sec.bars - 1;
  const has = (p: Part): boolean => sec.layers.includes(p);
  const scale = SCALES[station.scale];
  const chordDeg = chordAt(station, track, bar);
  const push = (part: Part, vel: number, midi = 0, len = 1, slide = false, voice = 0): void => {
    out.push({ part, voice, midi, vel, len, slide });
  };

  // Drums. Fill bars hand the second half to a snare roll.
  const fill = sec.fill && lastBar && i >= 8;
  for (const part of DRUM_PARTS) {
    if (!has(part)) continue;
    if (fill && part !== 'kick' && part !== 'openHat') continue;
    const pat = barInSec % 4 === 3 ? track.drums[part].alt : track.drums[part].main;
    const v = pat[i]!;
    if (v > 0) push(part, v);
  }
  if (fill && (has('snare') || has('clap'))) {
    const roll = i >= 12 ? 1 : i % 2 === 0 ? 1 : 0;
    if (roll) push('snare', 0.45 + ((i - 8) / 8) * 0.55);
  }

  // Pad: new chord on each chord change.
  if (has('pad') && i === 0 && bar % station.chordBars === 0) {
    const voicing = voiceChord(station, track, chordDeg, chordScratch);
    const len = station.chordBars * STEPS_PER_BAR;
    for (let v = 0; v < voicing.length; v++) push('pad', 0.8, voicing[v]!, len, false, v);
  }

  // Bass.
  if (has('bass')) {
    const b = track.bass[i]!;
    if (b.vel > 0) {
      const midi = track.root + 12 * station.bass.octave + degreeSemis(scale, chordDeg + b.deg) + 12 * b.oct;
      push('bass', b.accent ? 1 : b.vel, midi, b.len, b.slide);
    }
  }

  // Arp: chord tones in the track's order.
  if (has('arp') && i % station.arp.rate === 0) {
    const n = Math.floor(s / station.arp.rate);
    const idx = track.arpOrder[n % track.arpOrder.length]!;
    const tone = [0, 2, 4, 6][idx % 4]!;
    const oct = Math.floor(idx / 4);
    const midi = track.root + 12 * station.arpSynth.octave + degreeSemis(scale, chordDeg + tone) + 12 * oct;
    push('arp', i % 4 === 0 ? 1 : 0.7, midi, station.arp.rate);
  }

  // Lead: the motif, answered by its variation every other phrase.
  if (has('lead')) {
    const phrase = Math.floor(barInSec / 2);
    const motif = phrase % 2 === 0 ? track.lead.a : track.lead.b;
    const local = (bar % 2) * STEPS_PER_BAR + i;
    for (const n of motif) {
      if (n.step !== local) continue;
      const midi = track.root + 12 * station.lead.octave + degreeSemis(scale, chordDeg + n.deg);
      push('lead', n.vel, midi, n.len);
    }
  }
  return out;
}

export interface Timeline {
  station: Station;
  tracks: Track[];
  starts: number[];
  seconds: number;
}

export function buildTimeline(station: Station): Timeline {
  const tracks: Track[] = [];
  const starts: number[] = [];
  let t = 0;
  for (let i = 0; i < station.tracks; i++) {
    const tr = buildTrack(station, i);
    starts.push(t);
    tracks.push(tr);
    t += tr.seconds;
  }
  return { station, tracks, starts, seconds: t };
}

export interface Cursor {
  track: number;
  step: number;
  /** Station-time (seconds) the step starts at, before swing. */
  time: number;
}

/** Where a station is at station-time t (it loops through its tracks for ever). */
export function locate(tl: Timeline, t: number, out: Cursor = { track: 0, step: 0, time: 0 }): Cursor {
  const loops = Math.floor(t / tl.seconds);
  const local = t - loops * tl.seconds;
  let k = 0;
  while (k + 1 < tl.tracks.length && tl.starts[k + 1]! <= local) k++;
  const tr = tl.tracks[k]!;
  const step = Math.min(tr.steps - 1, Math.floor((local - tl.starts[k]!) / tr.stepDur));
  out.track = k;
  out.step = step;
  out.time = loops * tl.seconds + tl.starts[k]! + step * tr.stepDur;
  return out;
}

/** Move a cursor on by one step, rolling into the next track. */
export function advance(tl: Timeline, c: Cursor): Cursor {
  const tr = tl.tracks[c.track]!;
  c.time += tr.stepDur;
  c.step++;
  if (c.step >= tr.steps) {
    c.step = 0;
    c.track = (c.track + 1) % tl.tracks.length;
  }
  return c;
}

/** Swing offset (seconds) for a step: off-beat sixteenths are pushed late. */
export function swingOffset(station: Station, track: Track, step: number): number {
  return step % 2 === 1 ? station.swing * track.stepDur : 0;
}

export interface IdentNote {
  /** Seconds from the ident's start. */
  at: number;
  midi: number;
  len: number;
  vel: number;
}

/** The station's jingle: a short seeded figure over its home chord, ending on a held chord. */
export function identNotes(station: Station): IdentNote[] {
  const r = new Rand(station.seed ^ 0xa11ce);
  const scale = SCALES[station.scale];
  const beat = 60 / station.bpm / 2;
  const base = station.root + 12 * (station.lead.octave >= 1 ? 1 : 2) - 12;
  const notes: IdentNote[] = [];
  const shape = r.pick([
    [0, 2, 4, 7],
    [0, 4, 2, 7],
    [4, 2, 0, 7],
    [0, 1, 2, 4],
    [7, 4, 2, 0],
  ]);
  let at = 0;
  for (const d of shape) {
    notes.push({ at, midi: base + degreeSemis(scale, d), len: beat * 0.9, vel: 0.8 });
    at += beat * r.pick([0.5, 0.5, 1]);
  }
  for (const d of [0, 2, 4]) notes.push({ at, midi: base + degreeSemis(scale, d) - 12, len: beat * 3, vel: 0.6 });
  notes.push({ at, midi: base + 12, len: beat * 3, vel: 0.5 });
  return notes;
}
