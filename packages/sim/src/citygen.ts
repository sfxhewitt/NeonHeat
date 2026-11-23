import { z } from 'zod';
import { Rng } from './rng';

/**
 * Vey City generator. A compact, designer-authored spec (content/map/city.json:
 * avenues, the river and bridges, districts with their block sizes, heights,
 * densities and style, landmark placement) becomes a full map: road segments,
 * blocks, buildings, parks, yards, water, street furniture, named markers and
 * parked-car spots. Deterministic: the same spec always gives the same city.
 */

const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const DistrictStyleSchema = z.enum(['towers', 'market', 'housing', 'docks', 'industrial']);
export type DistrictStyle = z.infer<typeof DistrictStyleSchema>;

export const CitySpecSchema = z.object({
  id: z.string(),
  seed: z.number().int(),
  /** Half the map size: the city spans -half..half on both axes. */
  half: z.number().positive(),
  wallThickness: z.number().positive(),
  roads: z.object({
    avenue: z.number().positive(),
    street: z.number().positive(),
    alley: z.number().positive(),
    kerbHeight: z.number().nonnegative(),
    lampInset: z.number().nonnegative(),
    lampSpacing: z.number().positive(),
    /** Pavement width inside each block before building lots start. */
    pavement: z.number().positive(),
  }),
  /** Avenue lines running north-south (constant x) and east-west (constant z). */
  avenuesX: z.array(z.number()).min(2),
  avenuesZ: z.array(z.number()).min(2),
  river: z.object({ z0: z.number(), z1: z.number(), bankZ0: z.number(), bankZ1: z.number(), bridgesX: z.array(z.number()).min(1) }),
  districts: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z]+$/),
        name: z.string(),
        colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        rects: z.array(Rect).min(1),
        style: DistrictStyleSchema,
        block: z.tuple([z.number().positive(), z.number().positive()]),
        height: z.tuple([z.number().positive(), z.number().positive()]),
        /** Chance a building is a tall one (height × 1.6–2.6). */
        tall: z.number().min(0).max(1),
        alley: z.number().min(0).max(1),
        park: z.number().min(0).max(1),
        lot: z.number().min(0).max(1),
        /** Kerbside furniture per 100 m of kerb. */
        props: z.number().nonnegative(),
        /** Parked cars per 100 m of kerb (streets only). */
        parked: z.number().nonnegative(),
        /** Vehicle district hint (vehicles.json `districts`) that traffic favours here. */
        trafficHint: z.string().default(''),
      }),
    )
    .min(1),
  /** Landmark markers: which district and what kind of spot. */
  landmarks: z.record(
    z.string(),
    z.object({
      district: z.string(),
      spot: z.enum(['door', 'lot', 'park', 'road', 'bridge', 'promenade', 'edge']),
      index: z.number().int().optional(),
      /** A drive-in workshop (respray, chop shop) behind the marker, its door facing the nearest road: width along the front, depth, height. */
      garage: z.object({ w: z.number().positive(), d: z.number().positive(), h: z.number().positive() }).optional(),
    }),
  ),
  /** Pickups placed per district: kind -> count. */
  pickups: z.record(z.string(), z.number().int().nonnegative()),
  parkedVariants: z.array(z.string()).min(1),
});
export type CitySpec = z.infer<typeof CitySpecSchema>;

export type RoadKind = 'avenue' | 'street' | 'alley' | 'bridge';

export interface RoadSegment {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  width: number;
  kind: RoadKind;
}

export type BlockKind = 'built' | 'park' | 'lot' | 'promenade' | 'fringe';

export interface CityBlock {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  district: string;
  kind: BlockKind;
}

export interface Building {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  /** District index (for tint) and style. */
  district?: number;
}

