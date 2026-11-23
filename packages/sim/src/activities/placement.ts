import { Rng } from '../rng';
import { Cell, cityGrid, type CityGrid } from '../street';
import { districtAt, type GeneratedMap, type RoadKind } from '../citygen';
import type { ActivitiesConfig, JumpsConfig } from './config';

/**
 * Where the side activities sit. Generated deterministically from the city and
 * activities.json (never hand-placed coordinates), so a new city layout moves
 * them with it: stunt ramps on straight roads with a run-up and a clear landing,
 * rampage tokens and race flags on kerbs in their districts, and 50 data shards
 * tucked against walls, down alleys, in parks, yards and on the river edges,
 * always somewhere a person can walk to.
 */

export interface RampSite {
  id: string;
  district: string;
  /** Kicker start (the low end), centre line. */
  x: number;
  z: number;
  /** Direction of travel up the ramp: forward is (sin yaw, cos yaw). */
  yaw: number;
  width: number;
  up: number;
  deck: number;
  down: number;
  height: number;
  road: RoadKind;
  /** Unique jump: fly at least this far from the take-off (m). */
  target: number;
}

export interface TokenSite {
  id: string;
  district: string;
  x: number;
  z: number;
}

export type ShardSpot = 'pavement' | 'alley' | 'park' | 'lot' | 'edge';

export interface ShardSite {
  id: string;
  district: string;
  kind: ShardSpot;
  x: number;
  z: number;
}

export interface FlagSite {
  id: string;
  district: string;
  /** The flag, on the pavement. */
  x: number;
  z: number;
  /** Pole position in the lane, and the way the grid faces. */
  gridX: number;
  gridZ: number;
  yaw: number;
  /** Lane offset from the road's centre line (the second grid column is two lanes left). */
  lane: number;
}

export interface ActivitySites {
  ramps: RampSite[];
  tokens: TokenSite[];
  shards: ShardSite[];
  flags: FlagSite[];
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Height of a ramp's surface at a point, or -1 when the point is off the ramp. */
export function rampSurface(r: RampSite, x: number, z: number): number {
  const fx = Math.sin(r.yaw);
  const fz = Math.cos(r.yaw);
  const dx = x - r.x;
  const dz = z - r.z;
  const along = dx * fx + dz * fz;
  const lat = dx * fz - dz * fx;
  if (Math.abs(lat) > r.width / 2) return -1;
  return rampProfile(r, along);
}

/** Height of a ramp at `along` metres from the kicker start, or -1 off either end. */
export function rampProfile(r: { up: number; deck: number; down: number; height: number }, along: number): number {
  if (along < 0) return -1;
  if (along <= r.up) return (r.height * along) / r.up;
  if (along <= r.up + r.deck) return r.height;
  const back = along - r.up - r.deck;
  if (back <= r.down) return r.height * (1 - back / r.down);
  return -1;
}

export function rampLength(r: { up: number; deck: number; down: number }): number {
  return r.up + r.deck + r.down;
}

/** How far a car leaving the kicker at `speed` flies, landing on flat road (m). */
export function jumpDistance(cfg: JumpsConfig, speed: number): number {
  const r = cfg.ramp;
  const vy = speed * (r.height / r.up) * cfg.launchBoost;
  const g = cfg.gravity;
  const t = (vy + Math.sqrt(vy * vy + 2 * g * r.height)) / g;
  return speed * t;
}

/** A district id for any point: its own, or the nearest district by x (river banks and the fringe). */
function districtFor(map: GeneratedMap, x: number, z: number): string {
  const i = districtAt(map, x, z);
  if (i >= 0) return map.districts[i]!.id;
  let best = map.districts[0]!.id;
  let bd = Infinity;
  for (const d of map.districts) {
    for (const [x0, z0, x1, z1] of d.rects) {
      const dx = Math.max(x0 - x, 0, x - x1);
      const dz = Math.max(z0 - z, 0, z - z1);
      const dd = Math.hypot(dx, dz);
      if (dd < bd) {
        bd = dd;
        best = d.id;
      }
    }
  }
  return best;
}

/**
 * Cells a person can walk to from the streets: flood fill from every road cell over
 * open ground, eroded by a metre so a hairline gap between two buildings does not count.
 */
function walkable(g: CityGrid): Uint8Array {
  const n = g.n;
  const c = g.cells;
  const open = new Uint8Array(n * n);
  const solid = Cell.building | Cell.water;
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const k = j * n + i;
      if (c[k]! & solid || c[k - 1]! & solid || c[k + 1]! & solid || c[k - n]! & solid || c[k + n]! & solid) continue;
      open[k] = 1;
    }
  }
  const out = new Uint8Array(n * n);
  const stack: number[] = [];
  for (let k = 0; k < n * n; k++) {
    if (open[k] && c[k]! & Cell.road && !out[k]) {
      out[k] = 1;
      stack.push(k);
    }
  }
  while (stack.length) {
    const k = stack.pop()!;
    for (const m of [k - 1, k + 1, k - n, k + n]) {
      if (m < 0 || m >= n * n || out[m] || !open[m]) continue;
      out[m] = 1;
      stack.push(m);
    }
  }
  return out;
}

