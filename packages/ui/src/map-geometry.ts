/**
 * Map geometry for the minimap and the full-screen map. Rendering is written
 * against this shape only, so the city generator (or Tiled) can feed it
 * without the UI knowing how the world was built.
 *
 * World axes: metres, centred on 0,0; x east, z south (screen down).
 */
export type RoadKind = 'avenue' | 'street' | 'alley' | 'bridge';
export type LandmarkKind = 'clinic' | 'precinct' | 'safehouse' | 'respray' | 'arms' | 'chopshop' | 'payphone' | 'landmark';

export interface MapGeometry {
  size: [number, number];
  roads: { x0: number; z0: number; x1: number; z1: number; width: number; kind: RoadKind }[];
  buildings: { x: number; z: number; w: number; d: number; h: number }[];
  water: { x: number; z: number; w: number; d: number }[];
  parks: { x: number; z: number; w: number; d: number }[];
  districts: { id: string; name: string; colour: string; x: number; z: number; w: number; d: number }[];
  landmarks: { id: string; label: string; kind: LandmarkKind; x: number; z: number }[];
}

/** A world-space point on a route. */
export interface RoutePoint {
  x: number;
  z: number;
}

/**
 * GPS route provider. The sim's road graph implements this; until it exists the
 * UI uses {@link straightRoute}. Must return at least [from, to] when a route exists.
 */
export type RouteFn = (fromX: number, fromZ: number, toX: number, toZ: number) => RoutePoint[];

export const straightRoute: RouteFn = (fx, fz, tx, tz) => [
  { x: fx, z: fz },
  { x: tx, z: tz },
];

/** The current block map's shape (content/map/block0.json), only the parts the map needs. */
export interface BlockMapLike {
  size: [number, number];
  roads: { positions: number[]; width: number; extent: number };
  buildings: { x: number; z: number; w: number; d: number; h: number }[];
  markers?: Record<string, { pos: [number, number, number] | number[] }>;
}

const MARKER_KINDS: [RegExp, LandmarkKind, string][] = [
  [/clinic/, 'clinic', 'Clinic'],
  [/chop/, 'chopshop', 'Chop shop'],
  [/precinct|police/, 'precinct', 'Precinct'],
  [/safe/, 'safehouse', 'Safehouse'],
  [/respray|paint/, 'respray', 'Respray'],
  [/arms|gun/, 'arms', 'Arms dealer'],
];

/**
 * Adapter for the Phase 0 block map: a grid of crossing roads, buildings, one
 * district, no water or parks. Named markers that look like services become landmarks.
 */
export function geometryFromBlockMap(map: BlockMapLike): MapGeometry {
  const { positions, width, extent } = map.roads;
  const roads: MapGeometry['roads'] = [];
  for (const p of positions) {
    roads.push({ x0: -extent, z0: p, x1: extent, z1: p, width, kind: 'avenue' });
    roads.push({ x0: p, z0: -extent, x1: p, z1: extent, width, kind: 'avenue' });
  }
  const landmarks: MapGeometry['landmarks'] = [];
  for (const [id, m] of Object.entries(map.markers ?? {})) {
    const hit = MARKER_KINDS.find(([re]) => re.test(id));
    if (!hit) continue;
    landmarks.push({ id, label: hit[2], kind: hit[1], x: Number(m.pos[0]), z: Number(m.pos[2]) });
  }
  const [w, d] = map.size;
  return {
    size: [w, d],
    roads,
    buildings: map.buildings,
    water: [],
    parks: [],
    districts: [{ id: 'block0', name: 'Kowloon Flats', colour: '#ff2bd6', x: 0, z: 0, w, d }],
    landmarks,
  };
}

