import type { MapGeometry, RoadKind, RoutePoint } from './map-geometry';

/**
 * Shared map painter. The geometry is turned into a handful of Path2D objects
 * in world coordinates once (one per colour bucket), so a redraw is a few
 * fills under a transform, cheap enough for pan and pinch at 60 fps.
 */
export const MAP_COLOURS = {
  void: '#05060e',
  ground: '#0d0f23',
  park: '#0d2a22',
  parkEdge: '#1d6b4a',
  water: '#061a36',
  waterEdge: '#1f6fb8',
  roads: { avenue: '#2d3468', street: '#262c59', alley: '#1d2246', bridge: '#3a4386' } as Record<RoadKind, string>,
  roadLine: 'rgba(160, 200, 255, 0.22)',
  buildings: ['#151631', '#1a1b3b', '#202146', '#272853'],
  buildingEdge: 'rgba(150, 130, 255, 0.28)',
  route: '#d7ff2b',
};

export interface PreparedMap {
  geom: MapGeometry;
  ground: Path2D;
  parks: Path2D;
  water: Path2D;
  roads: Map<RoadKind, Path2D>;
  roadOrder: RoadKind[];
  centreLines: Path2D;
  buildings: Path2D[];
}

function rectPath(p: Path2D, x: number, z: number, w: number, d: number): void {
  p.rect(x - w / 2, z - d / 2, w, d);
}

export function prepareMap(geom: MapGeometry): PreparedMap {
  const ground = new Path2D();
  ground.rect(-geom.size[0] / 2, -geom.size[1] / 2, geom.size[0], geom.size[1]);
  const parks = new Path2D();
  for (const r of geom.parks) rectPath(parks, r.x, r.z, r.w, r.d);
  const water = new Path2D();
  for (const r of geom.water) rectPath(water, r.x, r.z, r.w, r.d);
  const roads = new Map<RoadKind, Path2D>();
  const centreLines = new Path2D();
  for (const r of geom.roads) {
    let p = roads.get(r.kind);
    if (!p) roads.set(r.kind, (p = new Path2D()));
    const dx = r.x1 - r.x0;
    const dz = r.z1 - r.z0;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    // Quad extended by half the width at each end, so crossings fill in.
    const hw = r.width / 2;
    const ax = r.x0 - ux * hw;
    const az = r.z0 - uz * hw;
    const bx = r.x1 + ux * hw;
    const bz = r.z1 + uz * hw;
    const nx = -uz * hw;
    const nz = ux * hw;
    p.moveTo(ax + nx, az + nz);
    p.lineTo(bx + nx, bz + nz);
    p.lineTo(bx - nx, bz - nz);
    p.lineTo(ax - nx, az - nz);
    p.closePath();
    if (r.kind === 'avenue' || r.kind === 'bridge') {
      centreLines.moveTo(r.x0, r.z0);
      centreLines.lineTo(r.x1, r.z1);
    }
  }
  const buildings = MAP_COLOURS.buildings.map(() => new Path2D());
  for (const b of geom.buildings) {
    const bucket = Math.min(buildings.length - 1, Math.floor((b.h / 48) * buildings.length));
    rectPath(buildings[bucket]!, b.x, b.z, b.w, b.d);
  }
  const roadOrder: RoadKind[] = ['alley', 'street', 'avenue', 'bridge'];
  return { geom, ground, parks, water, roads, roadOrder, centreLines, buildings };
}

/**
 * Paint the static map. The context's transform must already map world metres
 * to pixels; `pxPerM` is that scale, used to keep outlines a constant pixel width.
 */
export function paintMap(c: CanvasRenderingContext2D, m: PreparedMap, pxPerM: number, opts: { districts?: boolean; centreLines?: boolean } = {}): void {
  const px = 1 / pxPerM;
  c.fillStyle = MAP_COLOURS.ground;
  c.fill(m.ground);
  // Tint districts only when there is more than one: the tint is there to tell them apart.
  if (opts.districts !== false && m.geom.districts.length > 1) {
    for (const d of m.geom.districts) {
      c.globalAlpha = 0.07;
      c.fillStyle = d.colour;
      c.fillRect(d.x - d.w / 2, d.z - d.d / 2, d.w, d.d);
    }
    c.globalAlpha = 1;
  }
  c.fillStyle = MAP_COLOURS.park;
  c.fill(m.parks);
  c.strokeStyle = MAP_COLOURS.parkEdge;
  c.lineWidth = 1.2 * px;
  c.stroke(m.parks);
  c.fillStyle = MAP_COLOURS.water;
  c.fill(m.water);
  c.strokeStyle = MAP_COLOURS.waterEdge;
  c.lineWidth = 1.5 * px;
  c.stroke(m.water);
  for (const k of m.roadOrder) {
    const p = m.roads.get(k);
    if (!p) continue;
    c.fillStyle = MAP_COLOURS.roads[k];
    c.fill(p);
  }
  if (opts.centreLines) {
    c.strokeStyle = MAP_COLOURS.roadLine;
    c.lineWidth = 1 * px;
    c.setLineDash([6 * px, 6 * px]);
    c.stroke(m.centreLines);
    c.setLineDash([]);
  }
  m.buildings.forEach((p, i) => {
    c.fillStyle = MAP_COLOURS.buildings[i]!;
    c.fill(p);
  });
  if (pxPerM > 1.2) {
    c.strokeStyle = MAP_COLOURS.buildingEdge;
    c.lineWidth = 1 * px;
    for (const p of m.buildings) c.stroke(p);
  }
  if (opts.districts !== false && m.geom.districts.length > 1) {
    c.lineWidth = 1.5 * px;
    c.setLineDash([5 * px, 4 * px]);
    for (const d of m.geom.districts) {
      c.strokeStyle = d.colour;
      c.globalAlpha = 0.45;
      c.strokeRect(d.x - d.w / 2, d.z - d.d / 2, d.w, d.d);
    }
    c.setLineDash([]);
    c.globalAlpha = 1;
  }
}

