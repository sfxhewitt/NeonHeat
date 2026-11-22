/**
 * Fills each city block of a map with a dense, varied set of buildings,
 * street furniture and parked cars. Deterministic (seeded): rerunning it on
 * the same map gives the same city.
 *
 * - Lots split by narrow service alleys, built out to the pavement line.
 * - Taller towers towards the middle of the map.
 * - Open space kept around mission markers and spawns, plus the chop-shop
 *   driveway; those openings become small plazas with kiosks and trees.
 * - Kerbside furniture (bins, benches, bollards, hydrants, trees, vending
 *   machines) clear of junction crossings and street lamps.
 * - Alley clutter (dumpsters, crates, barriers).
 * - Parked cars in the kerb lane, away from junctions.
 *
 *   pnpm exec tsx tools/map-compiler/src/densify.ts content/map/block0.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Building {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

type PropKind = 'bin' | 'bench' | 'bollard' | 'hydrant' | 'tree' | 'vending' | 'kiosk' | 'dumpster' | 'crate' | 'barrier';
interface Prop {
  kind: PropKind;
  x: number;
  z: number;
  yaw: number;
}

const file = process.argv[2] ?? 'content/map/block0.json';
const map = JSON.parse(readFileSync(file, 'utf8'));

let seed = 1337;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const r2 = (v: number): number => Math.round(v * 100) / 100;

const PAVEMENT = 5.5;
const ALLEY_MIN = 2.8;
const ALLEY_MAX = 4.2;
const LOT_MAX = 22;
const LOT_MIN = 6;

const [sx, sz] = map.size as [number, number];
const roadW = map.roads.width as number;
const roads = map.roads.positions as number[];
const extent = map.roads.extent as number;
const halfX = sx / 2 - map.wallThickness;
const halfZ = sz / 2 - map.wallThickness;

const edges = (half: number): [number, number][] => {
  const cuts = [-half, ...roads.flatMap((p) => [p - roadW / 2, p + roadW / 2]), half];
  const out: [number, number][] = [];
  for (let i = 0; i < cuts.length; i += 2) out.push([cuts[i]!, cuts[i + 1]!]);
  return out;
};

/** Places that must stay open: circles (markers, spawns) and a driveway to the chop shop. */
const clear: { x: number; z: number; r: number }[] = [];
const radius: Record<string, number> = { kurogane_lot: 22, gh_chopshop: 13, clinic: 8, player_start: 4, payphone_gh: 5 };
for (const [id, m] of Object.entries(map.markers as Record<string, { pos: number[] }>)) clear.push({ x: m.pos[0]!, z: m.pos[2]!, r: radius[id] ?? 6 });
const keySpawns = ['prototype_car', 'starter_car', 'parked_vandal', 'parked_brick'];
for (const id of keySpawns) {
  const s = (map.spawns as Record<string, { pos: number[] }>)[id];
  if (s) clear.push({ x: s.pos[0]!, z: s.pos[2]!, r: 4.5 });
}
const driveways = [{ x0: -66, x1: -40, z0: 56, z1: 72 }];

const rectBlocked = (x: number, z: number, w: number, d: number, pad = 0): boolean => {
  for (const c of clear) {
    const dx = Math.max(Math.abs(c.x - x) - w / 2, 0);
    const dz = Math.max(Math.abs(c.z - z) - d / 2, 0);
    if (Math.hypot(dx, dz) < c.r + pad) return true;
  }
  for (const dw of driveways) {
    if (x + w / 2 > dw.x0 - pad && x - w / 2 < dw.x1 + pad && z + d / 2 > dw.z0 - pad && z - d / 2 < dw.z1 + pad) return true;
  }
  return false;
};

const buildings: Building[] = [];
const plazas: { x0: number; x1: number; z0: number; z1: number }[] = [];
const alleys: { x0: number; x1: number; z0: number; z1: number }[] = [];

