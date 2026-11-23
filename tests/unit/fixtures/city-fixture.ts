/**
 * A small, deterministic stand-in for the generated Vey City, used by unit
 * tests, the mission bot regression tests and `pnpm mission-lint --map fixture`
 * until the real city lands. It has every marker id of the guaranteed marker
 * vocabulary at plausible positions:
 *
 * - per district d in glass, lantern, saltworks, ashgrove, undercroft:
 *   d_payphone_1..4 (pavement), d_lot_1..4 (open yard), d_road_1..8 (lane centre),
 *   d_door_1..6 (pavement at a building front)
 * - the landmarks listed in LANDMARKS.
 *
 * Layout: a 520 m square with a 7 × 7 road grid (80 m apart). North is -z.
 * Lantern Row is north-west, Ashgrove east, the Undercroft west, the Glass
 * Quarter in the middle and the Saltworks along the south.
 */
import type { MapContent } from '@neonheat/sim';

export const DISTRICTS = ['glass', 'lantern', 'saltworks', 'ashgrove', 'undercroft'] as const;
export type District = (typeof DISTRICTS)[number];

export const LANDMARKS = [
  'player_start',
  'clinic_north',
  'clinic_south',
  'precinct_north',
  'precinct_south',
  'safehouse_1',
  'safehouse_2',
  'safehouse_3',
  'respray_1',
  'respray_2',
  'armsshop_1',
  'armsshop_2',
  'chopshop_1',
  'chopshop_2',
  'bridge_west',
  'bridge_central',
  'bridge_east',
  'dock_cranes',
  'central_tower',
  'plaza',
  'stadium',
  'river_overlook',
  'rail_yard',
  'junkyard',
  'market_square',
  'park_ashgrove',
  'gas_station_1',
  'gas_station_2',
  'rooftop_car_park',
  'tunnel_mouth',
] as const;

/** Every marker id the city generator guarantees. */
export function markerVocabulary(): string[] {
  const out: string[] = [...LANDMARKS];
  for (const d of DISTRICTS) {
    for (let i = 1; i <= 4; i++) out.push(`${d}_payphone_${i}`, `${d}_lot_${i}`);
    for (let i = 1; i <= 8; i++) out.push(`${d}_road_${i}`);
    for (let i = 1; i <= 6; i++) out.push(`${d}_door_${i}`);
  }
  return out;
}

const ROADS = [-240, -160, -80, 0, 80, 160, 240];
const ROAD_WIDTH = 14;
const LANE = 3.5;
const HALF = ROAD_WIDTH / 2;
/** Pavement runs from the kerb (7 m from the road centre) to the building line (11 m). */
const PAVE = 9;
const SETBACK = 11;

/** District of block (bx, bz); bz = 0 is the northern row. */
function districtOf(bx: number, bz: number): District {
  if (bz >= 4) return 'saltworks';
  if (bx >= 4) return 'ashgrove';
  if (bx <= 1 && bz <= 1) return 'lantern';
  if (bx <= 1) return 'undercroft';
  return 'glass';
}

interface Block {
  bx: number;
  bz: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  cx: number;
  cz: number;
  district: District;
  /** An open yard: no buildings, valid to park cars. */
  yard: boolean;
}

/** Hand-picked open yards: at least one per district, plus a few landmark yards. */
const YARDS = new Set(['5,1', '4,3', '0,0', '1,1', '2,2', '3,1', '0,3', '1,2', '1,4', '4,5', '3,5', '5,4']);

function blocks(): Block[] {
  const out: Block[] = [];
  for (let bz = 0; bz < ROADS.length - 1; bz++) {
    for (let bx = 0; bx < ROADS.length - 1; bx++) {
      const x0 = ROADS[bx]!;
      const x1 = ROADS[bx + 1]!;
      const z0 = ROADS[bz]!;
      const z1 = ROADS[bz + 1]!;
      out.push({ bx, bz, x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, district: districtOf(bx, bz), yard: YARDS.has(`${bx},${bz}`) });
    }
  }
  return out;
}

