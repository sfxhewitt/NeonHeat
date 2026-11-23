import type {
  BufferGeometry} from 'three';
import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  type Scene,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { trafficLight, type RoadGraph, type TrafficConfig } from '@neonheat/sim';
import { BLOOM_LAYER } from './layers';

/** One signal: the approach it controls, the pole, the lens over the lane and the glow on the stop line. */
interface Signal {
  node: number;
  alongX: boolean;
  x: number;
  z: number;
  pole: Matrix4;
  lens: Matrix4;
  glow: Matrix4;
}

const STOP = 4.4;
/** Pole to lens, metres. */
const ARM = 4.4;
const RADIUS = 190;
const COLOURS = {
  green: new Color(0x2bff9a).multiplyScalar(1.6),
  amber: new Color(0xffb020).multiplyScalar(1.7),
  red: new Color(0xff2a3c).multiplyScalar(1.8),
};
const GLOW = {
  green: new Color(0x2bff9a).multiplyScalar(0.42),
  amber: new Color(0xffb020).multiplyScalar(0.5),
  red: new Color(0xff2a3c).multiplyScalar(0.55),
};

/**
 * Traffic signals at every light-controlled junction: a pole on the right-hand
 * kerb of each approach with an arm over the lane, a lens that shows the
 * approach's light (seen from above), and a neon glow along the stop line so a
 * driver reads red or green at a glance. Phases come from the sim's
 * `trafficLight`, so the lights always agree with what the traffic does.
 * Only signals near the camera focus are drawn.
 */
export class SignalsView {
  private readonly signals: Signal[] = [];
  private readonly poles: InstancedMesh;
  private readonly lenses: InstancedMesh;
  private readonly glows: InstancedMesh;
  private visible: number[] = [];
  private lastX = Infinity;
  private lastZ = Infinity;

  constructor(
    scene: Scene,
    private readonly graph: RoadGraph,
    private readonly lights: TrafficConfig['lights'],
  ) {
    const ns = new Float32Array(graph.nodes.length);
    const ew = new Float32Array(graph.nodes.length);
    for (const e of graph.edges) {
      if (e.kind === 'alley') continue;
      for (const id of [e.a, e.b]) {
        if (e.alongX) ew[id] = Math.max(ew[id]!, e.width / 2);
        else ns[id] = Math.max(ns[id]!, e.width / 2);
      }
    }
    const m = new Matrix4();
    for (const n of graph.nodes) {
      if (!n.junction) continue;
      const hx = ns[n.id]!;
      const hz = ew[n.id]!;
      if (hx <= 0 || hz <= 0) continue;
      n.edges.forEach((eid, k) => {
        const e = graph.edges[eid]!;
        if (e.kind === 'alley') return;
        const o = graph.nodes[n.links[k]!]!;
        // Unit vector of travel towards the junction, and the half-width of this road.
        const tx = e.alongX ? Math.sign(n.x - o.x) : 0;
        const tz = e.alongX ? 0 : Math.sign(n.z - o.z);
        const hw = e.width / 2;
        const box = e.alongX ? hx : hz;
        // Right of travel (t rotated): for +x travel that is +z, for +z travel it is -x.
        const rx = -tz;
        const rz = tx;
        const yaw = Math.atan2(tx, tz);
        const sx = n.x - tx * (box + STOP);
        const sz = n.z - tz * (box + STOP);
        // Pole on the right-hand pavement, 1.2 m back from the kerb, just past the stop line.
        const px = n.x - tx * (box + 1.5) + rx * (hw + 1.2);
        const pz = n.z - tz * (box + 1.5) + rz * (hw + 1.2);
        const pole = new Matrix4().makeRotationY(yaw).setPosition(px, 0, pz);
        // Lens at the end of the arm, over the approaching lane.
        const lx = px - rx * ARM;
        const lz = pz - rz * ARM;
        const lens = new Matrix4().makeRotationY(yaw).setPosition(lx, 5.35, lz);
        // Glow strip across the approaching lane at the stop line.
        m.makeRotationY(yaw);
        const glow = new Matrix4()
          .makeScale(1, 1, 1)
          .multiply(m)
          .multiply(new Matrix4().makeScale(hw - 0.8, 1, 1))
          .setPosition(sx + rx * (hw * 0.5), 0.05, sz + rz * (hw * 0.5));
        this.signals.push({ node: n.id, alongX: e.alongX, x: px, z: pz, pole, lens, glow });
      });
    }
    const cap = 160;
    this.poles = new InstancedMesh(poleGeometry(), new MeshLambertMaterial({ color: 0x23263a, flatShading: true }), cap);
    this.lenses = new InstancedMesh(new BoxGeometry(0.9, 0.22, 0.5), new MeshBasicMaterial({ toneMapped: false }), cap);
    const glowGeo = new PlaneGeometry(1, 0.9).rotateX(-Math.PI / 2);
    this.glows = new InstancedMesh(
      glowGeo,
      new MeshBasicMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
      cap,
    );
    for (const mesh of [this.poles, this.lenses, this.glows]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    }
    this.lenses.setColorAt(0, COLOURS.red);
    this.glows.setColorAt(0, GLOW.red);
    this.lenses.layers.enable(BLOOM_LAYER);
    this.glows.layers.enable(BLOOM_LAYER);
    this.glows.renderOrder = -1;
    this.poles.name = 'signal-poles';
    this.lenses.name = 'signal-lenses';
    this.glows.name = 'signal-glows';
    scene.add(this.poles, this.lenses, this.glows);
  }

  get count(): number {
    return this.signals.length;
  }

  /** Stream the signals near (fx, fz) and set every visible lens to its current phase. */
  update(fx: number, fz: number, time: number): void {
    if (Math.hypot(fx - this.lastX, fz - this.lastZ) > 12) {
      this.lastX = fx;
      this.lastZ = fz;
      this.visible = [];
      const cap = this.poles.instanceMatrix.count;
      for (let i = 0; i < this.signals.length && this.visible.length < cap; i++) {
        const s = this.signals[i]!;
        if (Math.abs(s.x - fx) < RADIUS && Math.abs(s.z - fz) < RADIUS) this.visible.push(i);
      }
      this.visible.forEach((i, slot) => {
        const s = this.signals[i]!;
        this.poles.setMatrixAt(slot, s.pole);
        this.lenses.setMatrixAt(slot, s.lens);
        this.glows.setMatrixAt(slot, s.glow);
      });
      for (const mesh of [this.poles, this.lenses, this.glows]) {
        mesh.count = this.visible.length;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.visible.forEach((i, slot) => {
      const s = this.signals[i]!;
      const state = trafficLight(this.graph.nodes[s.node]!, s.alongX, time, this.lights);
      this.lenses.setColorAt(slot, COLOURS[state]);
      this.glows.setColorAt(slot, GLOW[state]);
    });
    if (this.lenses.instanceColor) this.lenses.instanceColor.needsUpdate = true;
    if (this.glows.instanceColor) this.glows.instanceColor.needsUpdate = true;
  }
}

/** A dark pole with an arm reaching over the lane (local +x points from the kerb towards the road centre). */
function poleGeometry(): BufferGeometry {
  const post = new CylinderGeometry(0.09, 0.12, 5.6, 6).translate(0, 2.8, 0);
  const base = new BoxGeometry(0.42, 0.3, 0.42).translate(0, 0.15, 0);
  const arm = new BoxGeometry(ARM, 0.1, 0.1).translate(ARM / 2, 5.55, 0);
  return mergeGeometries([post, base, arm].map((x) => x.toNonIndexed()));
}