const split = (x0: number, x1: number, z0: number, z1: number, centre: number): void => {
  const w = x1 - x0;
  const d = z1 - z0;
  if (w < LOT_MIN || d < LOT_MIN) {
    if (w > 2 && d > 2) plazas.push({ x0, x1, z0, z1 });
    return;
  }
  const b = { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w, d, h: 0 };
  const blocked = rectBlocked(b.x, b.z, w, d);
  if (w > LOT_MAX || d > LOT_MAX || (blocked && (w > 7 || d > 7))) {
    const alley = ALLEY_MIN + rnd() * (ALLEY_MAX - ALLEY_MIN);
    if (w >= d) {
      const cut = x0 + w * (0.36 + rnd() * 0.28);
      alleys.push({ x0: cut - alley / 2, x1: cut + alley / 2, z0, z1 });
      split(x0, cut - alley / 2, z0, z1, centre);
      split(cut + alley / 2, x1, z0, z1, centre);
    } else {
      const cut = z0 + d * (0.36 + rnd() * 0.28);
      alleys.push({ x0, x1, z0: cut - alley / 2, z1: cut + alley / 2 });
      split(x0, x1, z0, cut - alley / 2, centre);
      split(x0, x1, cut + alley / 2, z1, centre);
    }
    return;
  }
  if (blocked || rnd() < 0.04) {
    plazas.push({ x0, x1, z0, z1 });
    return;
  }
  const tall = rnd() < 0.22 * centre;
  const h = Math.round((tall ? 28 + rnd() * 18 : 8 + rnd() * (10 + 14 * centre)) * 2) / 2;
  buildings.push({ x: r2(b.x), z: r2(b.z), w: Math.round(w * 2) / 2 - 0.2, d: Math.round(d * 2) / 2 - 0.2, h });
};

for (const [x0, x1] of edges(halfX)) {
  for (const [z0, z1] of edges(halfZ)) {
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const centre = 1 - Math.min(1, Math.hypot(cx, cz) / 190);
    const outer = x0 <= -halfX || x1 >= halfX || z0 <= -halfZ || z1 >= halfZ;
    split(
      x0 + (x0 <= -halfX ? 0 : PAVEMENT),
      x1 - (x1 >= halfX ? 0 : PAVEMENT),
      z0 + (z0 <= -halfZ ? 0 : PAVEMENT),
      z1 - (z1 >= halfZ ? 0 : PAVEMENT),
      outer ? centre * 0.6 : centre,
    );
  }
}

// ---- Street furniture -------------------------------------------------------

const props: Prop[] = [];
const FOOT: Record<PropKind, number> = {
  bin: 0.5,
  bench: 1.1,
  bollard: 0.3,
  hydrant: 0.3,
  tree: 0.9,
  vending: 0.8,
  kiosk: 2.2,
  dumpster: 1.3,
  crate: 0.6,
  barrier: 1.3,
};
const insideBuilding = (x: number, z: number, m: number): boolean =>
  buildings.some((b) => Math.abs(x - b.x) < b.w / 2 + m && Math.abs(z - b.z) < b.d / 2 + m);
const nearProp = (x: number, z: number, m: number): boolean => props.some((p) => Math.hypot(p.x - x, p.z - z) < m + FOOT[p.kind]);
const place = (kind: PropKind, x: number, z: number, yaw: number): boolean => {
  const f = FOOT[kind];
  if (Math.abs(x) > halfX - 1 || Math.abs(z) > halfZ - 1) return false;
  if (rectBlocked(x, z, f * 2, f * 2, 1)) return false;
  if (insideBuilding(x, z, kind === 'vending' ? 0.5 : f + 0.2)) return false;
  if (nearProp(x, z, f + 0.6)) return false;
  props.push({ kind, x: r2(x), z: r2(z), yaw: r2(yaw) });
  return true;
};

// Lamp spots (mirrors the engine's layoutLamps) so furniture does not sit on them.
const lampSpots: { x: number; z: number }[] = [];
const nearJunction = (v: number, pad: number): boolean => roads.some((p) => Math.abs(v - p) < roadW / 2 + pad);
for (const p of roads) {
  for (let t = -extent + 10; t <= extent - 10; t += 24) {
    if (nearJunction(t, PAVEMENT + 2)) continue;
    for (const side of [-1, 1]) {
      const off = p + side * (roadW / 2 + 0.9);
      lampSpots.push({ x: t, z: off }, { x: off, z: t });
    }
  }
}
const nearLamp = (x: number, z: number): boolean => lampSpots.some((l) => Math.hypot(l.x - x, l.z - z) < 2.2);

const kerbKinds: PropKind[] = ['bin', 'bench', 'bollard', 'bollard', 'hydrant', 'tree', 'tree', 'bin'];
for (const p of roads) {
  for (const side of [-1, 1]) {
    const off = p + side * (roadW / 2 + 1.7);
    // Along an east-west road (z = off), and along a north-south road (x = off).
    for (const ew of [true, false]) {
      for (let t = -extent + 4; t <= extent - 4; t += 5 + rnd() * 6) {
        if (nearJunction(t, PAVEMENT + 1.5)) continue;
        const x = ew ? t : off;
        const z = ew ? off : t;
        if (nearLamp(x, z)) continue;
        const kind = pick(kerbKinds);
        // Benches face the road; everything else is square to it.
        const yaw = ew ? (side > 0 ? Math.PI : 0) : side > 0 ? -Math.PI / 2 : Math.PI / 2;
        place(kind, x, z, yaw);
      }
      // Vending machines against shop fronts, facing the street.
      const back = p + side * (roadW / 2 + PAVEMENT - 1.05);
      for (let t = -extent + 8; t <= extent - 8; t += 14 + rnd() * 18) {
        if (nearJunction(t, PAVEMENT + 2)) continue;
        const x = ew ? t : back;
        const z = ew ? back : t;
        const yaw = ew ? (side > 0 ? Math.PI : 0) : side > 0 ? -Math.PI / 2 : Math.PI / 2;
        if (rnd() < 0.55) place('vending', x, z, yaw + Math.PI);
      }
    }
  }
}

