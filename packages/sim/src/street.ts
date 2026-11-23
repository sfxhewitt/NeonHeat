import type { MapContent } from './content';

/** A street lamp: where its post stands and which way its arm points (towards the road). */
export interface LampSpot {
  x: number;
  z: number;
  yaw: number;
  /** The odd cold-white lamp among the sodium-warm ones. */
  cold: boolean;
}

/** Junction pavements stay clear of lamps for this far past the kerb. */
const JUNCTION_CLEAR = 7.5;

/** Ground cell flags. */
export const Cell = {
  road: 1,
  water: 2,
  building: 4,
  park: 8,
  lot: 16,
  alley: 32,
} as const;

/**
 * A 1 m raster of the city: what each square metre is (road, water, building
 * footprint, park, yard). Built once per map and cached, so point queries
 * (is this pavement? is this inside a building?) are O(1) however big the city.
 */
export class CityGrid {
  readonly cells: Uint8Array;
  readonly n: number;
  readonly half: number;

  constructor(map: MapContent) {
    this.half = map.size[0] / 2;
    this.n = Math.ceil(map.size[0]);
    this.cells = new Uint8Array(this.n * this.n);
    for (const b of map.blocks) {
      if (b.kind === 'park' || b.kind === 'promenade') this.fill(b.x0, b.z0, b.x1, b.z1, Cell.park);
      else if (b.kind === 'lot') this.fill(b.x0, b.z0, b.x1, b.z1, Cell.lot);
    }
    for (const s of map.roads.segments) {
      const hw = s.width / 2;
      const flag = Cell.road | (s.kind === 'alley' ? Cell.alley : 0);
      if (s.x0 === s.x1) this.fill(s.x0 - hw, s.z0 - (s.kind === 'alley' ? 0 : hw), s.x1 + hw, s.z1 + (s.kind === 'alley' ? 0 : hw), flag, true);
      else this.fill(s.x0 - (s.kind === 'alley' ? 0 : hw), s.z0 - hw, s.x1 + (s.kind === 'alley' ? 0 : hw), s.z1 + hw, flag, true);
    }
    for (const w of map.water) this.fill(w.x - w.w / 2, w.z - w.d / 2, w.x + w.w / 2, w.z + w.d / 2, Cell.water, true);
    for (const b of map.buildings) this.fill(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2, Cell.building);
  }

  /** Set a flag on every cell whose centre lies inside the rectangle. `replace` clears other ground flags. */
  private fill(x0: number, z0: number, x1: number, z1: number, flag: number, replace = false): void {
    const n = this.n;
    const i0 = Math.max(0, Math.ceil(x0 + this.half - 0.5));
    const i1 = Math.min(n - 1, Math.floor(x1 + this.half - 0.5));
    const j0 = Math.max(0, Math.ceil(z0 + this.half - 0.5));
    const j1 = Math.min(n - 1, Math.floor(z1 + this.half - 0.5));
    for (let j = j0; j <= j1; j++) {
      const row = j * n;
      for (let i = i0; i <= i1; i++) {
        const k = row + i;
        this.cells[k] = replace ? (this.cells[k]! & Cell.building) | flag : this.cells[k]! | flag;
      }
    }
  }

  at(x: number, z: number): number {
    const i = Math.floor(x + this.half);
    const j = Math.floor(z + this.half);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return Cell.building;
    return this.cells[j * this.n + i]!;
  }

  /** True on any road surface, alleys included. */
  road(x: number, z: number): boolean {
    return (this.at(x, z) & Cell.road) !== 0;
  }
}

const grids = new WeakMap<MapContent, CityGrid>();

/** The cached raster for a map (built on first use). */
export function cityGrid(map: MapContent): CityGrid {
  let g = grids.get(map);
  if (!g) {
    g = new CityGrid(map);
    grids.set(map, g);
  }
  return g;
}

