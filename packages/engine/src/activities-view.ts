import {
  AdditiveBlending,
  BatchedMesh,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  OctahedronGeometry,
  RingGeometry,
  Shape,
  type Material,
  type Scene,
} from 'three';
import { groundHeight, lerp, rampProfile, rampLength, type RampSite, type World } from '@neonheat/sim';
import { BLOOM_LAYER } from './layers';
import type { LightField } from './lightfield';
import { MeshBuilder } from './mesh-kit';

/** Activity colours: each also has its own shape, so colour is never the only cue. */
export const ActivityColours = {
  rampage: 0xff5a36,
  jump: 0xffb020,
  jumpDone: 0x34ffd0,
  shard: 0xb18cff,
  fare: 0xffd23a,
  gang: 0xff2a4a,
} as const;

type V3 = [number, number, number];

/** Flat triangles with vertex colours, for shapes the box kit cannot make (ramp wedges, chevrons). */
class Tris {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  private readonly c = new Color();

  tri(a: V3, b: V3, c: V3, colour: number, shade = 1): this {
    this.c.setHex(colour).multiplyScalar(shade);
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(this.c.r, this.c.g, this.c.b);
    }
    return this;
  }

  /** a, b, c, d counter-clockwise seen from the front. */
  quad(a: V3, b: V3, c: V3, d: V3, colour: number, shade = 1): this {
    return this.tri(a, b, c, colour, shade).tri(a, c, d, colour, shade);
  }

  /** An axis-aligned box from min and max corners. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, colour: number): this {
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], colour, 1.1); // top
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], colour, 0.95); // +z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], colour, 0.7); // -z
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], colour, 0.85); // +x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], colour, 0.85); // -x
    return this;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const HAZARD_A = 0xd8a21c;
const HAZARD_B = 0x17171f;

/**
 * One stunt ramp in its own frame (x across, z up the ramp, y up): a steel
 * wedge with a kicker, a short deck and a steeper back slope, hazard-striped
 * sides, and low guard rails where the sim has its rail colliders.
 */
function rampBody(r: RampSite): BufferGeometry {
  const t = new Tris();
  const hw = r.width / 2;
  const L = rampLength(r);
  const y = (z: number): number => Math.max(0, rampProfile(r, z));
  // Breakpoints along the ramp, with extra cuts for the side stripes.
  const cuts = new Set<number>([0, r.up, r.up + r.deck, L]);
  for (let z = 0; z < L; z += 0.7) cuts.add(Math.round(z * 100) / 100);
  const zs = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i + 1 < zs.length; i++) {
    const z0 = zs[i]!;
    const z1 = zs[i + 1]!;
    const y0 = y(z0);
    const y1 = y(z1);
    const top = z1 <= r.up ? 0x4a5070 : z1 <= r.up + r.deck ? 0x3c4160 : 0x2c3048;
    const stripe = Math.floor((z0 + 0.01) / 0.7) % 2 === 0 ? HAZARD_A : HAZARD_B;
    // Steel deck plate in the middle, a hazard-striped band along each edge (what the camera sees from above).
    const e = 0.45;
    t.quad([-hw + e, y0 + 0.005, z0], [-hw + e, y1 + 0.005, z1], [hw - e, y1 + 0.005, z1], [hw - e, y0 + 0.005, z0], top, 1.15);
    t.quad([-hw, y0, z0], [-hw, y1, z1], [-hw + e, y1, z1], [-hw + e, y0, z0], stripe, 1.1);
    t.quad([hw - e, y0, z0], [hw - e, y1, z1], [hw, y1, z1], [hw, y0, z0], stripe, 1.1);
    // Tread lines across the kicker.
    if (z1 <= r.up && Math.floor((z0 + 0.01) / 0.7) % 2 === 1) t.quad([-hw + e, y0 + 0.01, z0], [-hw + e, y0 + 0.01, z0 + 0.08], [hw - e, y0 + 0.01, z0 + 0.08], [hw - e, y0 + 0.01, z0], 0x6a7090, 1.1);
    t.quad([hw, 0, z0], [hw, 0, z1], [hw, y1, z1], [hw, y0, z0], stripe, 0.85);
    t.quad([-hw, 0, z1], [-hw, 0, z0], [-hw, y0, z0], [-hw, y1, z1], stripe, 0.85);
  }
  // Back face of the deck is zero height at both ends; nothing to close. Guard rails:
  const a0 = r.up * 0.35;
  const a1 = r.up + r.deck + r.down * 0.65;
  for (const side of [-1, 1]) {
    const x = side * (hw + 0.15);
    t.box(x - 0.12, 0, a0, x + 0.12, 1.15, a1, 0x1d1f2c);
    // Posts.
    for (let z = a0; z <= a1 + 0.01; z += (a1 - a0) / 4) t.box(x - 0.16, 0, z - 0.12, x + 0.16, 1.2, z + 0.12, 0x2b2e3e);
  }
  return t.build();
}