// Alley clutter.
for (const a of alleys) {
  const w = a.x1 - a.x0;
  const d = a.z1 - a.z0;
  const along = w > d;
  const len = along ? w : d;
  const n = Math.floor(len / 9);
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5 + (rnd() - 0.5) * 0.4) / n;
    const side = rnd() < 0.5 ? -1 : 1;
    const kind = pick<PropKind>(['dumpster', 'crate', 'crate', 'barrier', 'bin', 'dumpster']);
    const inset = along ? d / 2 - FOOT[kind] * 0.7 : w / 2 - FOOT[kind] * 0.7;
    const x = along ? a.x0 + t * w : (a.x0 + a.x1) / 2 + side * Math.max(0, inset);
    const z = along ? (a.z0 + a.z1) / 2 + side * Math.max(0, inset) : a.z0 + t * d;
    place(kind, x, z, along ? 0 : Math.PI / 2);
  }
}

// Plazas: a kiosk, trees and benches, kept off the mission spots themselves.
for (const pz of plazas) {
  const w = pz.x1 - pz.x0;
  const d = pz.z1 - pz.z0;
  // Planters and bins around the edge.
  for (let t = 1.5; t < w - 1; t += 4.5) {
    place(rnd() < 0.5 ? 'tree' : 'bin', pz.x0 + t, pz.z0 + 1, 0);
    place(rnd() < 0.5 ? 'tree' : 'bench', pz.x0 + t, pz.z1 - 1, Math.PI);
  }
  for (let t = 4; t < d - 3; t += 4.5) {
    place(rnd() < 0.6 ? 'tree' : 'bin', pz.x0 + 1, pz.z0 + t, Math.PI / 2);
    place(rnd() < 0.6 ? 'tree' : 'bench', pz.x1 - 1, pz.z0 + t, -Math.PI / 2);
  }
  if (w < 6 || d < 6) continue;
  const cx = (pz.x0 + pz.x1) / 2;
  const cz = (pz.z0 + pz.z1) / 2;
  if (w > 9 && d > 9 && rnd() < 0.6) place('kiosk', cx, cz, rnd() < 0.5 ? 0 : Math.PI / 2);
  for (const [fx, fz] of [
    [-0.35, -0.35],
    [0.35, -0.35],
    [-0.35, 0.35],
    [0.35, 0.35],
  ] as const) {
    place(rnd() < 0.6 ? 'tree' : 'bench', cx + fx * w, cz + fz * d, 0);
  }
}

// ---- Parked cars ---------------------------------------------------------------

const spawns = map.spawns as Record<string, { variant: string; pos: number[]; yaw: number; locked: boolean }>;
for (const id of Object.keys(spawns)) if (id.startsWith('kerb_')) delete spawns[id];
const kerbLane = roadW / 2 - 1.05;
let parked = 0;
const variants = ['kestrel', 'kestrel', 'vandal', 'kestrel', 'vandal'];
for (const p of roads) {
  for (const side of [-1, 1]) {
    for (const ew of [true, false]) {
      for (let t = -extent + 14; t <= extent - 14; t += 16 + rnd() * 30) {
        if (nearJunction(t, 10)) continue;
        if (rnd() < 0.72) continue;
        const x = ew ? t : p + side * kerbLane;
        const z = ew ? p + side * kerbLane : t;
        if (rectBlocked(x, z, 5, 5, 3)) continue;
        // Traffic drives on the right: face the direction of the lane they are parked in.
        const yaw = ew ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : side > 0 ? 0 : Math.PI;
        if (Object.values(spawns).some((s) => Math.hypot(s.pos[0]! - x, s.pos[2]! - z) < 7)) continue;
        spawns[`kerb_${parked++}`] = { variant: pick(variants), pos: [r2(x), 0, r2(z)], yaw: r2(yaw), locked: false };
      }
    }
  }
}

map.buildings = buildings;
map.props = props;
writeFileSync(file, JSON.stringify(map, null, 2) + '\n');
const counts: Record<string, number> = {};
for (const p of props) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
console.info(`${file}: ${buildings.length} buildings, ${props.length} props ${JSON.stringify(counts)}, ${parked} parked cars`);