function yards(all: Block[], d: District): Block {
  return all.find((b) => b.district === d && b.yard)!;
}

/** Pavement points around a block: four per side, on the pavement band. */
function pavementSlots(b: Block): [number, number][] {
  const out: [number, number][] = [];
  for (const t of [-24, -8, 8, 24]) {
    out.push([b.cx + t, b.z0 + PAVE]); // north side
    out.push([b.x1 - PAVE, b.cz + t]); // east side
    out.push([b.cx - t, b.z1 - PAVE]); // south side
    out.push([b.x0 + PAVE, b.cz - t]); // west side
  }
  return out;
}

/** Lane-centre points on road segments bordering a block (right-hand traffic). */
function roadSlots(b: Block): [number, number][] {
  return [
    [b.cx - 12, b.z0 + LANE], // north road, eastbound lane (right-hand traffic)
    [b.x1 - LANE, b.cz - 12],
    [b.cx + 12, b.z1 - LANE],
    [b.x0 + LANE, b.cz + 12],
    [b.cx + 20, b.z0 - LANE],
    [b.x1 + LANE, b.cz + 20],
  ];
}

export function fixtureCity(): MapContent {
  const all = blocks();
  const buildings: MapContent['buildings'] = [];
  for (const b of all) {
    if (b.yard) continue;
    // Four buildings around a 6 m cross of alleys.
    const inner = b.x1 - b.x0 - SETBACK * 2;
    const size = (inner - 6) / 2;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const h = 10 + (((b.bx * 7 + b.bz * 13 + sx * 3 + sz * 5) % 5) + 5) % 5 * 6;
        buildings.push({ x: b.cx + sx * (size / 2 + 3), z: b.cz + sz * (size / 2 + 3), w: size, d: size, h });
      }
    }
  }

  const markers: MapContent['markers'] = {};
  const used = new Set<string>();
  const put = (id: string, x: number, z: number): void => {
    if (markers[id]) throw new Error(`fixture: duplicate marker ${id}`);
    markers[id] = { pos: [x, 0, z] };
    used.add(`${x},${z}`);
  };
  const free = (p: [number, number]): boolean => !used.has(`${p[0]},${p[1]}`);

  // Landmarks first, at fixed blocks so their geography reads sensibly.
  const at = (bx: number, bz: number): Block => all.find((b) => b.bx === bx && b.bz === bz)!;
  const yardSpot = (b: Block, dx: number, dz: number): [number, number] => [b.cx + dx, b.cz + dz];
  const landmarkPlan: Record<string, [Block, number]> = {
    clinic_north: [at(2, 0), 0],
    clinic_south: [at(2, 5), 2],
    precinct_north: [at(3, 0), 1],
    precinct_south: [at(5, 5), 2],
    safehouse_1: [at(5, 2), 3],
    safehouse_2: [at(2, 3), 5],
    safehouse_3: [at(0, 5), 1],
    respray_1: [at(4, 1), 6],
    respray_2: [at(0, 2), 9],
    armsshop_1: [at(3, 2), 4],
    armsshop_2: [at(1, 0), 7],
    chopshop_1: [at(4, 2), 10],
    chopshop_2: [at(2, 4), 3],
    bridge_west: [at(0, 3), 2],
    bridge_central: [at(3, 3), 2],
    bridge_east: [at(5, 3), 2],
    central_tower: [at(3, 2), 0],
    plaza: [at(2, 1), 12],
    stadium: [at(4, 0), 1],
    river_overlook: [at(4, 3), 2],
    market_square: [at(0, 1), 8],
    park_ashgrove: [at(5, 1), 2],
    gas_station_1: [at(4, 2), 3],
    gas_station_2: [at(1, 3), 5],
    tunnel_mouth: [at(0, 4), 7],
  };
  for (const [id, [b, slot]] of Object.entries(landmarkPlan)) {
    const s = pavementSlots(b)[slot]!;
    put(id, s[0], s[1]);
  }
  // Yard landmarks sit inside open yards.
  put('dock_cranes', ...yardSpot(at(3, 5), 0, 18));
  put('junkyard', ...yardSpot(at(0, 3), -18, 0));
  put('rail_yard', ...yardSpot(at(1, 2), 0, -18));
  put('rooftop_car_park', ...yardSpot(at(2, 2), 18, 18));
  // Ashgrove: the player starts on the pavement beside Vesper's yard.
  const start = pavementSlots(at(5, 2))[7]!;
  put('player_start', start[0], start[1]);
  put('clinic', markers['clinic_north']!.pos[0], markers['clinic_north']!.pos[2]);

  // Per-district vocabulary.
  for (const d of DISTRICTS) {
    const mine = all.filter((b) => b.district === d);
    const yards = mine.filter((b) => b.yard);
    const built = mine.filter((b) => !b.yard);
    // Lots: four spots in the district's first yard (12 m apart).
    const yard = yards[0]!;
    [
      [-12, -12],
      [12, -12],
      [-12, 12],
      [12, 12],
    ].forEach(([dx, dz], i) => put(`${d}_lot_${i + 1}`, ...yardSpot(yard, dx!, dz!)));
    const take = (list: [number, number][], stride: number, id: string): void => {
      for (let k = 0, i = stride; k < list.length; k++, i = (i + stride) % list.length) {
        const p = list[i]!;
        if (free(p)) return put(id, p[0], p[1]);
      }
      throw new Error(`fixture: no slot for ${id}`);
    };
    const pave = built.flatMap((b) => pavementSlots(b));
    for (let i = 1; i <= 6; i++) take(pave, 5, `${d}_door_${i}`);
    for (let i = 1; i <= 4; i++) take(pave, 7, `${d}_payphone_${i}`);
    const roads = mine.flatMap((b) => roadSlots(b));
    for (let i = 1; i <= 8; i++) take(roads, 5, `${d}_road_${i}`);
  }

  const startBlock = at(5, 2);
  const lanternYard = yards(all, 'lantern');
  const saltYard = yards(all, 'saltworks');
  const spawns: MapContent['spawns'] = {
    // A car parked at the kerb beside the start, as in the old block.
    starter_car: { variant: 'kestrel', pos: [startBlock.x0 - 5.95, 0, start[1] - 4], yaw: Math.PI, locked: false },
    parked_vandal_lantern: { variant: 'vandal', pos: [lanternYard.cx, 0, lanternYard.cz], yaw: 0, locked: false },
    parked_brick_salt: { variant: 'brick', pos: [saltYard.cx, 0, saltYard.cz], yaw: Math.PI / 2, locked: false },
  };

  const loops = [
    { id: 'ring_cw', points: [[-240, -240], [240, -240], [240, 240], [-240, 240]] as [number, number][] },
    { id: 'mid_ccw', points: [[-160, -160], [-160, 160], [160, 160], [160, -160]] as [number, number][] },
    { id: 'inner_cw', points: [[-80, -80], [80, -80], [80, 80], [-80, 80]] as [number, number][] },
    { id: 'east_ccw', points: [[80, -240], [80, 160], [240, 160], [240, -240]] as [number, number][] },
    { id: 'south_cw', points: [[-240, 80], [240, 80], [240, 240], [-240, 240]] as [number, number][] },
  ];

  return {
    id: 'vey_fixture',
    size: [520, 520],
    roads: { positions: ROADS, width: ROAD_WIDTH, laneOffset: LANE, extent: 247, kerbHeight: 0.18, lampInset: 0.9, lampSpacing: 24 },
    wallThickness: 4,
    buildings,
    props: [],
    markers,
    spawns,
    traffic: { loops },
  };
}

export { HALF as FIXTURE_ROAD_HALF_WIDTH };
