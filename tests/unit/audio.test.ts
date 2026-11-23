import { describe, expect, it } from 'vitest';
import { rawContent } from '@neonheat/content';
import {
  Rand,
  STEPS_PER_BAR,
  SHOTS,
  advance,
  allocateVoices,
  buildTimeline,
  buildTrack,
  distanceGain,
  dopplerFactor,
  engineHz,
  gearFor,
  identNotes,
  impactLevel,
  locate,
  parseAudioConfig,
  renderChatter,
  renderCrowdLoop,
  renderCrunch,
  renderExplosion,
  renderGlass,
  renderKick,
  renderRainLoop,
  renderShot,
  renderVocal,
  sectionAt,
  sirenHz,
  stepEvents,
  type SeqEvent,
  type VoiceCandidate,
} from '@neonheat/audio';

const cfg = parseAudioConfig(structuredClone(rawContent.audio));

describe('audio content', () => {
  it('validates audio.json', () => {
    expect(cfg.radio.stations.length).toBeGreaterThanOrEqual(4);
    expect(new Set(cfg.radio.stations.map((s) => s.id)).size).toBe(cfg.radio.stations.length);
  });

  it('gives every vehicle variant an engine class', () => {
    for (const id of Object.keys(rawContent.vehicles.variants)) expect(cfg.vehicles.variantClass[id], id).toBeDefined();
  });

  it('rejects a bad step pattern with a readable error', () => {
    const bad = structuredClone(rawContent.audio) as { radio: { stations: { drums: { kick: string[] } }[] } };
    bad.radio.stations[0]!.drums.kick = ['X...X'];
    expect(() => parseAudioConfig(bad)).toThrow(/audio\.json: radio\.stations\.0\.drums\.kick/);
  });
});

describe('sequencer', () => {
  const station = cfg.radio.stations[0]!;

  it('composes the same track from the same seed', () => {
    expect(buildTrack(station, 2)).toEqual(buildTrack(station, 2));
    const a: SeqEvent[] = [];
    const b: SeqEvent[] = [];
    const t1 = buildTrack(station, 1);
    const t2 = buildTrack(station, 1);
    for (let s = 0; s < t1.steps; s += 7) expect(stepEvents(station, t1, s, a).map((e) => ({ ...e }))).toEqual(stepEvents(station, t2, s, b).map((e) => ({ ...e })));
  });

  it('gives tracks of a station distinct material, and stations distinct styles', () => {
    const tracks = Array.from({ length: station.tracks }, (_, i) => buildTrack(station, i));
    const fingerprints = new Set(tracks.map((t) => JSON.stringify([t.bpm, t.root, t.progression, t.bass, t.lead.a])));
    expect(fingerprints.size).toBe(tracks.length);
    const bpms = cfg.radio.stations.map((s) => buildTrack(s, 0).bpm);
    expect(new Set(bpms).size).toBe(bpms.length);
  });

  it('changes when the seed changes', () => {
    const other = { ...station, seed: station.seed + 1 };
    expect(JSON.stringify(buildTrack(other, 0))).not.toEqual(JSON.stringify(buildTrack(station, 0)));
  });

  it('follows the form: sections tile the track and layers gate parts', () => {
    for (const st of cfg.radio.stations) {
      const tr = buildTrack(st, 0);
      let bar = 0;
      for (const s of tr.sections) {
        expect(s.startBar).toBe(bar);
        bar += s.bars;
      }
      expect(bar).toBe(tr.bars);
      const out: SeqEvent[] = [];
      for (let step = 0; step < tr.steps; step++) {
        const sec = sectionAt(tr, Math.floor(step / STEPS_PER_BAR));
        for (const e of stepEvents(st, tr, step, out)) {
          expect(sec.layers.includes(e.part) || (e.part === 'snare' && sec.fill), `${st.id} ${sec.name} ${e.part}`).toBe(true);
          expect(e.vel).toBeGreaterThan(0);
          expect(e.vel).toBeLessThanOrEqual(1);
          if (e.part === 'bass' || e.part === 'lead' || e.part === 'arp' || e.part === 'pad') {
            expect(e.midi).toBeGreaterThan(20);
            expect(e.midi).toBeLessThan(110);
          }
        }
      }
    }
  });

  it('keeps every note in the station scale', () => {
    const st = cfg.radio.stations.find((s) => s.scale === 'phrygian') ?? station;
    const tr = buildTrack(st, 0);
    const scale = { minor: [0, 2, 3, 5, 7, 8, 10], phrygian: [0, 1, 3, 5, 7, 8, 10] }[st.scale as 'minor' | 'phrygian'] ?? [0, 2, 3, 5, 7, 8, 10];
    const out: SeqEvent[] = [];
    for (let step = 0; step < tr.steps; step++) {
      for (const e of stepEvents(st, tr, step, out)) {
        if (e.midi === 0) continue;
        expect(scale).toContain((((e.midi - tr.root) % 12) + 12) % 12);
      }
    }
  });

  it('locates and advances through a looping timeline consistently', () => {
    const tl = buildTimeline(station);
    const c = locate(tl, 0);
    expect(c).toEqual({ track: 0, step: 0, time: 0 });
    // Walking step by step agrees with locating directly.
    for (let i = 0; i < 2000; i++) advance(tl, c);
    const d = locate(tl, c.time + 1e-6);
    expect(d.track).toBe(c.track);
    expect(d.step).toBe(c.step);
    // Loops for ever.
    const wrapped = locate(tl, tl.seconds * 3 + 1);
    const first = locate(tl, 1);
    expect(wrapped.track).toBe(first.track);
    expect(wrapped.step).toBe(first.step);
  });

  it('writes a short, deterministic ident for each station', () => {
    for (const st of cfg.radio.stations) {
      const a = identNotes(st);
      expect(a).toEqual(identNotes(st));
      expect(a.length).toBeGreaterThan(3);
      expect(Math.max(...a.map((n) => n.at + n.len))).toBeLessThan(cfg.radio.identSec + 1.5);
    }
  });
});

