import {
  AdditiveBlending,
  BatchedMesh,
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  RingGeometry,
  type BufferGeometry,
  type Scene,
} from 'three';
import { PICKUP_SHAPES, lerp, type PickupShape, type World } from '@neonheat/sim';
import { BLOOM_LAYER } from './layers';
import { MeshBuilder } from './mesh-kit';

const W = 0xffffff;

/** Low-poly pickup icons, about a metre across. White is tinted by the kind's colour. */
function pickupGeometry(shape: PickupShape): BufferGeometry {
  const b = new MeshBuilder();
  switch (shape) {
    case 'cross':
      b.box(0, -0.4, 0, 0.3, 0.8, 0.3, W).box(0, -0.12, 0, 0.8, 0.3, 0.3, W);
      break;
    case 'shield':
      b.box(0, -0.35, 0, 0.7, 0.55, 0.18, W, { top: [0, 0, 0] }).box(0, -0.5, 0, 0.36, 0.22, 0.2, W, { top: [0, 0, 0.12] });
      b.box(0, 0.2, 0, 0.7, 0.12, 0.2, W);
      break;
    case 'bat':
      b.box(0, -0.5, 0, 0.1, 0.35, 0.1, W).box(0, -0.15, 0, 0.18, 0.75, 0.18, W, { top: [-0.03, -0.03, -0.03] });
      break;
    case 'pistol':
      b.box(0, 0, 0.1, 0.14, 0.18, 0.55, W).box(0, -0.25, -0.08, 0.13, 0.32, 0.16, W);
      break;
    case 'smg':
      b.box(0, 0, 0.12, 0.16, 0.2, 0.8, W).box(0, -0.25, -0.05, 0.13, 0.3, 0.15, W).box(0, -0.28, 0.22, 0.1, 0.36, 0.12, W);
      break;
    case 'shotgun':
      b.box(-0.05, 0.05, 0.25, 0.09, 0.09, 1.1, W).box(0.05, 0.05, 0.25, 0.09, 0.09, 1.1, W).box(0, -0.1, -0.45, 0.16, 0.26, 0.5, W);
      break;
    case 'rifle':
      b.box(0, 0, 0.3, 0.1, 0.12, 1.4, W).box(0, 0.14, 0.15, 0.12, 0.12, 0.4, W).box(0, -0.14, -0.4, 0.14, 0.28, 0.45, W);
      break;
    case 'launcher':
      b.cylinderX(0, 0, 0, 0.2, 1.0, 8, W).box(0, -0.3, 0, 0.12, 0.3, 0.14, W);
      break;
    case 'arc':
      b.box(0.08, 0.12, 0, 0.14, 0.42, 0.14, W, { rot: [0, 0, 0.5] }).box(-0.04, -0.15, 0, 0.14, 0.42, 0.14, W, { rot: [0, 0, -0.5] });
      b.box(0.06, -0.42, 0, 0.14, 0.38, 0.14, W, { rot: [0, 0, 0.5] });
      break;
  }
  return b.build();
}

function spikeGeometry(): BufferGeometry {
  // A 1 m long, flat strip; scaled along X to the strip's length.
  const b = new MeshBuilder().box(0, 0, 0, 1, 0.05, 0.9, 0x20202a);
  for (let i = -4; i <= 4; i++) b.box(i * 0.11, 0.05, 0, 0.04, 0.12, 0.8, 0xc8c8d8, { top: [0.35, 0.35, 0.015] });
  return b.build();
}

const MAX_ARCS = 12;
const ARC_LIFE = 0.14;

/**
 * Pickups (glowing, spinning, bobbing low-poly icons over a ground ring, one
 * shape per kind), grenades in flight, spike strips and arc caster bolts.
 * Five draw calls in all.
 */
export class CombatView {
  private readonly icons: BatchedMesh;
  private readonly rings: InstancedMesh;
  private readonly grenades: InstancedMesh;
  private readonly spikes: InstancedMesh;
  private readonly arcs: InstancedMesh;
  readonly meshes: Object3D[];
  private readonly shapeIds = new Map<PickupShape, number>();
  private readonly instanceIds: number[] = [];
  private readonly arcData: { x: number; z: number; hx: number; hz: number; life: number }[] = [];
  private nextArc = 0;
  private readonly o = new Object3D();
  private readonly m = new Matrix4();
  private readonly c = new Color();

  constructor(scene: Scene, world: World) {
    const pool = world.pickups.pickups.length;
    const geos = PICKUP_SHAPES.map((s) => pickupGeometry(s));
    const verts = geos.reduce((n, g) => n + g.getAttribute('position').count, 0);
    this.icons = new BatchedMesh(pool, verts, 0, new MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
    PICKUP_SHAPES.forEach((s, i) => this.shapeIds.set(s, this.icons.addGeometry(geos[i]!)));
    for (let i = 0; i < pool; i++) {
      const id = this.icons.addInstance(this.shapeIds.get('cross')!);
      this.icons.setVisibleAt(id, false);
      this.instanceIds.push(id);
    }
    this.icons.frustumCulled = false;
    this.icons.perObjectFrustumCulled = false;
    this.icons.sortObjects = false;
    this.icons.name = 'pickups';
    this.icons.layers.enable(BLOOM_LAYER);
    scene.add(this.icons);

    const ringGeo = new RingGeometry(0.75, 1.0, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this.rings = this.instanced(ringGeo, new MeshBasicMaterial({ transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false, blending: AdditiveBlending }), pool, 'pickup-rings');
    this.rings.layers.enable(BLOOM_LAYER);
    let gpool = 0;
    for (const w of Object.values(world.content.weapons.weapons)) gpool = Math.max(gpool, w.projectile?.pool ?? 0);
    this.grenades = this.instanced(new BoxGeometry(0.32, 0.32, 0.32), new MeshBasicMaterial({ color: 0xff4060, toneMapped: false }), Math.max(1, gpool), 'grenades');
    this.grenades.layers.enable(BLOOM_LAYER);
    this.spikes = this.instanced(spikeGeometry(), new MeshLambertMaterial({ vertexColors: true, flatShading: true }), world.police.roadblocks.spikes.length, 'spike-strips');
    this.arcs = this.instanced(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0xc8a8ff, blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }), MAX_ARCS, 'arc-bolts');
    this.arcs.layers.enable(BLOOM_LAYER);
    for (let i = 0; i < MAX_ARCS; i++) this.arcData.push({ x: 0, z: 0, hx: 0, hz: 0, life: 0 });
    this.meshes = [this.icons, this.rings, this.grenades, this.spikes, this.arcs];
  }