export function placeActivities(map: GeneratedMap, cfg: ActivitiesConfig): ActivitySites {
  const rng = new Rng(cfg.seed);
  const g = cityGrid(map);
  const sites: ActivitySites = { ramps: [], tokens: [], shards: [], flags: [] };
  // Each taken spot keeps its own clear radius; activities also keep `r` from each other.
  const taken: Taken = [];
  for (const m of Object.values(map.markers)) taken.push({ x: m.pos[0], z: m.pos[2], r: 12, activity: false });
  for (const s of Object.values(map.spawns)) taken.push({ x: s.pos[0], z: s.pos[2], r: 10, activity: false });
  const free = (x: number, z: number, r: number): boolean => taken.every((t) => Math.hypot(t.x - x, t.z - z) >= (t.activity ? Math.max(r, t.r) : t.r));
  placeRamps(map, cfg, g, rng, sites, taken, free);
  placeFlags(map, cfg, g, rng, sites, taken, free);
  const reach = walkable(g);
  const isReach = (x: number, z: number): boolean => {
    const i = Math.floor(x + g.half);
    const j = Math.floor(z + g.half);
    return i >= 0 && j >= 0 && i < g.n && j < g.n && reach[j * g.n + i] === 1;
  };
  placeTokens(map, cfg, g, rng, sites, taken, free, isReach);
  placeShards(map, cfg, g, rng, sites, taken, isReach);
  return sites;
}

type Free = (x: number, z: number, r: number) => boolean;
type Taken = { x: number; z: number; r: number; activity: boolean }[];

