import type { MapContent, RoadGraph } from '@neonheat/sim';
import type { ActorDef, Mission, SpawnDef } from './schema';

/**
 * Everything that turns a reference into a place lives here, so a change in
 * how the map stores markers (the generated city) is a change in one file.
 */

export interface Pos {
  x: number;
  z: number;
}

/** A marker's ground position, or null. */
export function markerPos(map: MapContent, id: string): Pos | null {
  const m = map.markers[id];
  return m ? { x: m.pos[0], z: m.pos[2] } : null;
}

/** Split `kind:id`. */
export function splitRef(ref: string): [kind: string, id: string] {
  const i = ref.indexOf(':');
  return [ref.slice(0, i), ref.slice(i + 1)];
}

export interface ResolvedSpawn {
  variant: string;
  x: number;
  z: number;
  /** Null: face along the lane if on a road. */
  yaw: number | null;
  locked: boolean;
  hackable: boolean;
  /** Fraction of full health it starts with. */
  hull: number;
  /** From the mission's own spawns (true) or the map (false). */
  mission: boolean;
}

/** A spawn reference: the mission's own spawns first, then the map's. */
export function resolveSpawnDef(map: MapContent, mission: Mission | null, ref: string): ResolvedSpawn | null {
  const [, id] = splitRef(ref);
  const def: SpawnDef | undefined = mission?.spawns?.[id];
  if (def) {
    const at = markerPos(map, splitRef(def.at)[1]);
    if (!at) return null;
    return {
      variant: def.variant,
      ...freeSpot(map, at.x + (def.offset?.[0] ?? 0), at.z + (def.offset?.[1] ?? 0), CAR_CLEARANCE),
      yaw: def.yaw ?? null,
      locked: def.locked,
      hackable: def.hackable,
      hull: def.hull,
      mission: true,
    };
  }
  const s = map.spawns[id];
  if (!s) return null;
  return { variant: s.variant, x: s.pos[0], z: s.pos[2], yaw: s.yaw, locked: s.locked, hackable: false, hull: 1, mission: false };
}

export function resolveActorDef(map: MapContent, mission: Mission | null, ref: string): (ActorDef & Pos) | null {
  const [, id] = splitRef(ref);
  const def = mission?.actors?.[id];
  if (!def) return null;
  const at = markerPos(map, splitRef(def.at)[1]);
  if (!at) return null;
  return { ...def, ...freeSpot(map, at.x + (def.offset?.[0] ?? 0), at.z + (def.offset?.[1] ?? 0), ACTOR_CLEARANCE) };
}

/** How far from a wall a mission car or actor is placed when its offset lands inside a building. */
export const CAR_CLEARANCE = 3.2;
export const ACTOR_CLEARANCE = 2;

/**
 * Nudges a point out of buildings and inside the city walls, so a spawn or
 * actor offset from a marker never ends up inside a block on a map whose
 * layout the mission author has not seen. Each step pushes out along the
 * shallowest axis; a few passes settle points between neighbouring buildings.
 */
export function freeSpot(map: MapContent, x: number, z: number, clearance: number): Pos {
  const half = Math.min(map.size[0], map.size[1]) / 2 - map.wallThickness - clearance;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    x = Math.max(-half, Math.min(half, x));
    z = Math.max(-half, Math.min(half, z));
    for (const b of map.buildings) {
      const hx = b.w / 2 + clearance;
      const hz = b.d / 2 + clearance;
      const dx = x - b.x;
      const dz = z - b.z;
      if (Math.abs(dx) >= hx || Math.abs(dz) >= hz) continue;
      const px = hx - Math.abs(dx);
      const pz = hz - Math.abs(dz);
      if (px < pz) x = b.x + (dx >= 0 ? hx : -hx);
      else z = b.z + (dz >= 0 ? hz : -hz);
      moved = true;
    }
    if (!moved) break;
  }
  return { x, z };
}

/**
 * Heading for a car standing at (x, z): along the road it is on, in the
 * direction of right-hand traffic for the side of the road it is on. 0 when
 * not near any road.
 */
export function laneYaw(roads: RoadGraph, x: number, z: number, maxLateral = 12): number {
  let best = Infinity;
  let yaw = 0;
  for (const n of roads.nodes) {
    for (const l of n.links) {
      const m = roads.nodes[l]!;
      const dx = m.x - n.x;
      const dz = m.z - n.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      const ux = dx / len;
      const uz = dz / len;
      const t = (x - n.x) * ux + (z - n.z) * uz;
      if (t < 0 || t > len) continue;
      // Right of travel n -> m is (-uz, ux).
      const side = (x - n.x) * -uz + (z - n.z) * ux;
      const lat = Math.abs(side);
      if (lat > maxLateral || lat >= best) continue;
      best = lat;
      yaw = side >= 0 ? Math.atan2(ux, uz) : Math.atan2(-ux, -uz);
    }
  }
  return yaw;
}