export interface GeneratedMap {
  id: string;
  size: [number, number];
  roads: {
    segments: RoadSegment[];
    width: number;
    laneOffset: number;
    extent: number;
    kerbHeight: number;
    lampInset: number;
    lampSpacing: number;
  };
  wallThickness: number;
  buildings: Building[];
  props: { kind: string; x: number; z: number; yaw: number }[];
  markers: Record<string, { pos: [number, number, number] }>;
  spawns: Record<string, { variant: string; pos: [number, number, number]; yaw: number; locked: boolean }>;
  traffic: { loops: { id: string; points: [number, number][] }[] };
  blocks: CityBlock[];
  water: { x: number; z: number; w: number; d: number }[];
  districts: { id: string; name: string; colour: string; style: string; trafficHint: string; rects: [number, number, number, number][] }[];
  parking: { x: number; z: number; yaw: number; variant: string }[];
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Positions between a and b (exclusive) with gaps in [min, max]; the last gap is at least min. */
function splits(rng: Rng, a: number, b: number, min: number, max: number): number[] {
  const out: number[] = [];
  let p = a;
  for (;;) {
    const remaining = b - p;
    if (remaining < max + min * 0.5) {
      if (remaining > max * 1.15 && remaining > 2 * min) out.push(Math.round(p + remaining / 2));
      break;
    }
    p += rng.range(min, max);
    out.push(Math.round(p));
  }
  return out;
}

interface Line {
  /** 'x': a north-south road at x = at, spanning z from a to b. 'z': east-west at z = at, spanning x. */
  axis: 'x' | 'z';
  at: number;
  a: number;
  b: number;
  width: number;
  kind: RoadKind;
}

/** Index of the district containing (x, z), or -1 (rivers, ring roads). */
export function districtAt(map: { districts: { rects: [number, number, number, number][] }[] }, x: number, z: number): number {
  for (let i = 0; i < map.districts.length; i++) {
    for (const r of map.districts[i]!.rects) if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return i;
  }
  return -1;
}

export function generateCity(spec: CitySpec): GeneratedMap {
  const rng = new Rng(spec.seed);
  const H = spec.half;
  const R = spec.roads;
  const ring = Math.max(...spec.avenuesX.map(Math.abs));
  const lines: Line[] = [];
  const { river } = spec;
  // Avenues. North-south avenues stop at the river except where a bridge carries them.
  for (const x of spec.avenuesX) {
    if (river.bridgesX.includes(x)) lines.push({ axis: 'x', at: x, a: -ring, b: ring, width: R.avenue, kind: 'avenue' });
    else {
      lines.push({ axis: 'x', at: x, a: -ring, b: river.bankZ0, width: R.avenue, kind: 'avenue' });
      lines.push({ axis: 'x', at: x, a: river.bankZ1, b: ring, width: R.avenue, kind: 'avenue' });
    }
  }
  for (const z of spec.avenuesZ) lines.push({ axis: 'z', at: z, a: -ring, b: ring, width: R.avenue, kind: 'avenue' });

  // District streets: each district rectangle is bounded by avenues; streets span it, making T-junctions.
  const blocks: CityBlock[] = [];
  const districtIndex = new Map(spec.districts.map((d, i) => [d.id, i]));
  for (const d of spec.districts) {
    for (const [x0, z0, x1, z1] of d.rects) {
      // Avenues running through the district split it first; streets fill each part.
      const cut = (a: number, b: number, avenues: number[]): { streets: number[]; all: number[] } => {
        const fixed = [a, ...avenues.filter((v) => v > a + 1 && v < b - 1).sort((p, q) => p - q), b];
        const streets: number[] = [];
        for (let i = 0; i < fixed.length - 1; i++) streets.push(...splits(rng, fixed[i]!, fixed[i + 1]!, d.block[0], d.block[1]));
        return { streets, all: [...new Set([...fixed, ...streets])].sort((p, q) => p - q) };
      };
      const X = cut(x0, x1, spec.avenuesX);
      const Z = cut(z0, z1, spec.avenuesZ);
      for (const x of X.streets) lines.push({ axis: 'x', at: x, a: z0, b: z1, width: R.street, kind: 'street' });
      for (const z of Z.streets) lines.push({ axis: 'z', at: z, a: x0, b: x1, width: R.street, kind: 'street' });
      const cx = X.all;
      const cz = Z.all;
      for (let i = 0; i < cx.length - 1; i++) {
        for (let j = 0; j < cz.length - 1; j++) {
          blocks.push({ x0: cx[i]!, z0: cz[j]!, x1: cx[i + 1]!, z1: cz[j + 1]!, district: d.id, kind: 'built' });
        }
      }
    }
  }

  // Width of the road whose centre line is at `at` on an axis, to shrink blocks to the kerb.
  const halfWidthAt = (axis: 'x' | 'z', at: number, along: number): number => {
    let w = 0;
    for (const l of lines) if (l.axis === axis && Math.abs(l.at - at) < 0.01 && along >= l.a - 1 && along <= l.b + 1) w = Math.max(w, l.width);
    return w / 2;
  };
  for (const b of blocks) {
    const mx = (b.x0 + b.x1) / 2;
    const mz = (b.z0 + b.z1) / 2;
    b.x0 += halfWidthAt('x', b.x0, mz);
    b.x1 -= halfWidthAt('x', b.x1, mz);
    b.z0 += halfWidthAt('z', b.z0, mx);
    b.z1 -= halfWidthAt('z', b.z1, mx);
  }

  // Block uses: parks and yards by district odds; alleys split the rest.
  const alleys: Line[] = [];
  for (const b of blocks) {
    const d = spec.districts[districtIndex.get(b.district)!]!;
    const r = rng.next();
    if (r < d.park) b.kind = 'park';
    else if (r < d.park + d.lot) b.kind = 'lot';
    else if (rng.next() < d.alley) {
      const w = b.x1 - b.x0;
      const dd = b.z1 - b.z0;
      if (w >= dd && w > 60) {
        const x = Math.round((b.x0 + b.x1) / 2 + rng.range(-w * 0.12, w * 0.12));
        alleys.push({ axis: 'x', at: x, a: b.z0, b: b.z1, width: R.alley, kind: 'alley' });
      } else if (dd > 60) {
        const z = Math.round((b.z0 + b.z1) / 2 + rng.range(-dd * 0.12, dd * 0.12));
        alleys.push({ axis: 'z', at: z, a: b.x0, b: b.x1, width: R.alley, kind: 'alley' });
      }
    }
  }
  // Split blocks along their alleys.
  for (const al of alleys) {
    const hw = al.width / 2;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      if (b.kind !== 'built') continue;
      if (al.axis === 'x' && al.at > b.x0 && al.at < b.x1 && al.a <= b.z0 + 0.01 && al.b >= b.z1 - 0.01) {
        blocks.push({ ...b, x0: al.at + hw });
        b.x1 = al.at - hw;
        // Alleys meet the street at the pavement edge: extend the line to the kerbs.
      } else if (al.axis === 'z' && al.at > b.z0 && al.at < b.z1 && al.a <= b.x0 + 0.01 && al.b >= b.x1 - 0.01) {
        blocks.push({ ...b, z0: al.at + hw });
        b.z1 = al.at - hw;
      }
    }
    // The alley runs from kerb to kerb of the streets at its ends (centre lines a little further).
    lines.push(al);
  }