function placeRamps(map: GeneratedMap, cfg: ActivitiesConfig, g: CityGrid, rng: Rng, out: ActivitySites, taken: Taken, free: Free): void {
  const J = cfg.jumps;
  const R = J.ramp;
  const len = rampLength(R);
  const target = Math.round(jumpDistance(J, J.targetSpeed) * J.targetFraction);
  interface Cand {
    x: number;
    z: number;
    yaw: number;
    road: RoadKind;
    district: string;
  }
  const byDistrict = new Map<string, Cand[]>();
  const roadAt = (x: number, z: number): boolean => (g.at(x, z) & Cell.road) !== 0;
  const spawns = Object.values(map.spawns).map((s) => ({ x: s.pos[0], z: s.pos[2] }));
  const solidAt = (x: number, z: number): boolean => (g.at(x, z) & (Cell.building | Cell.water)) !== 0;
  for (const s of map.roads.segments) {
    if (s.kind === 'bridge') continue;
    const alongX = s.z0 === s.z1;
    const a = alongX ? s.x0 : s.z0;
    const b = alongX ? s.x1 : s.z1;
    const lane = s.kind === 'alley' ? 0 : s.width / 4;
    for (const dir of [1, -1]) {
      const fx = alongX ? dir : 0;
      const fz = alongX ? 0 : dir;
      // Right-hand lane: right of travel (fx, fz) is (-fz, fx).
      const rx = -fz;
      const rz = fx;
      for (let t = a + 6; t <= b - 6; t += 9) {
        const cx = (alongX ? t : s.x0) + rx * lane;
        const cz = (alongX ? s.z0 : t) + rz * lane;
        let ok = true;
        // Run-up and the ramp itself: road under the whole width.
        for (let k = -J.runUp; k <= len && ok; k += 2) {
          for (const l of [-R.width / 2, 0, R.width / 2]) if (!roadAt(cx + fx * k + rx * l, cz + fz * k + rz * l)) ok = false;
        }
        if (!ok) continue;
        // No side road meeting the ramp: pavement just past both kerbs.
        const hw = s.width / 2 + 2.5;
        const ox = alongX ? 0 : s.x0 - cx;
        const oz = alongX ? s.z0 - cz : 0;
        for (let k = -6; k <= len + 6 && ok; k += 2) {
          for (const side of [-1, 1]) if (roadAt(cx + ox + fx * k + rx * side * hw, cz + oz + fz * k + rz * side * hw)) ok = false;
        }
        if (!ok) continue;
        // A clear flight: nothing solid over the landing run.
        for (let k = len; k <= len + J.landingRun && ok; k += 2) {
          for (const l of [-R.width / 2 - 1, 0, R.width / 2 + 1]) if (solidAt(cx + fx * k + rx * l, cz + fz * k + rz * l)) ok = false;
        }
        if (!ok) continue;
        // Keep the whole run (run-up to landing) away from player spawns, so nobody launches by accident.
        for (const sp of spawns) {
          for (let k = -J.runUp; k <= len + J.landingRun && ok; k += 4) {
            if (Math.hypot(cx + fx * k - sp.x, cz + fz * k - sp.z) < J.spawnClear) ok = false;
          }
        }
        if (!ok) continue;
        const di = districtAt(map, cx, cz);
        if (di < 0) continue;
        const d = map.districts[di]!.id;
        let list = byDistrict.get(d);
        if (!list) byDistrict.set(d, (list = []));
        list.push({ x: cx, z: cz, yaw: Math.atan2(fx, fz), road: s.kind, district: d });
      }
    }
  }
  for (const d of map.districts) {
    const want = J.perDistrict[d.id] ?? 0;
    const list = byDistrict.get(d.id) ?? [];
    // Shuffle (seeded), then favour a mix of road kinds: alleys and streets first, then avenues.
    for (let i = list.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
    const kinds: RoadKind[] = [];
    let n = 0;
    for (let pass = 0; pass < 2 && n < want; pass++) {
      for (const c of list) {
        if (n >= want) break;
        // First pass: one of each road kind.
        if (pass === 0 && kinds.includes(c.road)) continue;
        const mx = c.x + Math.sin(c.yaw) * len * 0.5;
        const mz = c.z + Math.cos(c.yaw) * len * 0.5;
        if (!free(mx, mz, 140)) continue;
        // Keep landing zones apart from other ramps' run-ups too.
        n++;
        kinds.push(c.road);
        taken.push({ x: mx, z: mz, r: 40, activity: true });
        out.ramps.push({
          id: `jump_${d.id}_${n}`,
          district: d.id,
          x: r2(c.x),
          z: r2(c.z),
          yaw: r2(c.yaw),
          width: R.width,
          up: R.up,
          deck: R.deck,
          down: R.down,
          height: R.height,
          road: c.road,
          target,
        });
      }
    }
  }
}

function placeFlags(map: GeneratedMap, cfg: ActivitiesConfig, g: CityGrid, rng: Rng, out: ActivitySites, taken: Taken, free: Free): void {
  const roadAt = (x: number, z: number): boolean => (g.at(x, z) & Cell.road) !== 0;
  for (const def of cfg.races.defs) {
    const d = map.districts.find((q) => q.id === def.district);
    if (!d) throw new Error(`Race "${def.id}" is in unknown district "${def.district}"`);
    const segs = map.roads.segments.filter((s) => (s.kind === 'street' || s.kind === 'avenue') && d.rects.some(([x0, z0, x1, z1]) => Math.max(s.x0, x0) < Math.min(s.x1, x1) + 1 && Math.max(s.z0, z0) < Math.min(s.z1, z1) + 1));
    let placed = false;
    for (let tries = 0; tries < 600 && !placed && segs.length; tries++) {
      const s = rng.pick(segs);
      const alongX = s.z0 === s.z1;
      const a = alongX ? s.x0 : s.z0;
      const b = alongX ? s.x1 : s.z1;
      if (b - a < 80) continue;
      const t = rng.range(a + 30, b - 40);
      const dir = rng.chance(0.5) ? 1 : -1;
      const fx = alongX ? dir : 0;
      const fz = alongX ? 0 : dir;
      const rx = -fz;
      const rz = fx;
      const lane = s.width / 4;
      const gx = (alongX ? t : s.x0) + rx * lane;
      const gz = (alongX ? s.z0 : t) + rz * lane;
      if (districtAt(map, gx, gz) !== map.districts.indexOf(d)) continue;
      // Room for the grid: road for 30 m ahead and 25 m behind.
      let ok = true;
      for (let k = -25; k <= 30 && ok; k += 2) if (!roadAt(gx + fx * k, gz + fz * k) || !roadAt(gx + fx * k - rx * lane * 2, gz + fz * k - rz * lane * 2)) ok = false;
      if (!ok) continue;
      const kerb = s.width / 2 + 1.6;
      const flagX = (alongX ? t : s.x0) + rx * kerb;
      const flagZ = (alongX ? s.z0 : t) + rz * kerb;
      if (g.at(flagX, flagZ) & (Cell.road | Cell.building | Cell.water)) continue;
      if (!free(gx, gz, 120)) continue;
      taken.push({ x: gx, z: gz, r: 40, activity: true });
      out.flags.push({ id: def.id, district: d.id, x: r2(flagX), z: r2(flagZ), gridX: r2(gx), gridZ: r2(gz), yaw: r2(Math.atan2(fx, fz)), lane });
      placed = true;
    }
    if (!placed) throw new Error(`No start for race "${def.id}" in ${def.district}`);
  }
}

/** Classify a point for shards and tokens. */
function spotKind(map: GeneratedMap, g: CityGrid, x: number, z: number): ShardSpot | null {
  const c = g.at(x, z);
  if (c & (Cell.building | Cell.water)) return null;
  if (c & Cell.alley) return 'alley';
  if (c & Cell.road) return null;
  const near = (r: number, flag: number): boolean => {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]] as const) {
      if (g.at(x + dx, z + dz) & flag) return true;
    }
    return false;
  };
  if (near(6, Cell.water)) return 'edge';
  if (c & Cell.park) return 'park';
  if (c & Cell.lot) return 'lot';
  if (near(2.5, Cell.building)) return 'pavement';
  return null;
}

