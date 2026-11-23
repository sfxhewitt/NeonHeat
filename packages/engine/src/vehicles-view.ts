import {
  AdditiveBlending,
  BatchedMesh,
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
  type Material,
  type Mesh,
  type Scene,
} from 'three';
import { clamp, lerp, lerpAngle, paintFor, type VehicleParams, type Vehicle, type World } from '@neonheat/sim';
import { Palette } from './palette';
import { BLOOM_LAYER } from './layers';
import { MeshBuilder } from './mesh-kit';
import { buildCarModel, buildRiderModel, modelFor, type BeaconScheme, type CarLayout, type LightKind, type RiderStyle } from './car-models';

/** Vehicle slots drawn (the sim's pool is smaller). Vehicle ids index slots directly. */
const CAP = 96;
const MAX_WHEELS = CAP * 6;
const MAX_LIGHTS = CAP * 14;

/** Rider jackets: bright so a rider reads against the bike and the road. */
const JACKETS = [0xff2bd6, 0x21f0ff, 0xd7ff2b, 0xff7a00, 0xf2f2ff, 0xff2a3d, 0x8a6bff];

const BEACON_ON: Record<Exclude<BeaconScheme, 'none'>, [number, number]> = {
  police: [Palette.policeRed, Palette.policeBlue],
  squad: [Palette.policeRed, Palette.policeRed],
  ambulance: [0x2f8bff, 0xe8f0ff],
  fire: [0xff2a20, 0xfff0e0],
};

interface ModelEntry {
  geo: number;
  layout: CarLayout;
  rider: number;
}

/**
 * Vehicles: every body model lives in one BatchedMesh (one draw call for the
 * whole roster, per-instance paint), with instanced wheels that spin and
 * steer, one instanced mesh of emissive lamps (head/tail/brake, beacons, taxi
 * signs, clearance lamps, accent strips) and additive headlight beams on the
 * wet road. Bikes lean into turns and carry a rider (an extra batch instance).
 * All read from sim state with interpolation.
 */
export class VehiclesView {
  /** Body meshes, for the bloom occluder pass and light-field injection. */
  readonly bodies: Mesh[] = [];
  readonly batch: BatchedMesh;
  readonly wheels: InstancedMesh;
  readonly lights: InstancedMesh;
  readonly beams: InstancedMesh;
  /** Headlight beam brightness: a faint volumetric hint when real lights are on, stronger without. */
  beamStrength = 0.5;
  /** Triangles of each variant's body model (budget checks and the garage). */
  readonly triangles = new Map<string, number>();
  private readonly models = new Map<string, ModelEntry>();
  private readonly slotVariant: string[] = new Array<string>(CAP).fill('');
  private readonly slotActive = new Uint8Array(CAP);
  private readonly slotGen = new Uint32Array(CAP);
  private readonly slotPaint: Color[] = [];
  private readonly slotJacket = new Uint32Array(CAP);
  private readonly lean = new Float32Array(CAP);
  private readonly spin = new Float32Array(CAP * 2);
  private readonly o = new Object3D();
  private readonly c = new Color();
  private readonly carM = new Matrix4();
  private readonly outM = new Matrix4();

  /** Smoothed kerb lift of each vehicle's front and rear axle, by vehicle id. */
  private readonly kerbF = new Float32Array(CAP);
  private readonly kerbR = new Float32Array(CAP);

