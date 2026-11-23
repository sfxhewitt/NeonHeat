import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  type Scene,
} from 'three';
import { lerp, lerpAngle, type VehicleParams, type World } from '@neonheat/sim';
import { Palette } from './palette';
import { BLOOM_LAYER } from './layers';
import { MeshBuilder } from './mesh-kit';
import { buildCarModel, styleFor, type CarLayout } from './car-models';

const MAX = 48;

interface StyleMesh {
  mesh: InstancedMesh;
  layout: CarLayout;
  count: number;
}

/**
 * Vehicles: one instanced body mesh per body style (original low-poly models
 * with glass, bumpers and trim), instanced wheels that spin and steer, small
 * emissive head/tail lights and police light bars, and additive headlight
 * beams on the wet road. All read from sim state with interpolation.
 */
export class VehiclesView {
  /** Body meshes, for the bloom occluder pass. */
  readonly bodies: InstancedMesh[] = [];
  readonly wheels: InstancedMesh;
  readonly lights: InstancedMesh;
  readonly beams: InstancedMesh;
  /** Headlight beam brightness: a faint volumetric hint when real lights are on, stronger without. */
  beamStrength = 0.5;
  private readonly styles = new Map<string, StyleMesh>();
  private readonly spin = new Float32Array(MAX * 2);
  private readonly o = new Object3D();
  private readonly c = new Color();
  private readonly base = new Color();
  private readonly carM = new Matrix4();
  private readonly localM = new Matrix4();
  private readonly outM = new Matrix4();

  /** Smoothed kerb lift of each vehicle's front and rear axle, by vehicle id. */
  private readonly kerbF = new Float32Array(128);
  private readonly kerbR = new Float32Array(128);