/** Drop the cached raster (after editing a map in place, e.g. in tests). */
export function invalidateCityGrid(map: MapContent): void {
  grids.delete(map);
}

/**
 * Street lamps along both kerbs of every road, clear of junctions. Shared by the
 * sim (each lamp is a breakable prop) and the renderer (posts, heads and light).
 */
export function layoutLamps(map: MapContent): LampSpot[] {
  const { segments, lampInset, lampSpacing } = map.roads;
  const grid = cityGrid(map);
  const out: LampSpot[] = [];
  let k = 0;
  // Near a crossing road (inside its carriageway plus a clear margin).
  const nearJunction = (x: number, z: number, self: number): boolean => {
    for (let i = 0; i < segments.length; i++) {
      if (i === self) continue;
      const s = segments[i]!;
      const m = s.width / 2 + JUNCTION_CLEAR;
      if (x >= s.x0 - m && x <= s.x1 + m && z >= s.z0 - m && z <= s.z1 + m) return true;
    }
    return false;
  };
  segments.forEach((s, si) => {
    if (s.kind === 'alley') return;
    const alongX = s.z0 === s.z1;
    const a = alongX ? s.x0 : s.z0;
    const b = alongX ? s.x1 : s.z1;
    const spacing = s.kind === 'bridge' ? lampSpacing * 0.8 : lampSpacing;
    const off = s.width / 2 + (s.kind === 'bridge' ? -0.6 : lampInset);
    // Start on a fixed grid so lamps line up across junctions.
    for (let t = Math.ceil(a / spacing) * spacing + spacing / 2; t <= b - 4; t += spacing) {
      if (t < a + 4) continue;
      for (const side of [-1, 1]) {
        const x = alongX ? t : s.x0 + side * off;
        const z = alongX ? s.z0 + side * off : t;
        if (s.kind !== 'bridge') {
          const c = grid.at(x, z);
          if (c & (Cell.road | Cell.water | Cell.building)) continue;
          if (nearJunction(x, z, si)) continue;
        }
        const cold = k++ % 5 === 0;
        // The arm points across the road.
        const yaw = alongX ? (side > 0 ? Math.PI : 0) : side > 0 ? -Math.PI / 2 : Math.PI / 2;
        out.push({ x, z, yaw, cold });
      }
    }
  });
  return out;
}

/** True where the ground is raised pavement rather than road (inside the map). */
export function onPavement(map: MapContent, x: number, z: number): boolean {
  return (cityGrid(map).at(x, z) & (Cell.road | Cell.water)) === 0;
}

/** Ground height at a point: the kerb height on pavements, zero on roads. */
export function groundHeight(map: MapContent, x: number, z: number): number {
  return onPavement(map, x, z) ? map.roads.kerbHeight : 0;
}

/**
 * How square-on a crossing at (x, z) with velocity (vx, vz) meets the nearest kerb
 * edge: 1 driving straight at it, 0 running along it.
 */
export function kerbAngle(map: MapContent, x: number, z: number, vx: number, vz: number, speed: number): number {
  if (speed < 1e-3) return 0;
  const g = cityGrid(map);
  const here = onPavement(map, x, z);
  // Which way does the ground change nearby? Look a metre either side on each axis.
  let ex = 9;
  let ez = 9;
  for (let d = 0.5; d <= 2; d += 0.5) {
    if (ex === 9 && (onPavementG(g, x + d, z) !== here || onPavementG(g, x - d, z) !== here)) ex = d;
    if (ez === 9 && (onPavementG(g, x, z + d) !== here || onPavementG(g, x, z - d) !== here)) ez = d;
  }
  if (ex === 9 && ez === 9) return 1;
  return ex <= ez ? Math.abs(vx) / speed : Math.abs(vz) / speed;
}

function onPavementG(g: CityGrid, x: number, z: number): boolean {
  return (g.at(x, z) & (Cell.road | Cell.water)) === 0;
}