  private instanced(g: BufferGeometry, mat: MeshBasicMaterial | MeshLambertMaterial, n: number, name: string): InstancedMesh {
    const m = new InstancedMesh(g, mat, n);
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = 0;
    m.setColorAt(0, this.c.set(0xffffff));
    m.name = name;
    this.icons.parent?.add(m);
    return m;
  }

  /** An arc caster chain: x/z pairs, `n` points. Drawn as jagged bolts for a moment. */
  addArc(points: readonly number[], n: number): void {
    for (let i = 0; i + 1 < n; i++) {
      // Two jagged halves per link.
      const ax = points[i * 2]!;
      const az = points[i * 2 + 1]!;
      const bx = points[i * 2 + 2]!;
      const bz = points[i * 2 + 3]!;
      const jx = (ax + bx) / 2 + (bz - az) * 0.12;
      const jz = (az + bz) / 2 - (bx - ax) * 0.12;
      for (const [x0, z0, x1, z1] of [
        [ax, az, jx, jz],
        [jx, jz, bx, bz],
      ] as const) {
        const d = this.arcData[this.nextArc]!;
        this.nextArc = (this.nextArc + 1) % MAX_ARCS;
        d.x = x0;
        d.z = z0;
        d.hx = x1;
        d.hz = z1;
        d.life = ARC_LIFE;
      }
    }
  }

  update(world: World, alpha: number, dt: number, time: number): void {
    const { o, c } = this;
    // Pickups.
    let rn = 0;
    for (const p of world.pickups.pickups) {
      const id = this.instanceIds[p.id]!;
      const show = p.active && p.available;
      this.icons.setVisibleAt(id, show);
      if (!show) continue;
      this.icons.setGeometryIdAt(id, this.shapeIds.get(p.shape)!);
      const bob = Math.sin(time * 2.4 + p.id) * 0.18;
      o.position.set(p.x, 1.3 + bob, p.z);
      o.rotation.set(0, time * 1.8 + p.id, 0);
      o.scale.setScalar(1.25);
      o.updateMatrix();
      this.icons.setMatrixAt(id, o.matrix);
      c.set(p.colour).multiplyScalar(1.6);
      this.icons.setColorAt(id, c);
      o.position.set(p.x, 0.07, p.z);
      o.rotation.set(0, 0, 0);
      o.scale.setScalar(1 + Math.sin(time * 3 + p.id) * 0.08);
      o.updateMatrix();
      this.rings.setMatrixAt(rn, o.matrix);
      this.rings.setColorAt(rn, c.set(p.colour));
      rn++;
    }
    this.finish(this.rings, rn);

    // Grenades.
    let gn = 0;
    for (const g of world.combat.projectiles) {
      if (!g.active) continue;
      o.position.set(lerp(g.prevX, g.x, alpha), lerp(g.prevY, g.y, alpha), lerp(g.prevZ, g.z, alpha));
      o.rotation.set(time * 9, time * 7, 0);
      o.scale.setScalar(1);
      o.updateMatrix();
      this.grenades.setMatrixAt(gn++, o.matrix);
    }
    this.finish(this.grenades, gn);

    // Spike strips.
    let sn = 0;
    for (const s of world.police.roadblocks.spikes) {
      if (!s.active) continue;
      o.position.set(s.x, 0.03, s.z);
      o.rotation.set(0, Math.atan2(-s.dirZ, s.dirX), 0);
      o.scale.set(s.halfLength * 2, 1, s.halfWidth * 2);
      o.updateMatrix();
      this.spikes.setMatrixAt(sn++, o.matrix);
    }
    this.finish(this.spikes, sn);

    // Arc bolts flicker as they fade.
    let an = 0;
    for (const d of this.arcData) {
      if (d.life <= 0) continue;
      d.life -= dt;
      const dx = d.hx - d.x;
      const dz = d.hz - d.z;
      const len = Math.hypot(dx, dz);
      const thick = 0.07 + Math.random() * 0.08;
      o.position.set((d.x + d.hx) / 2, 1.1 + Math.random() * 0.2, (d.z + d.hz) / 2);
      o.rotation.set(0, Math.atan2(dx, dz), 0);
      o.scale.set(thick, thick, len);
      o.updateMatrix();
      this.arcs.setMatrixAt(an++, o.matrix);
    }
    this.finish(this.arcs, an);
  }

  private finish(m: InstancedMesh, n: number): void {
    m.count = n;
    m.visible = n > 0;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}