function clearOfClutter(map: GeneratedMap, x: number, z: number, r: number): boolean {
  for (const p of map.props) if (Math.abs(p.x - x) < r && Math.abs(p.z - z) < r) return false;
  for (const p of map.parking) if (Math.abs(p.x - x) < r + 2 && Math.abs(p.z - z) < r + 2) return false;
  return true;
}

function placeTokens(map: GeneratedMap, cfg: ActivitiesConfig, g: CityGrid, rng: Rng, out: ActivitySites, taken: Taken, free: Free, reach: (x: number, z: number) => boolean): void {
  for (const def of cfg.rampages.defs) {
    const d = map.districts.find((q) => q.id === def.district);
    if (!d) throw new Error(`Rampage "${def.id}" is in unknown district "${def.district}"`);
    let placed = false;
    for (let tries = 0; tries < 4000 && !placed; tries++) {
      const [x0, z0, x1, z1] = rng.pick(d.rects);
      const x = rng.range(x0 + 10, x1 - 10);
      const z = rng.range(z0 + 10, z1 - 10);
      const k = spotKind(map, g, x, z);
      // A token on a pavement sits at the kerb, in view of passing drivers.
      const want = def.spot === 'pavement' ? (k === 'pavement' || k === null) && !(g.at(x, z) & (Cell.road | Cell.building | Cell.water)) : k === def.spot;
      if (!want) continue;
      if (def.spot === 'pavement') {
        let kerb = false;
        for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]] as const) if ((g.at(x + dx, z + dz) & (Cell.road | Cell.alley)) === Cell.road) kerb = true;
        if (!kerb) continue;
      }
      if (!reach(x, z) || !clearOfClutter(map, x, z, 2.5) || !free(x, z, 90)) continue;
      taken.push({ x, z, r: 30, activity: true });
      out.tokens.push({ id: def.id, district: d.id, x: r2(x), z: r2(z) });
      placed = true;
    }
    if (!placed) throw new Error(`No spot for rampage "${def.id}" in ${def.district}`);
  }
}