  // Riverside promenades and the outer fringe beyond the ring avenue.
  const hA = R.avenue / 2;
  blocks.push({ x0: -ring + hA, z0: river.bankZ0 + hA, x1: ring - hA, z1: river.z0, district: 'river', kind: 'promenade' });
  blocks.push({ x0: -ring + hA, z0: river.z1, x1: ring - hA, z1: river.bankZ1 - hA, district: 'river', kind: 'promenade' });
  const inner = H - spec.wallThickness;
  blocks.push({ x0: -inner, z0: -inner, x1: inner, z1: -ring - hA, district: 'fringe', kind: 'fringe' });
  blocks.push({ x0: -inner, z0: ring + hA, x1: inner, z1: inner, district: 'fringe', kind: 'fringe' });
  blocks.push({ x0: -inner, z0: -ring + hA, x1: -ring - hA, z1: river.bankZ0 - hA, district: 'fringe', kind: 'fringe' });
  blocks.push({ x0: -inner, z0: river.bankZ1 + hA, x1: -ring - hA, z1: ring - hA, district: 'fringe', kind: 'fringe' });
  blocks.push({ x0: ring + hA, z0: -ring + hA, x1: inner, z1: river.bankZ0 - hA, district: 'fringe', kind: 'fringe' });
  blocks.push({ x0: ring + hA, z0: river.bankZ1 + hA, x1: inner, z1: ring - hA, district: 'fringe', kind: 'fringe' });
  // Fringe corners and river ends outside the ring.
  blocks.push({ x0: -inner, z0: river.bankZ0 - hA, x1: -ring - hA, z1: river.z0, district: 'fringe', kind: 'promenade' });
  blocks.push({ x0: ring + hA, z0: river.bankZ0 - hA, x1: inner, z1: river.z0, district: 'fringe', kind: 'promenade' });
  blocks.push({ x0: -inner, z0: river.z1, x1: -ring - hA, z1: river.bankZ1 + hA, district: 'fringe', kind: 'promenade' });
  blocks.push({ x0: ring + hA, z0: river.z1, x1: inner, z1: river.bankZ1 + hA, district: 'fringe', kind: 'promenade' });
  // The ends of the river-bank avenues past the ring.
  // (The avenues at bankZ0/bankZ1 run the full ring width; outside the ring is pavement.)

  // Water, split around the bridges (each bridge deck is a road over it).
  const water: GeneratedMap['water'] = [];
  const bx = [...river.bridgesX].sort((a, b) => a - b);
  let wx = -inner;
  for (const b of bx) {
    const x1 = b - hA;
    if (x1 > wx) water.push({ x: (wx + x1) / 2, z: (river.z0 + river.z1) / 2, w: x1 - wx, d: river.z1 - river.z0 });
    wx = b + hA;
  }
  water.push({ x: (wx + inner) / 2, z: (river.z0 + river.z1) / 2, w: inner - wx, d: river.z1 - river.z0 });
  // Bridge spans are their own kind (railings, no kerbside furniture).
  for (const b of bx) {
    const l = lines.find((q) => q.axis === 'x' && q.at === b && q.kind === 'avenue' && q.a < river.z0 && q.b > river.z1);
    if (!l) continue;
    lines.push({ axis: 'x', at: b, a: l.a, b: river.z0, width: l.width, kind: 'avenue' });
    lines.push({ axis: 'x', at: b, a: river.z0, b: river.z1, width: l.width, kind: 'bridge' });
    l.a = river.z1;
  }

  const segments: RoadSegment[] = lines.map((l) =>
    l.axis === 'x'
      ? { x0: l.at, z0: Math.min(l.a, l.b), x1: l.at, z1: Math.max(l.a, l.b), width: l.width, kind: l.kind }
      : { x0: Math.min(l.a, l.b), z0: l.at, x1: Math.max(l.a, l.b), z1: l.at, width: l.width, kind: l.kind },
  );

  // Buildings.
  const buildings: Building[] = [];
  const P = R.pavement;
  for (const b of blocks) {
    if (b.kind !== 'built') continue;
    const di = districtIndex.get(b.district)!;
    const d = spec.districts[di]!;
    fillBlock(rng, b, d, P, di, buildings);
  }
  // A wall of buildings on the outer fringe so the city edge is not a void.
  for (const b of blocks) {
    if (b.kind !== 'fringe') continue;
    edgeRow(rng, b, buildings);
  }

  const map: GeneratedMap = {
    id: spec.id,
    size: [H * 2, H * 2],
    roads: { segments, width: R.street, laneOffset: R.street / 4, extent: ring, kerbHeight: R.kerbHeight, lampInset: R.lampInset, lampSpacing: R.lampSpacing },
    wallThickness: spec.wallThickness,
    buildings: buildings.map((q) => ({ x: r2(q.x), z: r2(q.z), w: r2(q.w), d: r2(q.d), h: r2(q.h), district: q.district })),
    props: [],
    markers: {},
    spawns: {},
    traffic: { loops: [] },
    blocks,
    water,
    districts: spec.districts.map((d) => ({ id: d.id, name: d.name, colour: d.colour, style: d.style, trafficHint: d.trafficHint, rects: d.rects as [number, number, number, number][] })),
    parking: [],
  };
  furnish(rng, spec, map);
  placeMarkers(rng, spec, map);
  return map;
}