/** A chevron pointing +z: two arms meeting at (cx, z + depth). */
function chevron(t: Tris, cx: number, z: number, halfWidth: number, depth: number, thick: number, y: (z: number) => number, shade: number): void {
  const a: V3 = [cx - halfWidth, 0, z];
  const tip: V3 = [cx, 0, z + depth];
  const tip2: V3 = [cx, 0, z + depth + thick];
  const a2: V3 = [cx - halfWidth, 0, z + thick];
  const b: V3 = [cx + halfWidth, 0, z];
  const b2: V3 = [cx + halfWidth, 0, z + thick];
  for (const p of [a, tip, tip2, a2, b, b2]) p[1] = y(p[2]);
  t.quad(a, a2, tip2, tip, 0xffffff, shade);
  t.quad(b, tip, tip2, b2, 0xffffff, shade);
}

/** The lit parts of a ramp (tinted by the material): kicker chevrons, the lip bar, rail tops and chevrons painted on the run-up. */
function rampGlow(r: RampSite): BufferGeometry {
  const t = new Tris();
  const hw = r.width / 2;
  const onRamp = (z: number): number => Math.max(0, rampProfile(r, z)) + 0.04;
  const onRoad = (): number => 0.035;
  const n = 3;
  for (let i = 0; i < n; i++) {
    const z = 0.9 + (i * (r.up - 2.6)) / (n - 1);
    chevron(t, 0, z, hw * 0.62, 1.1, 0.42, onRamp, 1);
  }
  // Lip bar across the top of the kicker, and a thinner one at the far edge of the deck.
  const h = r.height;
  t.box(-hw, h, r.up - 0.18, hw, h + 0.09, r.up + 0.12, 0xffffff);
  t.box(-hw, h, r.up + r.deck - 0.08, hw, h + 0.05, r.up + r.deck + 0.02, 0x8a8a8a);
  // Rail tops.
  const a0 = r.up * 0.35;
  const a1 = r.up + r.deck + r.down * 0.65;
  for (const side of [-1, 1]) {
    const x = side * (r.width / 2 + 0.15);
    t.box(x - 0.13, 1.15, a0, x + 0.13, 1.24, a1, 0xc8c8c8);
  }
  // Painted run-up chevrons: three, fading with distance from the ramp.
  for (let i = 0; i < 3; i++) chevron(t, 0, -5 - i * 5.5, hw * 0.55, 1.6, 0.55, onRoad, 0.75 - i * 0.18);
  return t.build();
}

/** The rampage token: an extruded lightning bolt, about two metres tall. */
function boltGeometry(): BufferGeometry {
  const s = new Shape();
  const pts: [number, number][] = [
    [-0.08, 1.0],
    [0.5, 1.0],
    [0.14, 0.22],
    [0.48, 0.22],
    [-0.28, -1.0],
    [-0.02, -0.08],
    [-0.38, -0.08],
  ];
  s.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i]![0], pts[i]![1]);
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: 0.22, bevelEnabled: false });
  g.translate(-0.05, 0, -0.11);
  return g;
}

/** A hexagonal ground ring (rampage), flat. */
function hexRing(): BufferGeometry {
  const g = new RingGeometry(0.82, 1, 6, 1, Math.PI / 6);
  g.rotateX(-Math.PI / 2);
  return g;
}

function flagGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  b.box(0, 0.1, 0, 0.7, 0.2, 0.7, 0x2a2b38);
  b.box(0, 2.6, 0, 0.12, 5.0, 0.12, 0xa8aec8);
  const sq = 0.42;
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 4; col++) {
      const white = (row + col) % 2 === 0;
      b.box(0.08 + sq / 2 + col * sq, 3.75 + row * sq, 0, sq, sq, 0.05, white ? 0xf4f4f8 : 0x101016);
    }
  return b.build();
}

/** A chequered strip one metre wide (scaled across the road), two rows deep. */
function lineGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  const n = 12;
  for (let row = 0; row < 2; row++)
    for (let i = 0; i < n; i++) b.box(-0.5 + (i + 0.5) / n, 0.03, (row - 0.5) * 0.55, 1 / n, 0.02, 0.55, (row + i) % 2 === 0 ? 0xe8e8ee : 0x0e0e14);
  return b.build();
}

/**
 * A checkpoint, built to read from above: a dashed line across the road, two
 * chevrons on the tarmac pointing the way through, and a beacon pylon at each
 * end. White, so the instance colour tints it.
 */
function gateGeometry(halfWidth: number): BufferGeometry {
  const t = new Tris();
  const flat = (): number => 0.05;
  const n = 7;
  const seg = (halfWidth * 2) / n;
  for (let i = 0; i < n; i++) {
    const x0 = -halfWidth + i * seg + 0.18;
    const x1 = x0 + seg - 0.36;
    t.quad([x0, 0.05, -0.55], [x0, 0.05, 0.55], [x1, 0.05, 0.55], [x1, 0.05, -0.55], 0xffffff);
  }
  chevron(t, 0, -4.2, halfWidth * 0.45, 1.8, 0.7, flat, 0.85);
  chevron(t, 0, -8.2, halfWidth * 0.45, 1.8, 0.7, flat, 0.55);
  for (const sx of [-1, 1]) {
    const x = sx * (halfWidth + 0.5);
    t.box(x - 0.3, 0, -0.3, x + 0.3, 2.4, 0.3, 0x8a8a8a);
    t.box(x - 0.45, 2.4, -0.45, x + 0.45, 2.9, 0.45, 0xffffff);
  }
  return t.build();
}

/** A downward chevron that hovers over a rampage target. */
function targetGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  b.box(-0.2, 0, 0, 0.55, 0.16, 0.16, 0xffffff, { rot: [0, 0, -0.75] });
  b.box(0.2, 0, 0, 0.55, 0.16, 0.16, 0xffffff, { rot: [0, 0, 0.75] });
  return b.build();
}

/** The courier parcel: a box with tape. */
function parcelGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  b.box(0, 0.35, 0, 0.8, 0.7, 0.6, 0xffffff);
  b.box(0, 0.36, 0, 0.82, 0.72, 0.12, 0x9a7a20);
  b.box(0, 0.71, 0, 0.12, 0.02, 0.62, 0x9a7a20);
  return b.build();
}

const SHOW_RANGE = 150;
const SHARD_RANGE = 90;
const MAX_SHARDS = 24;
const MAX_GANG = 16;

/** Position, normal and colour only, unindexed, so every shape can share one batch. */
function prep(src: BufferGeometry): BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const out = new BufferGeometry();
  const pos = g.getAttribute('position');
  out.setAttribute('position', pos);
  out.setAttribute('normal', g.getAttribute('normal'));
  out.setAttribute('color', g.getAttribute('color') ?? new BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3));
  return out;
}

/**
 * One draw call for many shapes: a BatchedMesh whose instances are handed out
 * afresh each frame (begin, add, end) and hidden when unused.
 */
class Batch<K extends string> {
  readonly mesh: BatchedMesh;
  private readonly geo = new Map<K, number>();
  private readonly ids: number[] = [];
  private used = 0;
  private shown = 0;

