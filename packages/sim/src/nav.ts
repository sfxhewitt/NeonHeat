import type { MapContent } from './content';
import type { RoadKind, RoadSegment } from './citygen';
import { cityGrid, Cell } from './street';

/**
 * Road graph: a node at every junction and road end, edges along the roads
 * between them. Shortest paths by distance (Dijkstra), with one shortest-path
 * tree cached per destination, so many cars heading the same way cost one search.
 */
export interface NavNode {
  id: number;
  x: number;
  z: number;
  /** Neighbouring node ids (any road kind). */
  links: number[];
  /** Edge ids, parallel to links. */
  edges: number[];
  /** Junction with three or more ways out (traffic lights live here). */
  junction: boolean;
}

export interface NavEdge {
  id: number;
  a: number;
  b: number;
  length: number;
  width: number;
  kind: RoadKind;
  /** The edge runs along x (east-west) rather than z. */
  alongX: boolean;
}

export interface Point {
  x: number;
  z: number;
}

const ALLEY_COST = 1.6;

export class RoadGraph {
  readonly nodes: NavNode[] = [];
  readonly edges: NavEdge[] = [];
  private readonly map: MapContent;
  private readonly trees = new Map<number, Int32Array>();
  private readonly treeOrder: number[] = [];
  private readonly dist: Float64Array;
  private readonly heap: number[] = [];
  private readonly buckets = new Map<number, number[]>();

  constructor(map: MapContent) {
    this.map = map;
    const key = (x: number, z: number): string => `${Math.round(x * 10)},${Math.round(z * 10)}`;
    const ids = new Map<string, number>();
    const node = (x: number, z: number): number => {
      const k = key(x, z);
      let id = ids.get(k);
      if (id === undefined) {
        id = this.nodes.length;
        ids.set(k, id);
        this.nodes.push({ id, x, z, links: [], edges: [], junction: false });
      }
      return id;
    };
    const segs = map.roads.segments;
    const eps = 0.5;
    for (const s of segs) {
      const alongX = s.z0 === s.z1;
      const stops = new Set<number>([alongX ? s.x0 : s.z0, alongX ? s.x1 : s.z1]);
      for (const o of segs) {
        if (o === s) continue;
        const oAlongX = o.z0 === o.z1;
        if (oAlongX === alongX) continue;
        // Perpendicular: crossing point is (o.x0, s.z0) for an east-west s, or (s.x0, o.z0) for north-south s.
        if (alongX) {
          if (o.x0 >= s.x0 - eps && o.x0 <= s.x1 + eps && s.z0 >= o.z0 - eps && s.z0 <= o.z1 + eps) stops.add(o.x0);
        } else if (o.z0 >= s.z0 - eps && o.z0 <= s.z1 + eps && s.x0 >= o.x0 - eps && s.x0 <= o.x1 + eps) stops.add(o.z0);
      }
      const ts = [...stops].sort((p, q) => p - q);
      for (let i = 0; i < ts.length - 1; i++) {
        const t0 = ts[i]!;
        const t1 = ts[i + 1]!;
        if (t1 - t0 < 0.5) continue;
        const a = alongX ? node(t0, s.z0) : node(s.x0, t0);
        const b = alongX ? node(t1, s.z0) : node(s.x0, t1);
        this.link(a, b, t1 - t0, s, alongX);
      }
    }
    for (const n of this.nodes) {
      let main = 0;
      for (const e of n.edges) if (this.edges[e]!.kind !== 'alley') main++;
      n.junction = main >= 3;
      const bk = this.bucketKey(n.x, n.z);
      let b = this.buckets.get(bk);
      if (!b) this.buckets.set(bk, (b = []));
      b.push(n.id);
    }
    this.dist = new Float64Array(this.nodes.length);
  }

  private link(a: number, b: number, length: number, s: RoadSegment, alongX: boolean): void {
    const na = this.nodes[a]!;
    if (na.links.includes(b)) return;
    const id = this.edges.length;
    this.edges.push({ id, a, b, length, width: s.width, kind: s.kind, alongX });
    na.links.push(b);
    na.edges.push(id);
    const nb = this.nodes[b]!;
    nb.links.push(a);
    nb.edges.push(id);
  }

  private bucketKey(x: number, z: number): number {
    return (Math.floor(x / 64) + 64) * 256 + Math.floor(z / 64) + 64;
  }