function placeShards(map: GeneratedMap, cfg: ActivitiesConfig, g: CityGrid, rng: Rng, out: ActivitySites, taken: Taken, reach: (x: number, z: number) => boolean): void {
  const S = cfg.shards;
  type Pool = Record<ShardSpot, { x: number; z: number }[]>;
  const pools = new Map<string, Pool>();
  for (const d of map.districts) pools.set(d.id, { pavement: [], alley: [], park: [], lot: [], edge: [] });
  const H = map.roads.extent + 30;
  for (let z = -H; z < H; z += 7) {
    for (let x = -H; x < H; x += 7) {
      const px = x + rng.range(0, 6);
      const pz = z + rng.range(0, 6);
      const k = spotKind(map, g, px, pz);
      if (!k || !reach(px, pz)) continue;
      pools.get(districtFor(map, px, pz))![k].push({ x: px, z: pz });
    }
  }
  const total = Object.values(S.mix).reduce((a, b) => a + b, 0);
  const kinds = Object.keys(S.mix) as ShardSpot[];
  const placed: ShardSite[] = [];
  const spaced = (x: number, z: number): boolean => placed.every((p) => Math.hypot(p.x - x, p.z - z) >= S.minSpacing) && taken.every((t) => Math.hypot(t.x - x, t.z - z) >= 8);
  // An even share per district, split by kind of spot; a kind a district lacks (no river edge
  // in Lantern Row) passes its share on to the next kind.
  const nd = map.districts.length;
  map.districts.forEach((d, di) => {
    const want = Math.floor(S.count / nd) + (di < S.count % nd ? 1 : 0);
    const pool = pools.get(d.id)!;
    const quotas = kinds.map((k) => Math.floor((want * S.mix[k]) / total));
    for (let i = 0; quotas.reduce((a, b) => a + b, 0) < want; i = (i + 1) % kinds.length) if (S.mix[kinds[i]!] > 0) quotas[i]!++;
    let carry = 0;
    let got = 0;
    for (let pass = 0; pass < 2; pass++) {
      kinds.forEach((kind, ki) => {
        const list = pool[kind];
        const quota = pass === 0 ? quotas[ki]! + carry : want - got;
        let n = 0;
        for (let tries = 0; tries < list.length * 3 && n < quota && list.length; tries++) {
          const p = list[rng.int(0, list.length - 1)]!;
          if (!spaced(p.x, p.z) || !clearOfClutter(map, p.x, p.z, 1.6)) continue;
          placed.push({ id: '', district: d.id, kind, x: r2(p.x), z: r2(p.z) });
          n++;
          got++;
        }
        if (pass === 0) carry = quota - n;
      });
      if (got >= want) break;
    }
  });
  // Stable ids, grouped by district then position, so a save's list survives reordering of the code above.
  placed.sort((a, b) => (a.district === b.district ? a.x - b.x || a.z - b.z : a.district < b.district ? -1 : 1));
  const per = new Map<string, number>();
  for (const p of placed) {
    const i = (per.get(p.district) ?? 0) + 1;
    per.set(p.district, i);
    p.id = `shard_${p.district}_${i}`;
  }
  out.shards.push(...placed);
}

/** Drop parked cars and loose furniture from ramps, their run-ups and race grids, so the way is clear. */
export function clearActivitySites(map: GeneratedMap, sites: ActivitySites, cfg: ActivitiesConfig): void {
  const boxes: { x: number; z: number; yaw: number; back: number; ahead: number; half: number }[] = [];
  for (const r of sites.ramps) boxes.push({ x: r.x, z: r.z, yaw: r.yaw, back: cfg.jumps.runUp * 0.6, ahead: rampLength(r) + 6, half: r.width / 2 + 2.5 });
  for (const f of sites.flags) boxes.push({ x: f.gridX, z: f.gridZ, yaw: f.yaw, back: 26, ahead: 30, half: 9 });
  const inside = (x: number, z: number, m: number): boolean =>
    boxes.some((b) => {
      const fx = Math.sin(b.yaw);
      const fz = Math.cos(b.yaw);
      const dx = x - b.x;
      const dz = z - b.z;
      const a = dx * fx + dz * fz;
      const l = dx * fz - dz * fx;
      return a > -b.back - m && a < b.ahead + m && Math.abs(l) < b.half + m;
    });
  map.parking = map.parking.filter((p) => !inside(p.x, p.z, 2));
  map.props = map.props.filter((p) => !inside(p.x, p.z, 0.5) && sites.tokens.every((t) => Math.hypot(t.x - p.x, t.z - p.z) > 3));
}