  constructor(scene: Scene, name: string, material: Material, shapes: Record<K, BufferGeometry>, max: number, bloom: boolean) {
    const list = (Object.keys(shapes) as K[]).map((k) => [k, prep(shapes[k])] as const);
    const verts = list.reduce((n, [, g]) => n + g.getAttribute('position').count, 0);
    this.mesh = new BatchedMesh(max, verts, 0, material);
    for (const [k, g] of list) this.geo.set(k, this.mesh.addGeometry(g));
    const first = this.geo.get(list[0]![0])!;
    for (let i = 0; i < max; i++) {
      const id = this.mesh.addInstance(first);
      this.mesh.setVisibleAt(id, false);
      this.ids.push(id);
    }
    this.mesh.frustumCulled = false;
    this.mesh.perObjectFrustumCulled = false;
    this.mesh.sortObjects = false;
    this.mesh.visible = false;
    this.mesh.name = name;
    if (bloom) this.mesh.layers.enable(BLOOM_LAYER);
    scene.add(this.mesh);
  }

  begin(): void {
    this.used = 0;
  }

  add(kind: K, o: Object3D, colour: Color): void {
    if (this.used >= this.ids.length) return;
    const n = this.used++;
    const id = this.ids[n]!;
    o.updateMatrix();
    this.mesh.setGeometryIdAt(id, this.geo.get(kind)!);
    this.mesh.setMatrixAt(id, o.matrix);
    this.mesh.setColorAt(id, colour);
    if (n >= this.shown) this.mesh.setVisibleAt(id, true);
  }

  end(): void {
    for (let i = this.used; i < this.shown; i++) this.mesh.setVisibleAt(this.ids[i]!, false);
    this.shown = this.used;
    this.mesh.visible = this.used > 0;
  }
}

type GlowShape = 'bolt' | 'crystal' | 'target' | 'parcel';
type AddShape = 'hex' | 'ring' | 'beam' | 'gate';
type FlagShape = 'flag' | 'line';

/**
 * Side activities in the world: stunt ramps, rampage tokens, data shards, race
 * start flags and checkpoints, fare pick-up and drop-off markers, and the
 * target chevrons over a rampage crew and a waiting fare. Ramps are one mesh
 * each (so they are culled off screen). Everything else is three batches, solid
 * glow, additive light, and the chequered race furniture, each hidden when
 * nothing of its kind is in range: a quiet street costs no extra draw calls and
 * a busy one at most three.
 */
export class ActivitiesView {
  /** Solid meshes: the game lights them with the light field and makes them occlude bloom. */
  readonly solids: Mesh[] = [];
  private readonly ramps: { site: RampSite; glow: Mesh; done: boolean }[] = [];
  private readonly glowTodo: Material;
  private readonly glowDone: Material;
  private readonly glowBatch: Batch<GlowShape>;
  private readonly addBatch: Batch<AddShape>;
  private readonly flagBatch: Batch<FlagShape>;
  private readonly o = new Object3D();
  private readonly c = new Color();
  private readonly ground: (x: number, z: number) => number;
  private readonly tokenY: number[];
  private readonly shardY: number[];
  private readonly flagY: number[];
  /** Lights this frame: x, z, radius, colour, intensity. */
  private readonly glows: number[] = [];