  constructor(
    private readonly scene: Scene,
    variants: Record<string, VehicleParams>,
  ) {
    const bodyMat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    for (const [id, p] of Object.entries(variants)) {
      const model = buildCarModel(styleFor(id), p);
      const mesh = new InstancedMesh(model.geometry, bodyMat, MAX);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.setColorAt(0, this.c.set(0xffffff));
      mesh.name = `vehicle-${id}`;
      scene.add(mesh);
      this.bodies.push(mesh);
      this.styles.set(id, { mesh, layout: model.layout, count: 0 });
    }

    const wheel = new MeshBuilder().cylinderX(0, 0, 0, 1, 1, 10, 0x121216, 0x6a6a80).build();
    this.wheels = new InstancedMesh(wheel, new MeshLambertMaterial({ vertexColors: true, flatShading: true, side: DoubleSide }), MAX * 4);
    this.lights = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ toneMapped: false }), MAX * 6);
    this.beams = new InstancedMesh(
      beamGeometry(),
      new MeshBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide }),
      MAX,
    );
    for (const m of [this.wheels, this.lights, this.beams]) {
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
    this.lights.layers.enable(BLOOM_LAYER);
    this.beams.layers.enable(BLOOM_LAYER);
    this.beams.renderOrder = -1;
    this.wheels.name = 'vehicle-wheels';
    this.lights.name = 'vehicle-lights';
    this.beams.name = 'vehicle-beams';
    this.lights.setColorAt(0, this.c.set(0xffffff));
    this.beams.setColorAt(0, this.c.set(0xffffff));
  }

  update(world: World, alpha: number, dt = 1 / 60): void {
    const { o, c } = this;
    for (const s of this.styles.values()) s.count = 0;
    let wn = 0;
    let ln = 0;
    let bn = 0;
    const flash = Math.floor(world.time * 6) % 2 === 0;
    for (const v of world.vehicles) {
      if (!v.active) continue;
      const s = this.styles.get(v.variantId);
      if (!s || s.count >= MAX) continue;
      const p = v.params;
      const L = s.layout;
      const x = lerp(v.prevX, v.x, alpha);
      const z = lerp(v.prevZ, v.z, alpha);
      const yaw = lerpAngle(v.prevYaw, v.yaw, alpha);
      // Body roll and pitch from cornering and braking, for weight.
      const fwd = Math.sin(yaw) * v.vx + Math.cos(yaw) * v.vz;
      const roll = v.destroyed ? 0.12 : Math.max(-0.07, Math.min(0.07, -v.yawRate * fwd * 0.004));
      // Kerbs: each axle eases up onto the pavement, so the body rides up and pitches over the step.
      const kh = world.content.map.roads.kerbHeight;
      const k = Math.min(1, dt * 22);
      const fy = (this.kerbF[v.id] = this.kerbF[v.id]! + ((v.kerbFront ? kh : 0) - this.kerbF[v.id]!) * k);
      const ry = (this.kerbR[v.id] = this.kerbR[v.id]! + ((v.kerbRear ? kh : 0) - this.kerbR[v.id]!) * k);
      const wheelbase = p.length * 0.64;
      const pitch = (v.destroyed ? 0 : (v.controls.brake > 0.1 ? 0.025 : 0) - v.controls.throttle * 0.015) - (fy - ry) / wheelbase;
      o.position.set(x, (fy + ry) / 2, z);
      o.rotation.set(pitch, yaw, roll, 'YXZ');
      o.scale.set(1, 1, 1);
      o.updateMatrix();
      this.carM.copy(o.matrix);
      s.mesh.setMatrixAt(s.count, this.carM);
      const health = Math.max(0, v.hp / p.maxHealth);
      this.base.set(p.colour);
      if (v.destroyed) c.setHex(0x1a1716);
      else c.copy(this.base).multiplyScalar(0.45 + 0.55 * health);
      s.mesh.setColorAt(s.count, c);
      s.count++;

      // Wheels: spin with forward speed, fronts steer.
      const slot = v.id % (MAX * 2);
      this.spin[slot] = (this.spin[slot]! + (fwd / L.wheelR) * dt) % (Math.PI * 2);
      const steer = v.destroyed ? 0 : -v.controls.steer * 0.45;
      for (let i = 0; i < 4; i++) {
        const front = i < 2;
        const side = i % 2 === 0 ? 1 : -1;
        o.position.set(side * L.wheelX, L.wheelR, front ? L.wheelZ[0] : L.wheelZ[1]);
        o.rotation.set(this.spin[slot]!, front ? steer : 0, 0, 'YXZ');
        o.scale.set(L.wheelW, L.wheelR, L.wheelR);
        o.updateMatrix();
        this.outM.multiplyMatrices(this.carM, o.matrix);
        if (wn < MAX * 4) this.wheels.setMatrixAt(wn++, this.outM);
      }

      if (v.destroyed) continue;
      const hl = p.length / 2;
      const hw = p.width / 2;
      const braking = v.controls.brake > 0.1 || v.controls.handbrake;
      // Headlights and tail lights (pairs).
      for (const sx of [-1, 1]) {
        ln = this.light(ln, sx * hw * 0.68, L.headY, hl + 0.02, p.width * 0.22, 0.12, 0.06, c.setHex(0xfff4d8));
        ln = this.light(ln, sx * hw * 0.7, L.tailY, -hl - 0.02, p.width * 0.24, 0.1, 0.06, c.setHex(braking ? 0xff1a30 : 0x8a0c1c));
      }
      if (v.role === 'police' || v.role === 'squad') {
        const red = v.role === 'squad' || flash;
        ln = this.light(ln, 0.32, L.roofY + 0.06, L.roofZ, 0.5, 0.14, 0.3, c.setHex(red ? Palette.policeRed : 0x220508));
        ln = this.light(ln, -0.32, L.roofY + 0.06, L.roofZ, 0.5, 0.14, 0.3, c.setHex(v.role === 'squad' ? Palette.policeRed : !flash ? Palette.policeBlue : 0x050a22));
      }
      // Headlight beams on the road.
      o.position.set(0, 0.05, hl);
      o.rotation.set(0, 0, 0);
      o.scale.set(p.width, 1, 1);
      o.updateMatrix();
      this.outM.multiplyMatrices(this.carM, o.matrix);
      this.beams.setMatrixAt(bn, this.outM);
      this.beams.setColorAt(bn, c.setHex(v.role === 'police' ? 0x9db4ff : 0xffe7b8).multiplyScalar(this.beamStrength));
      bn++;
    }
    for (const s of this.styles.values()) {
      s.mesh.count = s.count;
      s.mesh.instanceMatrix.needsUpdate = true;
      if (s.mesh.instanceColor) s.mesh.instanceColor.needsUpdate = true;
    }
    this.wheels.count = wn;
    this.lights.count = ln;
    this.beams.count = bn;
    this.wheels.instanceMatrix.needsUpdate = true;
    this.lights.instanceMatrix.needsUpdate = true;
    this.beams.instanceMatrix.needsUpdate = true;
    if (this.lights.instanceColor) this.lights.instanceColor.needsUpdate = true;
    if (this.beams.instanceColor) this.beams.instanceColor.needsUpdate = true;
  }

  private light(i: number, lx: number, ly: number, lz: number, w: number, h: number, d: number, col: Color): number {
    if (i >= MAX * 6) return i;
    const o = this.o;
    o.position.set(lx, ly, lz);
    o.rotation.set(0, 0, 0);
    o.scale.set(w, h, d);
    o.updateMatrix();
    this.outM.multiplyMatrices(this.carM, o.matrix);
    this.lights.setMatrixAt(i, this.outM);
    this.lights.setColorAt(i, col);
    return i + 1;
  }
}

/** A flat fan in front of the car, bright at the lamps and fading out: unit width, 14 m long. */
function beamGeometry(): BufferGeometry {
  const len = 14;
  // Three strips across: dark edges, bright centre, so the cone has no hard sides.
  const xsNear = [-0.5, -0.25, 0.25, 0.5];
  const xsFar = [-2.2, -0.9, 0.9, 2.2];
  const bright = [0, 1, 1, 0];
  const pos: number[] = [];
  const col: number[] = [];
  const v = (x: number, z: number, b: number): void => {
    pos.push(x, 0, z);
    col.push(b, b, b);
  };
  for (let i = 0; i < 3; i++) {
    v(xsNear[i]!, 0, bright[i]!);
    v(xsNear[i + 1]!, 0, bright[i + 1]!);
    v(xsFar[i + 1]!, len, 0);
    v(xsNear[i]!, 0, bright[i]!);
    v(xsFar[i + 1]!, len, 0);
    v(xsFar[i]!, len, 0);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  return g;
}


