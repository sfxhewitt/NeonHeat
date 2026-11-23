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

/**
 * Street lamps along both kerbs of every road, clear of junctions. Shared by the
 * sim (each lamp is a breakable prop) and the renderer (posts, heads and light).
 */
export function layoutLamps(map: MapContent): LampSpot[] {
  const { positions, width, extent, lampInset, lampSpacing } = map.roads;
  const out: LampSpot[] = [];
  const near = (v: number): boolean => positions.some((p) => Math.abs(v - p) < width / 2 + JUNCTION_CLEAR);
  let k = 0;
  for (const p of positions) {
    for (let t = -extent + 10; t <= extent - 10; t += lampSpacing) {
      if (near(t)) continue;
      for (const side of [-1, 1]) {
        const off = p + side * (width / 2 + lampInset);
        const cold = k++ % 5 === 0;
        // East-west road (z = p): lamps along x. North-south road (x = p): lamps along z.
        out.push({ x: t, z: off, yaw: side > 0 ? Math.PI : 0, cold });
        out.push({ x: off, z: t, yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2, cold });
      }
    }
  }
  return out;
}

/** True where the ground is raised pavement rather than road (inside the map). */
export function onPavement(map: MapContent, x: number, z: number): boolean {
  const { positions, width, extent } = map.roads;
  const hw = width / 2;
  for (const p of positions) {
    if (Math.abs(z - p) < hw && Math.abs(x) <= extent) return false;
    if (Math.abs(x - p) < hw && Math.abs(z) <= extent) return false;
  }
  return true;
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
  const { positions, width } = map.roads;
  const hw = width / 2;
  let best = Infinity;
  let perp = 1;
  for (const p of positions) {
    const ex = Math.abs(Math.abs(x - p) - hw); // an edge of a north-south road: normal along x
    if (ex < best) {
      best = ex;
      perp = Math.abs(vx) / speed;
    }
    const ez = Math.abs(Math.abs(z - p) - hw); // an edge of an east-west road: normal along z
    if (ez < best) {
      best = ez;
      perp = Math.abs(vz) / speed;
    }
  }
  return perp;
}