/** Fill a city block with buildings by district style, leaving a pavement band at the kerb. */
function fillBlock(rng: Rng, b: CityBlock, d: CitySpec['districts'][number], P: number, di: number, out: Building[]): void {
  const x0 = b.x0 + P;
  const z0 = b.z0 + P;
  const x1 = b.x1 - P;
  const z1 = b.z1 - P;
  const W = x1 - x0;
  const D = z1 - z0;
  if (W < 6 || D < 6) return;
  const height = (): number => {
    let h = rng.range(d.height[0], d.height[1]);
    if (rng.next() < d.tall) h *= rng.range(1.6, 2.6);
    return Math.round(h * 2) / 2;
  };
  const add = (x: number, z: number, w: number, dd: number, h: number): void => {
    if (w < 3 || dd < 3) return;
    out.push({ x, z, w, d: dd, h, district: di });
  };
  if (d.style === 'towers') {
    // One to four big towers, sometimes with a plaza gap.
    const nx = W > 70 ? 2 : 1;
    const nz = D > 70 ? 2 : 1;
    const gap = 6;
    const cw = (W - gap * (nx - 1)) / nx;
    const cd = (D - gap * (nz - 1)) / nz;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        if (nx * nz > 2 && rng.next() < 0.18) continue; // a plaza
        const inset = rng.range(0, 3);
        add(x0 + cw / 2 + i * (cw + gap), z0 + cd / 2 + j * (cd + gap), cw - inset * 2, cd - inset * 2, height());
      }
    }
    return;
  }
  if (d.style === 'docks' || d.style === 'industrial') {
    // Big sheds with yard space between.
    const dense = d.style === 'industrial';
    let x = x0;
    while (x < x1 - 8) {
      const w = Math.min(x1 - x, rng.range(dense ? 18 : 26, dense ? 36 : 60));
      if (x1 - x - w < 10) {
        add(x + (x1 - x) / 2, (z0 + z1) / 2, x1 - x, D * rng.range(0.55, 0.9), height());
        break;
      }
      const dd = D * rng.range(0.45, 0.85);
      const zc = rng.next() < 0.5 ? z0 + dd / 2 : z1 - dd / 2;
      add(x + w / 2, zc, w, dd, height());
      x += w + rng.range(6, 14);
    }
    return;
  }
  // Market and housing: a perimeter of narrow lots facing every street, with a courtyard behind.
  const market = d.style === 'market';
  const depthMin = market ? 9 : 8;
  const depthMax = market ? 16 : 13;
  const widthMin = market ? 5.5 : 8;
  const widthMax = market ? 12 : 16;
  const gapChance = market ? 0.04 : 0.22;
  const row = (along0: number, along1: number, fixed: number, dir: 1 | -1, axis: 'x' | 'z', depth: number): void => {
    let p = along0;
    while (p < along1 - widthMin) {
      let w = Math.min(along1 - p, rng.range(widthMin, widthMax));
      if (along1 - p - w < widthMin) w = along1 - p;
      if (rng.next() > gapChance) {
        const dd = depth * rng.range(0.85, 1);
        const c = fixed + (dir * dd) / 2;
        const h = height();
        if (axis === 'x') add(p + w / 2, c, w - 0.3, dd, h);
        else add(c, p + w / 2, dd, w - 0.3, h);
      }
      p += w;
    }
  };
  const depth = Math.min(rng.range(depthMin, depthMax), Math.min(W, D) / 2);
  row(x0, x1, z0, 1, 'x', depth);
  row(x0, x1, z1, -1, 'x', depth);
  row(z0 + depth, z1 - depth, x0, 1, 'z', depth);
  row(z0 + depth, z1 - depth, x1, -1, 'z', depth);
  // Dense districts fill the courtyard too.
  const ix0 = x0 + depth + 5;
  const iz0 = z0 + depth + 5;
  const ix1 = x1 - depth - 5;
  const iz1 = z1 - depth - 5;
  if (market && ix1 - ix0 > 8 && iz1 - iz0 > 8) add((ix0 + ix1) / 2, (iz0 + iz1) / 2, ix1 - ix0, iz1 - iz0, height() * 1.2);
}

/** A continuous row of mid-rise buildings along the outer fringe. */
function edgeRow(rng: Rng, b: CityBlock, out: Building[]): void {
  const W = b.x1 - b.x0;
  const D = b.z1 - b.z0;
  const alongX = W >= D;
  const len = alongX ? W : D;
  let p = 0;
  while (p < len - 4) {
    const w = Math.min(len - p, rng.range(14, 30));
    const h = rng.range(14, 34);
    if (alongX) out.push({ x: b.x0 + p + w / 2, z: (b.z0 + b.z1) / 2, w: w - 0.4, d: D - 4, h });
    else out.push({ x: (b.x0 + b.x1) / 2, z: b.z0 + p + w / 2, w: W - 4, d: w - 0.4, h });
    p += w;
  }
}

// ---------------------------------------------------------------------------------------------
// Street furniture, parking and markers.