  constructor(
    scene: Scene,
    variants: Record<string, VehicleParams>,
  ) {
    const built: { id: string; geometry: BufferGeometry; layout: CarLayout; triangles: number }[] = [];
    const riders = new Map<RiderStyle, BufferGeometry>();
    let verts = 0;
    for (const [id, p] of Object.entries(variants)) {
      const m = buildCarModel(modelFor(id, p.model), p);
      built.push({ id, geometry: m.geometry, layout: m.layout, triangles: m.triangles });
      verts += m.geometry.getAttribute('position').count;
      const rs = m.layout.rider;
      if (rs && !riders.has(rs)) {
        const g = buildRiderModel(rs);
        riders.set(rs, g);
        verts += g.getAttribute('position').count;
      }
    }

    const bodyMat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    applyPaintMask(bodyMat);
    this.batch = new BatchedMesh(CAP * 2, verts, 0, bodyMat);
    this.batch.sortObjects = false;
    this.batch.perObjectFrustumCulled = true;
    this.batch.frustumCulled = false;
    this.batch.name = 'vehicle-bodies';
    const riderGeo = new Map<RiderStyle, number>();
    for (const [rs, g] of riders) riderGeo.set(rs, this.batch.addGeometry(g));
    for (const b of built) {
      const geo = this.batch.addGeometry(b.geometry);
      this.models.set(b.id, { geo, layout: b.layout, rider: b.layout.rider ? riderGeo.get(b.layout.rider)! : -1 });
      this.triangles.set(b.id, b.triangles);
    }
    const first = this.models.values().next().value!.geo;
    const white = this.c.set(0xffffff);
    // Slots 0..CAP-1 are bodies, CAP..2*CAP-1 the riders of the same vehicles.
    for (let i = 0; i < CAP * 2; i++) {
      const id = this.batch.addInstance(first);
      this.batch.setVisibleAt(id, false);
      this.batch.setColorAt(id, white);
    }
    for (let i = 0; i < CAP; i++) this.slotPaint.push(new Color(0xffffff));
    scene.add(this.batch);
    this.bodies.push(this.batch);

    const wheel = new MeshBuilder().cylinderX(0, 0, 0, 1, 1, 10, 0x121216, 0x6a6a80).build();
    this.wheels = new InstancedMesh(wheel, new MeshLambertMaterial({ vertexColors: true, flatShading: true, side: DoubleSide }), MAX_WHEELS);
    this.lights = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ toneMapped: false }), MAX_LIGHTS);
    this.beams = new InstancedMesh(
      beamGeometry(),
      new MeshBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide }),
      CAP,
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

  /** Paint of the vehicle in a slot as last drawn (tests and the garage). */
  paintOf(vehicleId: number): Color | null {
    return vehicleId < CAP && this.slotActive[vehicleId] ? this.slotPaint[vehicleId]! : null;
  }

  update(world: World, alpha: number, dt = 1 / 60): void {
    const { o, c, batch } = this;
    let wn = 0;
    let ln = 0;
    let bn = 0;
    const kh = world.content.map.roads.kerbHeight;
    for (const v of world.vehicles) {
      const slot = v.id;
      if (slot >= CAP) continue;
      const entry = v.active ? this.models.get(v.variantId) : undefined;
      if (!entry) {
        if (this.slotActive[slot]) {
          this.slotActive[slot] = 0;
          batch.setVisibleAt(slot, false);
          batch.setVisibleAt(CAP + slot, false);
        }
        continue;
      }
      if (!this.slotActive[slot] || this.slotVariant[slot] !== v.variantId) this.respawn(world, v, entry);
      const p = v.params;
      const L = entry.layout;
      const x = lerp(v.prevX, v.x, alpha);
      const z = lerp(v.prevZ, v.z, alpha);
      const yaw = lerpAngle(v.prevYaw, v.yaw, alpha);
      const fwd = Math.sin(yaw) * v.vx + Math.cos(yaw) * v.vz;
      // Cars roll a touch out of a corner; bikes lean into it (yaw rate x speed is the sideways pull).
      let roll: number;
      if (p.twoWheel && !v.destroyed) {
        const want = clamp(-Math.atan((v.yawRate * fwd) / 9.81), -p.leanMax, p.leanMax);
        roll = this.lean[slot] = this.lean[slot]! + (want - this.lean[slot]!) * Math.min(1, dt * 10);
      } else roll = v.destroyed ? (p.twoWheel ? 1.35 : 0.12) : clamp(-v.yawRate * fwd * 0.004, -0.07, 0.07);
      // Kerbs: each axle eases up onto the pavement, so the body rides up and pitches over the step.
      const k = Math.min(1, dt * 22);
      const fy = (this.kerbF[slot] = this.kerbF[slot]! + ((v.kerbFront ? kh : 0) - this.kerbF[slot]!) * k);
      const ry = (this.kerbR[slot] = this.kerbR[slot]! + ((v.kerbRear ? kh : 0) - this.kerbR[slot]!) * k);
      const wheelbase = p.length * 0.64;
      const pitch = (v.destroyed ? 0 : (v.controls.brake > 0.1 ? 0.025 : 0) - v.controls.throttle * 0.015) - (fy - ry) / wheelbase;
      // Thrown over by an explosion: a barrel roll with a hop (the sim keeps cars flat).
      const flipT = world.combat.flip[v.id] ?? 0;
      const flipSec = world.content.weapons.explosion.flipSec;
      const fp = flipT > 0 && flipSec > 0 ? 1 - flipT / flipSec : 0;
      o.position.set(x, (fy + ry) / 2 + Math.sin(fp * Math.PI) * 1.8, z);
      o.rotation.set(pitch, yaw, roll + fp * Math.PI * 2 * ((v.id & 1) === 0 ? 1 : -1), 'YXZ');
      const sc = L.scale;
      o.scale.set(sc, sc, sc);
      o.updateMatrix();
      this.carM.copy(o.matrix);
      batch.setMatrixAt(slot, this.carM);
      const health = Math.max(0, v.hp / p.maxHealth);
      // Pure black is the shader's "burnt out" signal: trim chars too.
      if (v.destroyed) c.setRGB(0, 0, 0);
      else c.copy(this.slotPaint[slot]!).multiplyScalar(0.45 + 0.55 * health);
      batch.setColorAt(slot, c);

      const parked = v.role === 'parked';
      const ridden = entry.rider >= 0 && !parked && !v.destroyed;
      batch.setVisibleAt(CAP + slot, ridden);
      if (ridden) batch.setMatrixAt(CAP + slot, this.carM);

      // Wheels: spin with forward speed, fronts steer.
      const steer = v.destroyed ? 0 : -v.controls.steer * 0.45;
      const sp = slot * 2;
      this.spin[sp] = (this.spin[sp]! + (fwd / (L.wheels[0]?.r ?? 0.35)) * dt) % (Math.PI * 2);
      for (const w of L.wheels) {
        if (wn >= MAX_WHEELS) break;
        o.position.set(w.x, w.r, w.z);
        o.rotation.set(this.spin[sp]!, w.steer ? steer : 0, 0, 'YXZ');
        o.scale.set(w.w, w.r, w.r);
        o.updateMatrix();
        this.outM.multiplyMatrices(this.carM, o.matrix);
        this.wheels.setMatrixAt(wn++, this.outM);
      }

      if (v.destroyed) continue;
      const braking = v.controls.brake > 0.1 || (v.controls.handbrake && !parked);
      // Police show their lights whenever they are out; ambulances and fire tenders only on a call.
      const onCall = !parked && L.beacons !== 'none' && (v.beacons || v.role === 'police' || v.role === 'squad');
      const ph = (world.time * 1.6 + slot * 0.29) % 1;
      const strobeA = ph < 0.5 && ((ph * 6) % 1) < 0.75;
      const strobeB = ph >= 0.5 && (((ph - 0.5) * 6) % 1) < 0.75;
      const scheme = L.beacons === 'none' ? null : BEACON_ON[L.beacons];
      for (const l of L.lights) {
        if (ln >= MAX_LIGHTS) break;
        const col = this.lampColour(l.k, l.c, parked, braking, onCall, strobeA, strobeB, scheme);
        if (col < 0) continue;
        ln = this.light(ln, l.x, l.y, l.z, l.w, l.h, l.d, c.setHex(col));
      }
      if (parked) continue;
      // Headlight beams on the road.
      o.position.set(0, 0.05, p.length / 2 / sc);
      o.rotation.set(0, 0, 0);
      o.scale.set(L.beamWidth, 1, 1 / sc);
      o.updateMatrix();
      this.outM.multiplyMatrices(this.carM, o.matrix);
      this.beams.setMatrixAt(bn, this.outM);
      this.beams.setColorAt(bn, c.setHex(p.role === 'police' ? 0x9db4ff : 0xffe7b8).multiplyScalar(this.beamStrength));
      bn++;
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

  /** A new vehicle in a slot: swap the batch geometry and roll its paint and rider. */
  private respawn(world: World, v: Vehicle, entry: ModelEntry): void {
    const slot = v.id;
    this.slotActive[slot] = 1;
    this.slotVariant[slot] = v.variantId;
    const gen = ++this.slotGen[slot]!;
    const seed = slot * 7919 + gen * 104729;
    this.slotPaint[slot]!.set(paintFor(world.content.vehicles, v.variantId, seed));
    // Crew cars cruise in their crew's colour.
    const crew = world.gangs.carCrew[v.id] ?? -1;
    if (crew >= 0) this.slotPaint[slot]!.set(world.gangs.crews[crew]!.colour).multiplyScalar(0.8);
    this.slotJacket[slot] = JACKETS[(seed >>> 3) % JACKETS.length]!;
    this.lean[slot] = 0;
    this.batch.setGeometryIdAt(slot, entry.geo);
    this.batch.setVisibleAt(slot, true);
    if (entry.rider >= 0) {
      this.batch.setGeometryIdAt(CAP + slot, entry.rider);
      this.batch.setColorAt(CAP + slot, this.c.setHex(this.slotJacket[slot]!));
    }
  }

  /** Colour of one lamp this frame, or -1 to leave it out. */
  private lampColour(
    kind: LightKind,
    own: number | undefined,
    parked: boolean,
    braking: boolean,
    onCall: boolean,
    a: boolean,
    b: boolean,
    scheme: [number, number] | null,
  ): number {
    switch (kind) {
      case 'head':
        return parked ? 0x4a4636 : 0xfff4d8;
      case 'tail':
        return braking ? 0xff1a30 : parked ? 0x5a0a18 : 0x8a0c1c;
      case 'beaconA':
      case 'beaconB': {
        if (!scheme) return -1;
        const on = kind === 'beaconA' ? a : b;
        const col = kind === 'beaconA' ? scheme[0] : scheme[1];
        return onCall && on ? col : dim(col);
      }
      case 'sign':
        return parked ? dim(own ?? 0xffffff, 0.35) : (own ?? 0xffffff);
      case 'amber':
        return parked ? 0x3a2408 : 0xffa020;
      case 'accent':
        return parked ? dim(own ?? 0xffffff, 0.3) : (own ?? 0xffffff);
    }
  }

  private light(i: number, lx: number, ly: number, lz: number, w: number, h: number, d: number, col: Color): number {
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

/** A colour scaled towards black (unlit lamp lenses). */
function dim(hex: number, k = 0.12): number {
  const r = Math.round(((hex >> 16) & 255) * k);
  const g = Math.round(((hex >> 8) & 255) * k);
  const b = Math.round((hex & 255) * k);
  return (r << 16) | (g << 8) | b;
}

/**
 * Only paint vertices (MeshBuilder's paintMask = 1) take the instance colour;
 * fixed trim keeps its own. An all-black instance colour means burnt out: the
 * whole body chars.
 */
export function applyPaintMask(mat: Material): void {
  const prev = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float paintMask;').replace(
      '#include <color_vertex>',
      `#ifdef USE_COLOR
        vColor = vec3(1.0);
        vColor *= color;
        vec3 nhTint = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          nhTint = instanceColor.xyz;
        #endif
        #ifdef USE_BATCHING_COLOR
          nhTint = getBatchingColor( getIndirectIndex( gl_DrawID ) );
        #endif
        if (nhTint.r + nhTint.g + nhTint.b < 0.0005) vColor *= 0.07;
        else vColor *= mix(vec3(1.0), nhTint, paintMask);
      #endif`,
    );
  };
  const prevKey = mat.customProgramCacheKey();
  mat.customProgramCacheKey = () => `${prevKey}|nh-paintmask`;
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