describe('mixing maths', () => {
  const L = cfg.listener;

  it('never gets louder with distance, and is silent past the max', () => {
    let prev = Infinity;
    for (let d = 0; d <= L.maxDistance + 10; d += 0.5) {
      const g = distanceGain(d, L);
      expect(g).toBeLessThanOrEqual(prev + 1e-12);
      prev = g;
    }
    expect(distanceGain(0, L)).toBeCloseTo(1);
    expect(distanceGain(L.maxDistance, L)).toBe(0);
  });

  it('maps engine rpm to pitch monotonically, and speed to rpm monotonically within each gear', () => {
    for (const [name, cls] of Object.entries(cfg.vehicles.classes)) {
      let prev = -Infinity;
      for (let r = 0; r <= 1; r += 0.01) {
        const hz = engineHz(cls, r);
        expect(hz, name).toBeGreaterThan(prev);
        prev = hz;
      }
      expect(engineHz(cls, 0)).toBeCloseTo(cls.idleHz);
      expect(engineHz(cls, 1)).toBeCloseTo(cls.redlineHz);
      const g = { gear: 1, rpm: 0 };
      let last = { gear: 1, rpm: 0 };
      let shifts = 0;
      for (let s = 0; s <= 40; s += 0.1) {
        gearFor(s, 40, cls, g);
        expect(g.gear).toBeGreaterThanOrEqual(last.gear);
        if (g.gear === last.gear) expect(g.rpm).toBeGreaterThanOrEqual(last.rpm - 1e-9);
        else {
          shifts++;
          // An upshift drops the revs.
          expect(g.rpm).toBeLessThan(last.rpm);
        }
        last = { ...g };
      }
      expect(shifts).toBe(cls.gears - 1);
    }
  });

  it('never allocates more voices than the cap, keeps the player, and does not flicker', () => {
    const r = new Rand(3);
    const slots = new Array<number>(cfg.vehicles.maxVoices).fill(-1);
    for (let frame = 0; frame < 500; frame++) {
      const cands: VoiceCandidate[] = Array.from({ length: r.int(0, 30) }, (_, i) => ({ id: i, dist: r.range(0, 200), pinned: false }));
      if (cands.length > 0) cands[0]!.pinned = true;
      const used = allocateVoices(cands, slots, cfg.vehicles.maxVoices, 5, 110);
      expect(used).toBeLessThanOrEqual(cfg.vehicles.maxVoices);
      const live = slots.filter((s) => s >= 0);
      expect(new Set(live).size).toBe(live.length);
      if (cands.length > 0) expect(slots).toContain(0);
      for (const id of live) expect(cands.find((c) => c.id === id)!.dist < 110 || id === 0).toBe(true);
    }
    // Hysteresis: a car slightly closer than a playing one does not steal its voice.
    const s2 = [-1];
    allocateVoices([{ id: 1, dist: 20, pinned: false }], s2, 1, 5, 110);
    allocateVoices([{ id: 1, dist: 20, pinned: false }, { id: 2, dist: 17, pinned: false }], s2, 1, 5, 110);
    expect(s2[0]).toBe(1);
    allocateVoices([{ id: 1, dist: 20, pinned: false }, { id: 2, dist: 10, pinned: false }], s2, 1, 5, 110);
    expect(s2[0]).toBe(2);
  });

  it('raises the pitch of approaching sources and lowers receding ones', () => {
    expect(dopplerFactor(50, 0, -30, 0, L)).toBeGreaterThan(1);
    expect(dopplerFactor(50, 0, 30, 0, L)).toBeLessThan(1);
    expect(dopplerFactor(50, 0, 0, 30, L)).toBeCloseTo(1);
  });

  it('sweeps sirens inside their range', () => {
    for (const mode of ['wail', 'yelp'] as const) {
      for (let t = 0; t < 10; t += 0.013) {
        const f = sirenHz(mode, t, cfg.police);
        expect(f).toBeGreaterThanOrEqual(cfg.police.wailLowHz - 1e-6);
        expect(f).toBeLessThanOrEqual(cfg.police.wailHighHz + 1e-6);
      }
    }
  });

  it('maps impact strength to a clamped level', () => {
    expect(impactLevel(0, 1.5, 22)).toBe(0);
    expect(impactLevel(100, 1.5, 22)).toBe(1);
    expect(impactLevel(10, 1.5, 22)).toBeGreaterThan(impactLevel(5, 1.5, 22));
  });
});