interface Kerb {
  /** A pavement edge facing a road: a straight run from (x0,z0) to (x1,z1); (nx,nz) points to the road. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  nx: number;
  nz: number;
  block: CityBlock;
  roadKind: RoadKind | 'none';
}

/** The four kerbs of a block, with the kind of road each faces. */
function blockKerbs(b: CityBlock, segs: RoadSegment[]): Kerb[] {
  const face = (x: number, z: number): RoadKind | 'none' => {
    for (const s of segs) {
      const hw = s.width / 2 + 0.5;
      if (x >= s.x0 - hw && x <= s.x1 + hw && z >= s.z0 - hw && z <= s.z1 + hw) return s.kind;
    }
    return 'none';
  };
  const mx = (b.x0 + b.x1) / 2;
  const mz = (b.z0 + b.z1) / 2;
  return [
    { x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z0, nx: 0, nz: -1, block: b, roadKind: face(mx, b.z0 - 2) },
    { x0: b.x0, z0: b.z1, x1: b.x1, z1: b.z1, nx: 0, nz: 1, block: b, roadKind: face(mx, b.z1 + 2) },
    { x0: b.x0, z0: b.z0, x1: b.x0, z1: b.z1, nx: -1, nz: 0, block: b, roadKind: face(b.x0 - 2, mz) },
    { x0: b.x1, z0: b.z0, x1: b.x1, z1: b.z1, nx: 1, nz: 0, block: b, roadKind: face(b.x1 + 2, mz) },
  ];
}

function insideAny(bs: Building[], x: number, z: number, m: number): boolean {
  for (const b of bs) if (Math.abs(x - b.x) < b.w / 2 + m && Math.abs(z - b.z) < b.d / 2 + m) return true;
  return false;
}

/** Buildings bucketed on a coarse grid for placement queries. */
class BuildingIndex {
  private readonly cells = new Map<number, Building[]>();
  constructor(bs: Building[]) {
    for (const b of bs) {
      for (let gx = Math.floor((b.x - b.w / 2) / 32); gx <= Math.floor((b.x + b.w / 2) / 32); gx++) {
        for (let gz = Math.floor((b.z - b.d / 2) / 32); gz <= Math.floor((b.z + b.d / 2) / 32); gz++) {
          const k = (gx + 512) * 1024 + gz + 512;
          let c = this.cells.get(k);
          if (!c) this.cells.set(k, (c = []));
          c.push(b);
        }
      }
    }
  }
  inside(x: number, z: number, m: number): boolean {
    const c = this.cells.get((Math.floor(x / 32) + 512) * 1024 + Math.floor(z / 32) + 512);
    return c ? insideAny(c, x, z, m) : false;
  }
}

function furnish(rng: Rng, spec: CitySpec, map: GeneratedMap): void {
  const segs = map.roads.segments;
  const idx = new BuildingIndex(map.buildings);
  const props = map.props;
  const taken: { x: number; z: number; r: number }[] = [];
  const clear = (x: number, z: number, r: number): boolean => {
    for (const t of taken) if (Math.abs(t.x - x) < t.r + r && Math.abs(t.z - z) < t.r + r) return false;
    return true;
  };
  const districtOf = new Map(spec.districts.map((d) => [d.id, d]));
  const kindsFor = (style: string): string[] => {
    switch (style) {
      case 'towers':
        return ['bench', 'bollard', 'bin', 'tree', 'tree', 'vending', 'bollard', 'hydrant'];
      case 'market':
        return ['bin', 'vending', 'vending', 'crate', 'bench', 'hydrant', 'bin', 'barrier'];
      case 'docks':
        return ['crate', 'crate', 'barrier', 'bollard', 'bin', 'hydrant'];
      case 'industrial':
        return ['crate', 'barrier', 'dumpster', 'bin', 'hydrant', 'bollard'];
      default:
        return ['tree', 'tree', 'bin', 'bench', 'hydrant', 'bollard'];
    }
  };
  for (const b of map.blocks) {
    const d = districtOf.get(b.district);
    const style = d?.style ?? 'housing';
    if (b.kind === 'park' || b.kind === 'promenade') {
      // Trees in a loose grid, benches along the paths, a kiosk now and then.
      const step = b.kind === 'park' ? 9 : 14;
      for (let x = b.x0 + 6; x < b.x1 - 4; x += step) {
        for (let z = b.z0 + 6; z < b.z1 - 4; z += step) {
          const jx = x + rng.range(-2.5, 2.5);
          const jz = z + rng.range(-2.5, 2.5);
          if (b.kind === 'promenade' && Math.abs(jz - (b.z0 + b.z1) / 2) < 3) continue; // the walkway
          if (rng.next() < 0.75) props.push({ kind: 'tree', x: r2(jx), z: r2(jz), yaw: 0 });
          else if (rng.next() < 0.5) props.push({ kind: 'bench', x: r2(jx), z: r2(jz), yaw: rng.pick([0, Math.PI / 2]) });
        }
      }
      if (b.kind === 'park' && rng.next() < 0.5) props.push({ kind: 'kiosk', x: r2((b.x0 + b.x1) / 2), z: r2((b.z0 + b.z1) / 2), yaw: 0 });
      continue;
    }
    if (b.kind === 'lot') {
      // Bollards round the edge and parked cars in rows.
      for (let x = b.x0 + 4; x < b.x1 - 4; x += 3.4) {
        for (const z of [b.z0 + 8, b.z1 - 8]) {
          if (z < b.z0 + 6 || z > b.z1 - 6) continue;
          if (rng.next() < 0.22 && map.parking.length < 3000) map.parking.push({ x: r2(x), z: r2(z), yaw: z < (b.z0 + b.z1) / 2 ? 0 : Math.PI, variant: rng.pick(spec.parkedVariants) });
        }
      }
      if (style === 'docks' || style === 'industrial') {
        // Container stacks: solid dumpster-sized blocks in rows.
        for (let i = 0; i < 6; i++) {
          const x = rng.range(b.x0 + 8, b.x1 - 8);
          const z = rng.range(b.z0 + 14, b.z1 - 14);
          if (clear(x, z, 3)) {
            props.push({ kind: 'dumpster', x: r2(x), z: r2(z), yaw: rng.pick([0, Math.PI / 2]) });
            taken.push({ x, z, r: 2 });
          }
        }
      }
      continue;
    }
    if (b.kind !== 'built' && b.kind !== 'fringe') continue;
    const kinds = kindsFor(style);
    for (const k of blockKerbs(b, segs)) {
      if (k.roadKind === 'none' || k.roadKind === 'bridge') continue;
      const len = Math.hypot(k.x1 - k.x0, k.z1 - k.z0);
      const dirX = (k.x1 - k.x0) / len;
      const dirZ = (k.z1 - k.z0) / len;
      const per = ((d?.props ?? 4) / 100) * len * (k.roadKind === 'alley' ? 0.5 : 1);
      const count = Math.floor(per + rng.next());
      for (let i = 0; i < count; i++) {
        const t = rng.range(9, Math.max(9.5, len - 9));
        const kind = k.roadKind === 'alley' ? rng.pick(['dumpster', 'crate', 'bin', 'barrier']) : rng.pick(kinds);
        // Trees and bollards at the kerb, the rest back towards the frontage.
        const inset = kind === 'tree' || kind === 'bollard' || kind === 'hydrant' ? 1.3 : kind === 'vending' ? 3.6 : 2.4;
        const x = k.x0 + dirX * t - k.nx * inset;
        const z = k.z0 + dirZ * t - k.nz * inset;
        if (!clear(x, z, 1.2) || idx.inside(x, z, 0.6)) continue;
        taken.push({ x, z, r: 1.2 });
        const yaw = Math.atan2(k.nx, k.nz);
        props.push({ kind, x: r2(x), z: r2(z), yaw: r2(kind === 'bench' || kind === 'vending' ? yaw : kind === 'barrier' ? Math.atan2(dirX, dirZ) : yaw) });
      }
      // Kerbside parking on streets.
      const pd = d?.parked ?? 0;
      if (k.roadKind === 'street' && pd > 0) {
        const n = Math.floor((pd / 100) * len + rng.next());
        const hw = spec.roads.street / 2;
        for (let i = 0; i < n; i++) {
          const t = rng.range(14, Math.max(14.5, len - 14));
          // In the road against this kerb, facing the way traffic flows on that side.
          const x = k.x0 + dirX * t + k.nx * Math.min(1.25, hw - 4);
          const z = k.z0 + dirZ * t + k.nz * Math.min(1.25, hw - 4);
          const along = Math.atan2(dirX, dirZ);
          const yaw = along + (rightHandFacing(k.nx, k.nz, dirX, dirZ) ? 0 : Math.PI);
          if (map.parking.some((p) => Math.abs(p.x - x) < 6 && Math.abs(p.z - z) < 6)) continue;
          map.parking.push({ x: r2(x), z: r2(z), yaw: r2(yaw), variant: rng.pick(spec.parkedVariants) });
        }
      }
    }
  }
}

/**
 * For a parked car against a kerb whose road lies towards (nx, nz), is the
 * kerb direction (dirX, dirZ) the way traffic flows in that lane? With
 * right-hand traffic, a car's kerb is on its right: right of travel = road→kerb
 * direction = (-nx, -nz).
 */
function rightHandFacing(nx: number, nz: number, dirX: number, dirZ: number): boolean {
  // Right of a travel direction (fx, fz) in this x-east/z-south frame is (-fz, fx).
  const rx = -dirZ;
  const rz = dirX;
  return rx * -nx + rz * -nz > 0;
}

/** Gap between a drive-in marker and its workshop door (the car stops on the pad in front of it). */
const GARAGE_FRONT_GAP = 5.5;

/**
 * Workshops for landmarks with a `garage`: a building behind the marker with
 * its front facing the nearest road, so a car drives across the yard onto the
 * pad at its door. No RNG is drawn, so the rest of the city is unchanged.
 */
function placeGarages(spec: CitySpec, map: GeneratedMap): void {
  const segs = map.roads.segments.filter((q) => q.kind !== 'alley');
  /** Distance along an axis ray from (x, z) to the nearest road rectangle, or Infinity. */
  const rayToRoad = (x: number, z: number, dx: number, dz: number): number => {
    let best = Infinity;
    for (const q of segs) {
      const hw = q.width / 2;
      const x0 = Math.min(q.x0, q.x1) - hw;
      const x1 = Math.max(q.x0, q.x1) + hw;
      const z0 = Math.min(q.z0, q.z1) - hw;
      const z1 = Math.max(q.z0, q.z1) + hw;
      if (dx !== 0) {
        if (z < z0 || z > z1) continue;
        const d = dx > 0 ? x0 - x : x - x1;
        if (d >= 0 && d < best) best = d;
      } else {
        if (x < x0 || x > x1) continue;
        const d = dz > 0 ? z0 - z : z - z1;
        if (d >= 0 && d < best) best = d;
      }
    }
    return best;
  };
  const dirs: [number, number][] = [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ];
  for (const [id, lm] of Object.entries(spec.landmarks)) {
    const g = lm.garage;
    const m = map.markers[id];
    if (!g || !m) continue;
    const [x, , z] = m.pos;
    let face: [number, number] = [0, 1];
    let near = Infinity;
    for (const d of dirs) {
      const r = rayToRoad(x, z, d[0], d[1]);
      if (r < near) {
        near = r;
        face = d;
      }
    }
    // The workshop stands on the far side of the pad from the road, clear of any road behind it.
    const room = rayToRoad(x, z, -face[0], -face[1]) - GARAGE_FRONT_GAP - 3;
    const depth = Math.min(g.d, room);
    if (depth < 5) continue;
    const off = GARAGE_FRONT_GAP + depth / 2;
    const bx = r2(x - face[0] * off);
    const bz = r2(z - face[1] * off);
    const alongX = face[0] === 0;
    const b: Building = { x: bx, z: bz, w: alongX ? g.w : depth, d: alongX ? depth : g.w, h: g.h };
    if (map.buildings.some((o) => Math.abs(o.x - b.x) < (o.w + b.w) / 2 + 1 && Math.abs(o.z - b.z) < (o.d + b.d) / 2 + 1)) continue;
    map.buildings.push(b);
    const clear = (px: number, pz: number, margin: number): boolean => Math.abs(px - b.x) > b.w / 2 + margin || Math.abs(pz - b.z) > b.d / 2 + margin;
    map.props = map.props.filter((p) => clear(p.x, p.z, 1.5));
    map.parking = map.parking.filter((p) => clear(p.x, p.z, 3.5));
  }
}

function placeMarkers(rng: Rng, spec: CitySpec, map: GeneratedMap): void {
  const m = map.markers;
  const segs = map.roads.segments;
  const idx = new BuildingIndex(map.buildings);
  const set = (id: string, x: number, z: number): void => {
    m[id] = { pos: [r2(x), 0, r2(z)] };
  };
  const inDistrict = (d: CitySpec['districts'][number], x: number, z: number): boolean =>
    d.rects.some(([x0, z0, x1, z1]) => x > x0 && x < x1 && z > z0 && z < z1);
  const used: { x: number; z: number }[] = [];
  const free = (x: number, z: number, r: number): boolean => used.every((u) => Math.hypot(u.x - x, u.z - z) > r);
  const take = (x: number, z: number): void => {
    used.push({ x, z });
  };

  // Spot finders. Each returns a point and reserves it.
  const doorSpot = (d: CitySpec['districts'][number]): [number, number] => {
    for (let tries = 0; tries < 400; tries++) {
      const blocks = map.blocks.filter((b) => b.district === d.id && b.kind === 'built');
      const b = rng.pick(blocks);
      const ks = blockKerbs(b, segs).filter((k) => k.roadKind === 'street' || k.roadKind === 'avenue');
      if (ks.length === 0) continue;
      const k = rng.pick(ks);
      const len = Math.hypot(k.x1 - k.x0, k.z1 - k.z0);
      const t = rng.range(12, Math.max(12.5, len - 12));
      const x = k.x0 + ((k.x1 - k.x0) / len) * t - k.nx * 2.2;
      const z = k.z0 + ((k.z1 - k.z0) / len) * t - k.nz * 2.2;
      if (idx.inside(x, z, 0.8) || !free(x, z, 25)) continue;
      take(x, z);
      return [x, z];
    }
    throw new Error(`No door spot in ${d.id}`);
  };
  const lotSpot = (d: CitySpec['districts'][number] | null, kind: BlockKind = 'lot'): [number, number] => {
    const blocks = map.blocks.filter((b) => (d ? b.district === d.id : true) && b.kind === kind);
    for (let tries = 0; tries < 200 && blocks.length; tries++) {
      const b = rng.pick(blocks);
      const x = (b.x0 + b.x1) / 2 + rng.range(-0.2, 0.2) * (b.x1 - b.x0);
      const z = (b.z0 + b.z1) / 2 + rng.range(-0.15, 0.15) * (b.z1 - b.z0);
      if (!free(x, z, 30)) continue;
      take(x, z);
      return [x, z];
    }
    // No such block: fall back to a door spot (district always has those).
    return doorSpot(d ?? spec.districts[0]!);
  };
  const roadSpot = (d: CitySpec['districts'][number]): [number, number, number] => {
    for (let tries = 0; tries < 400; tries++) {
      const s = rng.pick(segs);
      if (s.kind === 'alley' || s.kind === 'bridge') continue;
      const t = rng.range(0.25, 0.75);
      const cx = s.x0 + (s.x1 - s.x0) * t;
      const cz = s.z0 + (s.z1 - s.z0) * t;
      if (!inDistrict(d, cx, cz) || !free(cx, cz, 30)) continue;
      // Right-hand lane: for travel +z (south) the lane is at -x? Right of (0,1) is (-1,0): west side.
      const off = s.width / 4;
      const alongX = s.z0 === s.z1;
      const yaw = alongX ? Math.PI / 2 : Math.PI; // east along x, north along z
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const x = cx + -fz * off;
      const z = cz + fx * off;
      take(cx, cz);
      return [x, z, yaw];
    }
    throw new Error(`No road spot in ${d.id}`);
  };

  // Landmarks first, so district-numbered spots keep clear of them.
  for (const [id, lm] of Object.entries(spec.landmarks)) {
    const d = spec.districts.find((q) => q.id === lm.district) ?? null;
    let p: [number, number];
    if (lm.spot === 'bridge') {
      const b = spec.river.bridgesX[lm.index ?? 0]!;
      p = [b, (spec.river.z0 + spec.river.z1) / 2];
    } else if (lm.spot === 'promenade') p = lotSpot(null, 'promenade');
    else if (lm.spot === 'park') p = d ? lotSpot(d, 'park') : lotSpot(null, 'park');
    else if (lm.spot === 'lot') p = lotSpot(d);
    else if (lm.spot === 'road') p = roadSpot(d ?? spec.districts[0]!).slice(0, 2) as [number, number];
    else if (lm.spot === 'edge') {
      // A road point at the outer ring, inside the district.
      const r = Math.max(...spec.avenuesX.map(Math.abs));
      const rect = (d ?? spec.districts[0]!).rects[0]!;
      p = [(rect[0] + rect[2]) / 2, rect[3] >= r ? r : rect[1] <= -r ? -r : (rect[1] + rect[3]) / 2];
    } else p = doorSpot(d ?? spec.districts[0]!);
    set(id, p[0], p[1]);
  }
  for (const d of spec.districts) {
    for (let i = 1; i <= 4; i++) {
      const [x, z] = doorSpot(d);
      set(`${d.id}_payphone_${i}`, x, z);
    }
    for (let i = 1; i <= 4; i++) {
      const [x, z] = lotSpot(d);
      set(`${d.id}_lot_${i}`, x, z);
    }
    for (let i = 1; i <= 8; i++) {
      const [x, z] = roadSpot(d);
      set(`${d.id}_road_${i}`, x, z);
    }
    for (let i = 1; i <= 6; i++) {
      const [x, z] = doorSpot(d);
      set(`${d.id}_door_${i}`, x, z);
    }
    for (const [kind, n] of Object.entries(spec.pickups)) {
      for (let i = 1; i <= n; i++) {
        const [x, z] = rng.next() < 0.5 ? doorSpot(d) : lotSpot(d, rng.next() < 0.5 ? 'park' : 'lot');
        set(`pickup_${kind}_${d.id}_${i}`, x, z);
      }
    }
  }
  // A car waiting at the start, in the lane beside the player.
  const s = m['player_start']!.pos;
  // Find the nearest road segment and park on it, against the kerb.
  let best: RoadSegment | null = null;
  let bd = Infinity;
  for (const q of segs) {
    if (q.kind !== 'street' && q.kind !== 'avenue') continue;
    const cx = Math.max(q.x0, Math.min(q.x1, s[0]));
    const cz = Math.max(q.z0, Math.min(q.z1, s[2]));
    const dd = Math.hypot(cx - s[0], cz - s[2]);
    if (dd < bd) {
      bd = dd;
      best = q;
    }
  }
  if (best) {
    const alongX = best.z0 === best.z1;
    const hw = best.width / 2 - 1.3;
    const cx = Math.max(best.x0 + 12, Math.min(best.x1 - 12, s[0]));
    const cz = Math.max(best.z0 + 12, Math.min(best.z1 - 12, s[2]));
    const side = alongX ? Math.sign(s[2] - best.z0) || 1 : Math.sign(s[0] - best.x0) || 1;
    const x = alongX ? cx + 3 : best.x0 + side * hw;
    const z = alongX ? best.z0 + side * hw : cz + 3;
    // Right-hand traffic: on the south side (+z) of an east-west road, cars face west.
    const yaw = alongX ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : side > 0 ? 0 : Math.PI;
    map.spawns['start_car'] = { variant: spec.parkedVariants[0]!, pos: [r2(x), 0, r2(z)], yaw: r2(yaw), locked: false };
    // Keep kerbside clutter off the start spot and the car.
    map.props = map.props.filter((p) => Math.hypot(p.x - s[0], p.z - s[2]) > 5 && Math.hypot(p.x - x, p.z - z) > 4);
    map.parking = map.parking.filter((p) => Math.hypot(p.x - x, p.z - z) > 8);
  }
  // The prototype the Glasshounds want lifted waits, locked, in a Glass Quarter car park.
  const lot = m['glass_lot_2'];
  if (lot) map.spawns['prototype_car'] = { variant: 'prototype', pos: [lot.pos[0], 0, lot.pos[2]], yaw: 0, locked: true };
  placeGarages(spec, map);
  // Keep furniture off every marker so spawned cars and people have room.
  map.props = map.props.filter((p) => {
    for (const k of Object.values(m)) if (Math.hypot(p.x - k.pos[0], p.z - k.pos[2]) < 3.5) return false;
    return true;
  });
  map.parking = map.parking.filter((p) => {
    for (const k of Object.values(m)) if (Math.hypot(p.x - k.pos[0], p.z - k.pos[2]) < 6) return false;
    return true;
  });
}
