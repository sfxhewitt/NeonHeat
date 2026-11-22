import type { MapContent } from './content';

/**
 * Road graph: one node per intersection of the road grid, edges along roads.
 * Small enough (16 nodes) that a BFS per query is cheaper than caching.
 */
export interface NavNode {
  id: number;
  x: number;
  z: number;
  links: number[];
}

export class RoadGraph {
  readonly nodes: NavNode[] = [];
  private readonly queue: number[] = [];
  private readonly prev: Int32Array;
  readonly halfWidth: number;
  readonly positions: readonly number[];

  constructor(map: MapContent) {
    const p = map.roads.positions;
    this.positions = p;
    this.halfWidth = map.roads.width / 2;
    const n = p.length;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const links: number[] = [];
        if (ix > 0) links.push(iz * n + ix - 1);
        if (ix < n - 1) links.push(iz * n + ix + 1);
        if (iz > 0) links.push((iz - 1) * n + ix);
        if (iz < n - 1) links.push((iz + 1) * n + ix);
        this.nodes.push({ id: iz * n + ix, x: p[ix]!, z: p[iz]!, links });
      }
    }
    this.prev = new Int32Array(this.nodes.length);
  }

  nearest(x: number, z: number): NavNode {
    let best = this.nodes[0]!;
    let bd = Infinity;
    for (const node of this.nodes) {
      const d = (node.x - x) ** 2 + (node.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = node;
      }
    }
    return best;
  }

  /** True if (x, z) lies on a road surface. */
  onRoad(x: number, z: number): boolean {
    const ext = this.positions[this.positions.length - 1]! + this.halfWidth;
    if (Math.abs(x) > ext || Math.abs(z) > ext) return false;
    for (const r of this.positions) {
      if (Math.abs(x - r) <= this.halfWidth || Math.abs(z - r) <= this.halfWidth) return true;
    }
    return false;
  }

  /**
   * Next node to head for when travelling from node `from` to node `to`
   * (BFS shortest path in hops). Returns `to` when already adjacent or equal.
   */
  nextHop(from: number, to: number): number {
    if (from === to) return to;
    const prev = this.prev;
    prev.fill(-1);
    const q = this.queue;
    q.length = 0;
    q.push(from);
    prev[from] = from;
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi]!;
      if (cur === to) break;
      for (const l of this.nodes[cur]!.links) {
        if (prev[l] === -1) {
          prev[l] = cur;
          q.push(l);
        }
      }
    }
    if (prev[to] === -1) return from;
    let step = to;
    while (prev[step] !== from) step = prev[step]!;
    return step;
  }

  /** Full node path from `from` to `to` inclusive. */
  path(from: number, to: number): number[] {
    const out = [from];
    let cur = from;
    let guard = 0;
    while (cur !== to && guard++ < this.nodes.length) {
      cur = this.nextHop(cur, to);
      out.push(cur);
    }
    return out;
  }
}

/** A closed lane polyline, already offset to the right-hand side of travel. */
export class LaneLoop {
  readonly xs: Float64Array;
  readonly zs: Float64Array;
  /** Cumulative arc length at each vertex; last entry is the loop length. */
  readonly cum: Float64Array;
  readonly length: number;

  constructor(
    readonly id: string,
    points: readonly (readonly [number, number])[],
    laneOffset: number,
  ) {
    const n = points.length;
    this.xs = new Float64Array(n);
    this.zs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const [px, pz] = points[i]!;
      const [ax, az] = points[(i - 1 + n) % n]!;
      const [bx, bz] = points[(i + 1) % n]!;
      const [rinX, rinZ] = rightOf(px - ax, pz - az);
      const [routX, routZ] = rightOf(bx - px, bz - pz);
      this.xs[i] = px + (rinX + routX) * laneOffset;
      this.zs[i] = pz + (rinZ + routZ) * laneOffset;
    }
    this.cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.cum[i + 1] = this.cum[i]! + Math.hypot(this.xs[j]! - this.xs[i]!, this.zs[j]! - this.zs[i]!);
    }
    this.length = this.cum[n]!;
  }

  get count(): number {
    return this.xs.length;
  }

  /** Point at arc length s (wrapped) written into out. Returns segment index. */
  pointAt(s: number, out: { x: number; z: number }): number {
    s = ((s % this.length) + this.length) % this.length;
    const n = this.count;
    let i = 0;
    while (i < n - 1 && this.cum[i + 1]! < s) i++;
    const j = (i + 1) % n;
    const segLen = this.cum[i + 1]! - this.cum[i]!;
    const t = segLen > 0 ? (s - this.cum[i]!) / segLen : 0;
    out.x = this.xs[i]! + (this.xs[j]! - this.xs[i]!) * t;
    out.z = this.zs[i]! + (this.zs[j]! - this.zs[i]!) * t;
    return i;
  }

  /** Arc length of the closest point on the loop to (x, z). */
  project(x: number, z: number): number {
    const n = this.count;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = this.xs[i]!;
      const az = this.zs[i]!;
      const dx = this.xs[j]! - ax;
      const dz = this.zs[j]! - az;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
      const px = ax + dx * t;
      const pz = az + dz * t;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < bd) {
        bd = d;
        best = this.cum[i]! + t * Math.sqrt(len2);
      }
    }
    return best;
  }

  /** Arc length of the next corner after s, and distance to it. */
  distanceToNextCorner(s: number): number {
    s = ((s % this.length) + this.length) % this.length;
    for (let i = 1; i <= this.count; i++) if (this.cum[i]! > s) return this.cum[i]! - s;
    return 0;
  }
}

/** Driver's right-hand side for travel direction (dx, dz), normalised. */
export function rightOf(dx: number, dz: number): [number, number] {
  const len = Math.hypot(dx, dz) || 1;
  return [-dz / len, dx / len];
}