/**
 * GPS line: a dark casing under a bright acid line with moving dashes. Points
 * are mapped through `toPx`. Draws nothing for fewer than two points.
 */
export function strokeRoute(
  c: CanvasRenderingContext2D,
  route: readonly RoutePoint[],
  toPx: (x: number, z: number) => [number, number],
  width: number,
  time: number,
): void {
  if (route.length < 2) return;
  c.save();
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.beginPath();
  for (let i = 0; i < route.length; i++) {
    const [x, y] = toPx(route[i]!.x, route[i]!.z);
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.strokeStyle = 'rgba(5, 6, 14, 0.85)';
  c.lineWidth = width + 3;
  c.stroke();
  c.strokeStyle = MAP_COLOURS.route;
  c.shadowColor = MAP_COLOURS.route;
  c.shadowBlur = width * 1.5;
  c.lineWidth = width;
  c.stroke();
  c.shadowBlur = 0;
  c.strokeStyle = 'rgba(5, 6, 14, 0.55)';
  c.lineWidth = Math.max(1, width * 0.35);
  c.setLineDash([width * 1.2, width * 2.8]);
  c.lineDashOffset = -time * width * 6;
  c.stroke();
  c.restore();
}

/** The player's arrow, pointing along `angle` (canvas radians, 0 = up the screen). */
export function drawPlayerArrow(c: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number): void {
  c.save();
  c.translate(x, y);
  c.rotate(angle);
  c.beginPath();
  c.moveTo(0, -size);
  c.lineTo(size * 0.72, size * 0.72);
  c.lineTo(0, size * 0.36);
  c.lineTo(-size * 0.72, size * 0.72);
  c.closePath();
  c.lineJoin = 'round';
  c.lineWidth = Math.max(2, size * 0.28);
  c.strokeStyle = '#05060e';
  c.stroke();
  c.fillStyle = '#ffffff';
  c.shadowColor = '#21f0ff';
  c.shadowBlur = size;
  c.fill();
  c.restore();
}

/** The objective marker: a pulsing magenta ring with a dot. */
export function drawObjective(c: CanvasRenderingContext2D, x: number, y: number, r: number, time: number): void {
  const pulse = 1 + 0.18 * Math.sin(time * 6);
  c.save();
  c.strokeStyle = 'rgba(5, 6, 14, 0.9)';
  c.lineWidth = r * 0.55 + 2;
  c.beginPath();
  c.arc(x, y, r * pulse, 0, Math.PI * 2);
  c.stroke();
  c.strokeStyle = '#ff2bd6';
  c.shadowColor = '#ff2bd6';
  c.shadowBlur = r;
  c.lineWidth = r * 0.42;
  c.stroke();
  c.fillStyle = '#ff2bd6';
  c.beginPath();
  c.arc(x, y, r * 0.32, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/** A waypoint flag: acid-yellow pin. */
export function drawWaypoint(c: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  c.save();
  c.translate(x, y);
  c.beginPath();
  c.moveTo(0, 0);
  c.bezierCurveTo(-size * 0.2, -size * 0.5, -size * 0.62, -size * 0.7, -size * 0.62, -size * 1.15);
  c.arc(0, -size * 1.15, size * 0.62, Math.PI, 0);
  c.bezierCurveTo(size * 0.62, -size * 0.7, size * 0.2, -size * 0.5, 0, 0);
  c.closePath();
  c.lineWidth = Math.max(2, size * 0.2);
  c.strokeStyle = '#05060e';
  c.stroke();
  c.fillStyle = '#d7ff2b';
  c.shadowColor = '#d7ff2b';
  c.shadowBlur = size * 0.8;
  c.fill();
  c.shadowBlur = 0;
  c.fillStyle = '#05060e';
  c.beginPath();
  c.arc(0, -size * 1.15, size * 0.24, 0, Math.PI * 2);
  c.fill();
  c.restore();
}