  /** The nearest node (searching outwards over a coarse grid). */
  nearest(x: number, z: number, filter?: (n: NavNode) => boolean): NavNode {
    let best: NavNode | null = null;
    let bd = Infinity;
    const cx = Math.floor(x / 64);
    const cz = Math.floor(z / 64);
    for (let r = 0; r < 30; r++) {
      for (let gx = cx - r; gx <= cx + r; gx++) {
        for (let gz = cz - r; gz <= cz + r; gz++) {
          if (Math.max(Math.abs(gx - cx), Math.abs(gz - cz)) !== r) continue;
          const b = this.buckets.get((gx + 64) * 256 + gz + 64);
          if (!b) continue;
          for (const id of b) {
            const n = this.nodes[id]!;
            if (filter && !filter(n)) continue;
            const d = (n.x - x) ** 2 + (n.z - z) ** 2;
            if (d < bd) {
              bd = d;
              best = n;
            }
          }
        }
      }
      // Anything found within this ring is within r*64 m; one more ring makes sure it is the nearest.
      if (best && Math.sqrt(bd) < r * 64) break;
    }
    return best ?? this.nodes[0]!;
  }

  /** True if (x, z) lies on a road surface (alleys included). */
  onRoad(x: number, z: number): boolean {
    return (cityGrid(this.map).at(x, z) & Cell.road) !== 0;
  }

  /** Edge between two adjacent nodes, or null. */
  edgeBetween(a: number, b: number): NavEdge | null {
    const n = this.nodes[a]!;
    const i = n.links.indexOf(b);
    return i < 0 ? null : this.edges[n.edges[i]!]!;
  }

  /** Shortest-path tree towards `to`: next[i] is the node to go to from i (to itself at the goal, -1 unreachable). */
  private tree(to: number): Int32Array {
    const cached = this.trees.get(to);
    if (cached) return cached;
    const n = this.nodes.length;
    const next = new Int32Array(n).fill(-1);
    const dist = this.dist;
    dist.fill(Infinity);
    dist[to] = 0;
    next[to] = to;
    const heap = this.heap;
    heap.length = 0;
    heap.push(to);
    while (heap.length) {
      // Small graphs: a linear-scan priority queue is plenty.
      let bi = 0;
      for (let i = 1; i < heap.length; i++) if (dist[heap[i]!]! < dist[heap[bi]!]!) bi = i;
      const cur = heap[bi]!;
      heap[bi] = heap[heap.length - 1]!;
      heap.pop();
      const nd = this.nodes[cur]!;
      for (let k = 0; k < nd.links.length; k++) {
        const l = nd.links[k]!;
        const e = this.edges[nd.edges[k]!]!;
        const c = dist[cur]! + e.length * (e.kind === 'alley' ? ALLEY_COST : 1);
        if (c < dist[l]!) {
          if (dist[l] === Infinity) heap.push(l);
          dist[l] = c;
          next[l] = cur;
        }
      }
    }
    this.trees.set(to, next);
    this.treeOrder.push(to);
    if (this.treeOrder.length > 48) this.trees.delete(this.treeOrder.shift()!);
    return next;
  }

  /** Next node to head for when travelling from node `from` to node `to`. Returns `to` when equal. */
  nextHop(from: number, to: number): number {
    if (from === to) return to;
    const n = this.tree(to)[from]!;
    return n < 0 ? from : n;
  }

  /** Full node path from `from` to `to` inclusive (just `from` if unreachable). */
  path(from: number, to: number): number[] {
    const out = [from];
    const next = this.tree(to);
    let cur = from;
    let guard = 0;
    while (cur !== to && guard++ < this.nodes.length) {
      const n = next[cur]!;
      if (n < 0) break;
      cur = n;
      out.push(cur);
    }
    return out;
  }

  /** A driving route between two points as a polyline along road centre lines (GPS). */
  route(ax: number, az: number, bx: number, bz: number): Point[] {
    const a = this.nearest(ax, az);
    const b = this.nearest(bx, bz);
    const out: Point[] = [{ x: ax, z: az }];
    for (const id of this.path(a.id, b.id)) out.push({ x: this.nodes[id]!.x, z: this.nodes[id]!.z });
    out.push({ x: bx, z: bz });
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