  constructor(scene: Scene, world: World) {
    const a = world.activities;
    const sites = a.sites;
    const map = world.content.map;
    this.ground = (x: number, z: number): number => groundHeight(map, x, z);
    this.tokenY = a.rampages.tokens.map((t) => this.ground(t.site.x, t.site.z));
    this.shardY = sites.shards.map((q) => this.ground(q.x, q.z));
    this.flagY = sites.flags.map((f) => this.ground(f.x, f.z));
    const bodyMat = new MeshLambertMaterial({ vertexColors: true, flatShading: true, side: DoubleSide });
    this.glowTodo = new MeshBasicMaterial({ vertexColors: true, color: ActivityColours.jump, toneMapped: false, side: DoubleSide });
    this.glowDone = new MeshBasicMaterial({ vertexColors: true, color: ActivityColours.jumpDone, toneMapped: false, side: DoubleSide });
    for (const r of sites.ramps) {
      const body = new Mesh(rampBody(r), bodyMat);
      const glow = new Mesh(rampGlow(r), this.glowTodo);
      for (const m of [body, glow]) {
        m.position.set(r.x, 0, r.z);
        m.rotation.y = r.yaw;
        m.matrixAutoUpdate = false;
        m.updateMatrix();
        scene.add(m);
      }
      body.name = `ramp-${r.id}`;
      glow.name = `ramp-glow-${r.id}`;
      glow.layers.enable(BLOOM_LAYER);
      this.solids.push(body);
      this.ramps.push({ site: r, glow, done: false });
    }

    const crystal = new OctahedronGeometry(0.42, 0);
    crystal.scale(1.1, 2.1, 1.1);
    const nTokens = sites.tokens.length;
    this.glowBatch = new Batch<GlowShape>(
      scene,
      'activity-glow',
      new MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      { bolt: boltGeometry(), crystal, target: targetGeometry(), parcel: parcelGeometry() },
      nTokens + MAX_SHARDS + MAX_GANG + 2,
      true,
    );
    const beam = new CylinderGeometry(0.5, 0.8, 26, 8, 1, true);
    beam.translate(0, 13, 0);
    const ring = new RingGeometry(0.86, 1, 40);
    ring.rotateX(-Math.PI / 2);
    const cpr = a.config?.races.checkpointRadius ?? 12;
    this.addBatch = new Batch<AddShape>(
      scene,
      'activity-light',
      new MeshBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false }),
      { hex: hexRing(), ring, beam, gate: gateGeometry(Math.min(7, cpr * 0.6)) },
      nTokens * 2 + sites.flags.length + MAX_SHARDS + 8,
      true,
    );
    this.flagBatch = new Batch<FlagShape>(scene, 'race-furniture', new MeshBasicMaterial({ vertexColors: true }), { flag: flagGeometry(), line: lineGeometry() }, sites.flags.length + 2, false);
  }

  /** Place the shared transform: position, yaw, scale. */
  private at(x: number, y: number, z: number, yaw: number, sx: number, sy = sx, sz = sx): Object3D {
    const o = this.o;
    o.position.set(x, y, z);
    o.rotation.set(0, yaw, 0, 'XYZ');
    o.scale.set(sx, sy, sz);
    return o;
  }

  private col(hex: number, k = 1): Color {
    return this.c.setHex(hex).multiplyScalar(k);
  }

  private readonly hexCache = new Map<string, number>();
  private hex(css: string): number {
    let h = this.hexCache.get(css);
    if (h === undefined) {
      h = new Color(css).getHex();
      this.hexCache.set(css, h);
    }
    return h;
  }

  private glow(x: number, z: number, r: number, colour: number, i: number): void {
    this.glows.push(x, z, r, colour, i);
  }

  update(world: World, alpha: number, time: number, focusX: number, focusZ: number): void {
    const a = world.activities;
    const G = this.glowBatch;
    const L = this.addBatch;
    const F = this.flagBatch;
    G.begin();
    L.begin();
    F.begin();
    this.glows.length = 0;
    const near = (x: number, z: number, r: number): boolean => Math.abs(x - focusX) < r && Math.abs(z - focusZ) < r;
    const free = a.enabled && !a.current && !world.playerCtl.dead;

    // Ramps: amber until their unique jump is done, then teal.
    for (const r of this.ramps) {
      const done = !!a.progress.jumps[r.site.id]?.unique;
      if (done !== r.done) {
        r.done = done;
        r.glow.material = done ? this.glowDone : this.glowTodo;
      }
      if (near(r.site.x, r.site.z, 45)) {
        const up = r.site.up;
        this.glow(r.site.x + Math.sin(r.site.yaw) * up, r.site.z + Math.cos(r.site.yaw) * up, 9, done ? ActivityColours.jumpDone : ActivityColours.jump, 1.1);
      }
    }

    // Rampage tokens: a rocking bolt over a slowly turning hex ring, and a thin beam.
    a.rampages.tokens.forEach((t, ti) => {
      if (!free || t.cooldown > 0 || !near(t.site.x, t.site.z, SHOW_RANGE)) return;
      const gy = this.tokenY[ti]!;
      const bob = Math.sin(time * 2.2 + ti) * 0.2;
      // The bolt rocks rather than spins, so it never turns edge-on, and leans back so it reads from above.
      const o = this.o;
      o.position.set(t.site.x, gy + 2.6 + bob, t.site.z);
      o.rotation.set(-0.8, Math.sin(time * 1.4 + ti) * 0.6, 0, 'YXZ');
      o.scale.setScalar(2);
      G.add('bolt', o, this.col(ActivityColours.rampage));
      L.add('hex', this.at(t.site.x, gy + 0.06, t.site.z, -time * 0.5, 2.6 * (1 + Math.sin(time * 3.5) * 0.05), 1), this.col(ActivityColours.rampage, 1.3));
      L.add('beam', this.at(t.site.x, gy, t.site.z, 0, 0.4, 1, 0.4), this.col(ActivityColours.rampage, 0.1));
      if (near(t.site.x, t.site.z, 50)) this.glow(t.site.x, t.site.z, 10, ActivityColours.rampage, 1.6);
    });

    // Data shards near the camera: a spinning violet crystal over a small ring.
    let sn = 0;
    const sh = a.shards;
    a.sites.shards.forEach((s, i) => {
      if (sn >= MAX_SHARDS || sh.found[i] || !near(s.x, s.z, SHARD_RANGE)) return;
      sn++;
      const gy = this.shardY[i]!;
      const bob = Math.sin(time * 2.6 + i) * 0.15;
      G.add('crystal', this.at(s.x, gy + 1.5 + bob, s.z, time * 2.2 + i, 1), this.col(0x9a5cff, 0.95 + Math.sin(time * 5 + i * 1.7) * 0.2));
      L.add('ring', this.at(s.x, gy + 0.05, s.z, 0, 1.1 + Math.sin(time * 3 + i) * 0.08, 1), this.col(ActivityColours.shard, 0.72));
      if (near(s.x, s.z, 35)) this.glow(s.x, s.z, 5, ActivityColours.shard, 1.1);
    });

    // Race flags (hidden while any activity runs) and the start line on each grid.
    const race = a.races.run;
    for (let fi = 0; fi < a.sites.flags.length; fi++) {
      const f = a.sites.flags[fi]!;
      const showFlag = free && near(f.x, f.z, SHOW_RANGE);
      const isRace = race?.flag.id === f.id;
      if (showFlag) {
        const def = a.races.defOf(f.id);
        const o = this.o;
        o.position.set(f.x, this.flagY[fi]!, f.z);
        o.rotation.set(0, 0, Math.sin(time * 1.8 + fi) * 0.03, 'XYZ');
        o.scale.setScalar(1);
        F.add('flag', o, this.col(0xffffff));
        L.add('beam', this.at(f.x, this.flagY[fi]!, f.z, 0, 0.45, 1, 0.45), this.col(def ? this.hex(def.colour) : 0xffffff, 0.1));
        if (near(f.x, f.z, 50)) this.glow(f.x, f.z, 9, 0xfff2e0, 1.1);
      }
      if ((showFlag || (isRace && race.phase === 'countdown')) && near(f.gridX, f.gridZ, SHOW_RANGE)) {
        const fx = Math.sin(f.yaw);
        const fz = Math.cos(f.yaw);
        // The grid's two columns are at 0 and two lanes to the left (local +x); the line spans both.
        F.add('line', this.at(f.gridX + fx * 3.2 + fz * f.lane, 0, f.gridZ + fz * 3.2 - fx * f.lane, f.yaw, f.lane * 4, 1, 1), this.col(0xffffff));
      }
    }

    // Race checkpoints: the next one bright, the one after dim; a chequered line at the finish.
    if (race && race.phase === 'run' && !race.player.finished) {
      const colour = this.hex(race.def.colour);
      for (let k = 0; k < 2; k++) {
        const i = race.player.next + k;
        const p = a.races.checkpoint(i);
        if (!p) break;
        const prev = i > 0 ? a.races.checkpoint(i - 1) : null;
        const from = prev ?? { x: race.flag.gridX, z: race.flag.gridZ };
        const yaw = Math.atan2(p.x - from.x, p.z - from.z);
        L.add('gate', this.at(p.x, 0, p.z, yaw, 1), this.col(colour, k === 0 ? 1.25 + Math.sin(time * 6) * 0.22 : 0.4));
        if (k === 0) {
          L.add('beam', this.at(p.x, 0, p.z, 0, 0.6, 1, 0.6), this.col(colour, 0.12));
          this.glow(p.x, p.z, 12, colour, 1.6);
          if (i === race.total - 1) F.add('line', this.at(p.x, 0, p.z, yaw, 10, 1, 1), this.col(0xffffff));
        }
      }
    }

    // In the air: an amber ring on the ground under the player's car, so the height reads from above.
    const pv = world.player.vehicle;
    if (pv && pv.airborne && pv.y > 0.6) {
      const x = lerp(pv.prevX, pv.x, alpha);
      const z = lerp(pv.prevZ, pv.z, alpha);
      const k = Math.min(1, pv.y / 3);
      L.add('ring', this.at(x, 0.06 + Math.max(0, a.jumps.surface(x, z)), z, 0, 1.6 + k * 1.4, 1), this.col(ActivityColours.jump, 0.4 + k * 0.5));
    }

    // Fares: a cab-yellow ring and beam in the lane at the pick-up, then at the drop; a parcel waits at a courier pick-up.
    const shift = a.fares.shift;
    if (shift) {
      const stop = shift.phase === 'seek' ? shift.pickup : shift.drop;
      const r = shift.def.stopRadius;
      L.add('ring', this.at(stop.laneX, 0.07, stop.laneZ, 0, r * 0.75 * (1 + Math.sin(time * 4) * 0.05), 1), this.col(ActivityColours.fare, 0.48));
      L.add('beam', this.at(stop.laneX, 0, stop.laneZ, 0, 0.45, 1, 0.45), this.col(ActivityColours.fare, 0.11));
      this.glow(stop.x, stop.z, 8, ActivityColours.fare, 1.3);
      if (shift.def.cargo === 'parcel' && shift.phase === 'seek') {
        G.add('parcel', this.at(stop.x, this.ground(stop.x, stop.z) + 0.25 + Math.sin(time * 3) * 0.12, stop.z, time * 1.2, 1), this.col(ActivityColours.fare));
      }
      // A yellow chevron over the fare waving at the kerb (or the parcel).
      if (shift.phase === 'seek') {
        const fp = shift.actor && !shift.actor.riding && shift.actor.pedId >= 0 ? world.peds.peds[shift.actor.pedId] : undefined;
        const x = fp?.active ? lerp(fp.prevX, fp.x, alpha) : stop.x;
        const z = fp?.active ? lerp(fp.prevZ, fp.z, alpha) : stop.z;
        G.add('target', this.at(x, this.ground(x, z) + (fp ? 3.5 : 1.6) + Math.sin(time * 5) * 0.15, z, 0, 1.3), this.col(ActivityColours.fare, 1.2));
      }
    }

    // A red chevron over each member of a havoc crew still standing.
    const run = a.rampages.run;
    if (run) {
      let gk = 0;
      for (const g of run.gang) {
        if (gk >= MAX_GANG) break;
        if (!g.active || g.dead || g.pedId < 0) continue;
        const p = world.peds.peds[g.pedId];
        if (!p || !p.active) continue;
        gk++;
        const x = lerp(p.prevX, p.x, alpha);
        const z = lerp(p.prevZ, p.z, alpha);
        G.add('target', this.at(x, this.ground(x, z) + 2.9 + Math.sin(time * 5 + gk) * 0.15, z, 0, 1.7), this.col(ActivityColours.gang, 1.2));
      }
    }
    G.end();
    L.end();
    F.end();
  }

  /** Add this frame's activity lights to the light field (after SceneLights has begun the frame). */
  light(field: LightField): void {
    if (!field.enabled) return;
    const g = this.glows;
    for (let i = 0; i < g.length; i += 5) field.point(g[i]!, 1.8, g[i + 1]!, g[i + 2]!, g[i + 3]!, g[i + 4]!);
  }
}