/** The generated city's shape (packages/sim citygen `GeneratedMap`), only the parts the map needs. */
export interface CityMapLike {
  size: [number, number];
  roads: { segments: { x0: number; z0: number; x1: number; z1: number; width: number; kind: string }[] };
  buildings: { x: number; z: number; w: number; d: number; h: number }[];
  water: { x: number; z: number; w: number; d: number }[];
  blocks: { x0: number; z0: number; x1: number; z1: number; kind: string }[];
  districts: { id: string; name: string; colour: string; rects: [number, number, number, number][] }[];
  markers: Record<string, { pos: [number, number, number] | number[] }>;
}

/** Named city markers shown as landmarks (others, like spawn points and bridges, stay off the map). */
const CITY_LANDMARKS: Record<string, string> = {
  central_tower: 'Central Tower',
  plaza: 'The Plaza',
  stadium: 'Stadium',
  river_overlook: 'River Overlook',
  rail_yard: 'Rail Yard',
  junkyard: 'Junkyard',
  market_square: 'Market Square',
  dock_cranes: 'Dock Cranes',
  gas_station_1: 'Fuel',
  gas_station_2: 'Fuel',
  rooftop_car_park: 'Rooftop Car Park',
};

/**
 * Adapter for the generated city: road segments, water, parks from park
 * blocks, one district entry per district rectangle, service markers as
 * landmarks (clinic_north -> Clinic, armsshop_1 -> Arms dealer...).
 */
export function geometryFromCityMap(map: CityMapLike): MapGeometry {
  const kinds: RoadKind[] = ['avenue', 'street', 'alley', 'bridge'];
  const roads = map.roads.segments.map((r) => ({ ...r, kind: (kinds as string[]).includes(r.kind) ? (r.kind as RoadKind) : 'street' }));
  const parks = map.blocks
    .filter((b) => b.kind === 'park')
    .map((b) => ({ x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, w: b.x1 - b.x0, d: b.z1 - b.z0 }));
  const districts: MapGeometry['districts'] = [];
  for (const d of map.districts) {
    for (const [x0, z0, x1, z1] of d.rects) {
      districts.push({ id: d.id, name: d.name, colour: d.colour, x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 });
    }
  }
  const landmarks: MapGeometry['landmarks'] = [];
  for (const [id, m] of Object.entries(map.markers)) {
    const x = Number(m.pos[0]);
    const z = Number(m.pos[2]);
    const hit = MARKER_KINDS.find(([re]) => re.test(id));
    if (hit) landmarks.push({ id, label: hit[2], kind: hit[1], x, z });
    else if (CITY_LANDMARKS[id]) landmarks.push({ id, label: CITY_LANDMARKS[id], kind: 'landmark', x, z });
  }
  return { size: map.size, roads, buildings: map.buildings, water: map.water, parks, districts, landmarks };
}

/** Pick the adapter from the map's shape: the generated city has road segments, the old block a road grid. */
export function geometryFromMap(map: CityMapLike | BlockMapLike): MapGeometry {
  return 'segments' in map.roads ? geometryFromCityMap(map as CityMapLike) : geometryFromBlockMap(map as BlockMapLike);
}

/** Which district contains a point (first match), or null. */
export function districtAt(geom: MapGeometry, x: number, z: number): MapGeometry['districts'][number] | null {
  for (const d of geom.districts) {
    if (Math.abs(x - d.x) <= d.w / 2 && Math.abs(z - d.z) <= d.d / 2) return d;
  }
  return null;
}

/** Length of a polyline in metres. */
export function routeLength(route: readonly RoutePoint[]): number {
  let len = 0;
  for (let i = 1; i < route.length; i++) len += Math.hypot(route[i]!.x - route[i - 1]!.x, route[i]!.z - route[i - 1]!.z);
  return len;
}

/** Distance from a point to the nearest segment of a polyline. */
export function distanceToRoute(route: readonly RoutePoint[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(a.x + dx * t - x, a.z + dz * t - z));
  }
  return route.length === 1 ? Math.hypot(route[0]!.x - x, route[0]!.z - z) : best;
}