describe('offline DSP', () => {
  const sr = 16000;
  const sane = (buf: Float32Array): void => {
    let peak = 0;
    let energy = 0;
    for (const v of buf) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
      energy += v * v;
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(energy / buf.length).toBeGreaterThan(1e-5);
  };

  it('renders finite, non-silent, unclipped sounds', () => {
    const r = new Rand(9);
    for (const recipe of Object.values(SHOTS)) sane(renderShot(sr, recipe, r));
    sane(renderKick(sr, cfg.radio.stations[0]!.kit, r));
    sane(renderCrunch(sr, r, 1));
    sane(renderGlass(sr, r, 0.5));
    sane(renderExplosion(sr, r, 1));
    for (const k of ['scream', 'yelp', 'hey', 'ow', 'hurt'] as const) sane(renderVocal(sr, r, k));
    sane(renderChatter(sr, r));
    sane(renderRainLoop(sr, r, 1));
    sane(renderCrowdLoop(sr, r, 1, 2));
  });

  it('is deterministic per seed', () => {
    expect(renderShot(sr, SHOTS.pistol!, new Rand(4))).toEqual(renderShot(sr, SHOTS.pistol!, new Rand(4)));
    expect(renderShot(sr, SHOTS.pistol!, new Rand(4))).not.toEqual(renderShot(sr, SHOTS.pistol!, new Rand(5)));
  });

  it('makes loops that join without a click', () => {
    const loop = renderRainLoop(sr, new Rand(2), 1);
    const jump = Math.abs(loop[0]! - loop[loop.length - 1]!);
    expect(jump).toBeLessThan(0.5);
  });
});
