import {
  AdditiveBlending,
  BatchedMesh,
  BoxGeometry,
  CircleGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  RingGeometry,
  type BufferGeometry,
  type Scene,
} from 'three';
import { Anim, Look, groundHeight, hasUmbrella, lerp, lerpAngle, type MapContent, type World } from '@neonheat/sim';
import { Palette } from './palette';
import { BLOOM_LAYER } from './layers';
import { MeshBuilder } from './mesh-kit';
import { gearGeometries, type GearKind } from './people-gear';
import { applyPaintMask } from './vehicles-view';

const MAX_PEOPLE = 120;
/** Clothing and kit pieces (one batched draw call) and small glowing details (one instanced call). */
const MAX_GEAR = 320;
const MAX_GLOWS = 160;
const MAX_TRACERS = 32;
/** Officer uniform: dark navy, with red and blue shoulder lights. */
const OFFICER_JACKET = 0x1b2442;
const TACTICAL_JACKET = 0x0d111f;
const OFFICER_TROUSERS = 0x121726;
/** People are drawn a little larger than life so they read from the top-down camera on a phone. */
const SCALE = 1.45;

const HIP_Y = 0.94;
const SHOULDER_Y = 1.48;
const NECK_Y = 1.56;

/** Skin tones, jacket and trouser colours for pedestrians (instance colours). */
const SKIN = [0xf1c9a5, 0xd9a47a, 0xa86f4c, 0x7a4b31, 0x5a3622, 0xe8b98f];
const TROUSERS = [0x2a2a3a, 0x1d2433, 0x3b3242, 0x24302c, 0x3a3a3a, 0x463a2e];

/** Weapon-in-hand stretch per weapon: [length, thickness]. */
const HAND_SCALE: Record<string, [number, number]> = {
  bat: [3.4, 0.7],
  pistol: [1, 1],
  smg: [1.6, 1.1],
  shotgun: [2.6, 1.05],
  rifle: [3.2, 0.9],
  launcher: [2.2, 1.7],
  arc: [1.5, 1.4],
};

interface Rig {
  phase: number;
}

/** Paramedics: pale jacket, green-yellow reflective bands, green cap and a green cross on the back. */
const MEDIC = { jacket: 0xd4e0da, trousers: 0x23303a, bands: 0xc8ff3a, cap: 0x1f6a46, cross: 0x3bff8a };
/** Firefighters: charcoal coat, yellow bands, yellow helmet, air tanks. */
const FIRE = { jacket: 0x2c2e33, trousers: 0x24262a, bands: 0xe6ff2b, helmet: 0xf2c21a };
/** Umbrella canopies: dark, with a few neon-tinted ones. */
const CANOPY = [0x26283c, 0x3c1a3a, 0x163a40, 0x2c2c30, 0x5c1c4c, 0x1c3c60, 0x40402a];
/** Civilian headwear and packs (by id hash): cap, beanie, backpack, grey hood, or nothing. */
const CIV_GEAR: (GearKind | null)[] = ['cap', 'beanie', 'pack', 'hood', null, null, null, null, 'pack', null];
const CIV_TINT = [0x30344a, 0x4a2a3a, 0x2a4038, 0x55586a, 0x3a3a3a, 0x60402a];

function torsoGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  // Hips, chest (wider at the shoulders), collar.
  b.box(0, HIP_Y + 0.08, 0, 0.42, 0.16, 0.24, 0xffffff);
  b.box(0, HIP_Y + 0.16 + 0.22, 0, 0.44, 0.44, 0.26, 0xffffff, { top: [0, 0, -0.04] });
  b.box(0, SHOULDER_Y + 0.03, -0.02, 0.3, 0.08, 0.22, 0xcfcfd8);
  // Jacket front zip and belt.
  b.box(0, HIP_Y + 0.38, 0.131, 0.04, 0.42, 0.01, 0x55556a);
  b.box(0, HIP_Y + 0.17, 0, 0.44, 0.05, 0.27, 0x222228);
  return b.build();
}

function headGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  b.box(0, 0.05, 0, 0.12, 0.1, 0.12, 0xffffff); // neck
  b.box(0, 0.22, 0.01, 0.25, 0.27, 0.26, 0xffffff, { top: [0.03, 0.03, 0.03] }); // head (skin)
  b.box(0, 0.35, -0.02, 0.27, 0.1, 0.28, 0x2b221e, { top: [0.06, 0.02, 0.04] }); // hair
  b.box(0, 0.25, -0.12, 0.27, 0.2, 0.06, 0x2b221e); // hair back
  b.box(0.06, 0.24, 0.135, 0.05, 0.03, 0.01, 0x111111); // eyes
  b.box(-0.06, 0.24, 0.135, 0.05, 0.03, 0.01, 0x111111);
  return b.build();
}

function armGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  b.box(0, -0.15, 0, 0.14, 0.3, 0.15, 0xffffff); // upper (sleeve)
  b.box(0, -0.44, 0.01, 0.12, 0.28, 0.13, 0xffffff); // forearm
  b.box(0, -0.62, 0.02, 0.1, 0.1, 0.11, 0x2a2420); // glove
  return b.build();
}

function legGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  b.box(0, -0.24, 0, 0.17, 0.48, 0.19, 0xffffff); // thigh
  b.box(0, -0.66, 0, 0.15, 0.4, 0.17, 0xffffff); // shin
  b.box(0, -0.88, 0.04, 0.16, 0.12, 0.27, 0x16161c); // boot
  return b.build();
}

/** Crew jackets: the crew colour worked into a dark jacket, a steel-white one for the visor crew, workwear for the beanie crew. */
function crewJacket(look: string, neon: Color): Color {
  if (look === 'visor') return neon.setHex(0xb4b8c4);
  if (look === 'beanie') return neon.setHex(0x3a3428);
  if (look === 'mohawk') return neon.setHex(0x1e2420);
  return neon.multiplyScalar(look === 'hat' ? 0.3 : 0.36);
}

/**
 * Lambert with a rim light, so people read against the dark street from above:
 * a faint cool rim on everyone, a strong acid-cyan rim on the player.
 */
function rimMaterial(perPerson: number, playerOn: { value: number }): MeshLambertMaterial {
  const mat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  (mat as unknown as { defines: Record<string, number> }).defines = { NH_PER_PERSON: perPerson };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPlayerOn = playerOn;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vNhPlayer;\nuniform float uPlayerOn;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvNhPlayer = gl_InstanceID < NH_PER_PERSON ? uPlayerOn : 0.0;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vNhPlayer;')
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.0);
          totalEmissiveRadiance += mix(vec3(0.16, 0.2, 0.34) * 0.5, vec3(0.55, 1.0, 0.85) * 0.9, vNhPlayer) * rim;
          totalEmissiveRadiance += diffuseColor.rgb * 0.18 * vNhPlayer;
        }`,
      );
  };
  return mat;
}

/**
 * People: an original low-poly character rig (torso, head, two arms, two
 * legs) drawn with four instanced meshes shared by the player and every
 * pedestrian, animated with a walk/run cycle driven by speed. The player
 * gets a glowing visor, a pistol in hand and a ground ring so they read at
 * a glance. Also the aim marker and bullet tracers.
 */
export class PeopleView {
  private readonly torso: InstancedMesh;
  private readonly head: InstancedMesh;
  private readonly arms: InstancedMesh;
  private readonly legs: InstancedMesh;
  readonly meshes: (InstancedMesh | BatchedMesh)[];
  private readonly visor: Mesh;
  private readonly pistol: Mesh;
  private readonly ring: Mesh;
  private readonly facingMark: Mesh;
  readonly aimMarker: Mesh;
  readonly tracers: InstancedMesh;
  /** Small glowing details: red/blue lights on officers' shoulders, crew visors and bands, phones. */
  private readonly shoulderLights: InstancedMesh;
  private readonly tracerLife = new Float32Array(MAX_TRACERS);
  private readonly tracerData: { x: number; z: number; hx: number; hz: number }[] = [];
  private nextTracer = 0;
  private readonly rigs: Rig[] = [];
  private readonly o = new Object3D();
  private readonly c = new Color();
  private readonly jc = new Color();
  private readonly root = new Matrix4();
  private readonly local = new Matrix4();
  private readonly out = new Matrix4();
  private readonly jackets: Color[];
  private n = 0;
  private readonly parts: InstancedMesh[];
  /** Clothing and kit for crews, responders and civilians (one draw call, per-instance tint). */
  private readonly gear: BatchedMesh;
  private readonly gearIds = {} as Record<GearKind, number>;
  private gearN = 0;
  private gearShown = 0;
  /** Glowing details: officers' shoulder lights, visors, hat bands, phones, antenna tips, crosses. */
  private glowN = 0;
  /** Extra pose for the next person() call (an `Anim` value), its timer, a loiter sway, and an umbrella. */
  private act: number = Anim.none;
  private actT = 0;
  private sway = 0;
  private umbrella = false;
  private readonly headM = new Matrix4();
  private readonly handM = new Matrix4();
  private readonly gm = new Matrix4();
  private readonly gc = new Color();
  /** 1 while the player is drawn as instance 0 (on foot): the shader gives them a bright rim. */
  private readonly playerOn = { value: 0 };

  constructor(scene: Scene, pedColours: string[]) {
    this.jackets = pedColours.map((h) => new Color(h));
    const o0 = new Object3D();
    // One material per body part so the shader knows how many leading instances are the player.
    const make = (g: BufferGeometry, count: number, name: string): InstancedMesh => {
      const perPerson = name === 'people-arms' || name === 'people-legs' ? 2 : 1;
      const m = new InstancedMesh(g, rimMaterial(perPerson, this.playerOn), count);
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      m.setColorAt(0, this.c.set(0xffffff));
      m.name = name;
      scene.add(m);
      return m;
    };
    this.torso = make(torsoGeometry(), MAX_PEOPLE, 'people-torso');
    this.head = make(headGeometry(), MAX_PEOPLE, 'people-head');
    this.arms = make(armGeometry(), MAX_PEOPLE * 2, 'people-arms');
    this.legs = make(legGeometry(), MAX_PEOPLE * 2, 'people-legs');
    this.parts = [this.torso, this.head, this.arms, this.legs];

    const geos = gearGeometries();
    let verts = 0;
    for (const g of Object.values(geos)) verts += g.getAttribute('position').count;
    const gearMat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    applyPaintMask(gearMat);
    this.gear = new BatchedMesh(MAX_GEAR, verts, 0, gearMat);
    this.gear.sortObjects = false;
    this.gear.frustumCulled = false;
    this.gear.name = 'people-gear';
    for (const [k, g] of Object.entries(geos)) this.gearIds[k as GearKind] = this.gear.addGeometry(g);
    for (let i = 0; i < MAX_GEAR; i++) {
      const id = this.gear.addInstance(this.gearIds.cap);
      this.gear.setVisibleAt(id, false);
      this.gear.setColorAt(id, this.c.set(0xffffff));
    }
    scene.add(this.gear);
    this.meshes = [...this.parts, this.gear];
    // The grip of whatever is in the right hand, relative to the arm.
    o0.position.set(0, -0.62, 0.06);
    o0.rotation.set(Math.PI / 2, 0, 0);
    o0.updateMatrix();
    this.handM.copy(o0.matrix);
    for (let i = 0; i < MAX_PEOPLE; i++) this.rigs.push({ phase: i * 1.7 });

    const glow = (colour: number): MeshBasicMaterial => new MeshBasicMaterial({ color: colour, toneMapped: false });
    this.visor = new Mesh(new BoxGeometry(0.27, 0.06, 0.05), glow(Palette.acid));
    this.visor.matrixAutoUpdate = false;
    this.visor.layers.enable(BLOOM_LAYER);
    this.pistol = new Mesh(
      new MeshBuilder().box(0, 0, 0.08, 0.07, 0.11, 0.26, 0x2a2a34).box(0, -0.08, 0, 0.06, 0.12, 0.08, 0x1a1a20).box(0, 0.02, 0.2, 0.03, 0.03, 0.03, 0xff2bd6).build(),
      new MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    );
    this.pistol.matrixAutoUpdate = false;
    this.ring = new Mesh(
      new RingGeometry(0.78, 0.9, 40),
      new MeshBasicMaterial({ color: Palette.acid, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.layers.enable(BLOOM_LAYER);
    const fm = new CircleGeometry(0.24, 3);
    fm.rotateX(-Math.PI / 2);
    this.facingMark = new Mesh(fm, new MeshBasicMaterial({ color: Palette.acid, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }));
    this.facingMark.layers.enable(BLOOM_LAYER);
    for (const m of [this.visor, this.pistol, this.ring, this.facingMark]) {
      m.name = 'player-extra';
      scene.add(m);
    }

    this.shoulderLights = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ toneMapped: false }), MAX_GLOWS);
    this.shoulderLights.instanceMatrix.setUsage(DynamicDrawUsage);
    this.shoulderLights.frustumCulled = false;
    this.shoulderLights.count = 0;
    this.shoulderLights.setColorAt(0, this.c.set(0xffffff));
    this.shoulderLights.name = 'people-glows';
    this.shoulderLights.layers.enable(BLOOM_LAYER);
    scene.add(this.shoulderLights);

    this.aimMarker = new Mesh(new RingGeometry(1.8, 2.3, 4), new MeshBasicMaterial({ color: Palette.policeRed, transparent: true, opacity: 0.9, toneMapped: false }));
    this.aimMarker.rotation.x = -Math.PI / 2;
    this.aimMarker.position.y = 0.08;
    this.aimMarker.visible = false;
    this.aimMarker.name = 'aim-marker';
    this.aimMarker.layers.enable(BLOOM_LAYER);
    scene.add(this.aimMarker);

    this.tracers = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({ color: 0xfff2a0, blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }),
      MAX_TRACERS,
    );
    this.tracers.instanceMatrix.setUsage(DynamicDrawUsage);
    this.tracers.frustumCulled = false;
    this.tracers.count = 0;
    this.tracers.name = 'tracers';
    this.tracers.layers.enable(BLOOM_LAYER);
    scene.add(this.tracers);
    for (let i = 0; i < MAX_TRACERS; i++) this.tracerData.push({ x: 0, z: 0, hx: 0, hz: 0 });
  }

  addTracer(x: number, z: number, hx: number, hz: number): void {
    const i = this.nextTracer;
    this.nextTracer = (i + 1) % MAX_TRACERS;
    const t = this.tracerData[i]!;
    t.x = x;
    t.z = z;
    t.hx = hx;
    t.hz = hz;
    this.tracerLife[i] = 0.07;
  }

  /** Place one person. Returns the right arm's world matrix in `this.out` (for the pistol). */
  private person(
    x: number,
    z: number,
    facing: number,
    speed: number,
    rig: Rig,
    dt: number,
    pose: 'stand' | 'down' | 'cower' | 'roll' | 'hands' | 'wave',
    rollT: number,
    aiming: boolean,
    jacket: Color,
    trousers: number,
    skin: number,
  ): void {
    const i = this.n++;
    const o = this.o;
    // People stand on the pavement, not in it.
    const gy = this.map ? groundHeight(this.map, x, z) : 0;
    // Stride frequency rises with speed; a run swings wider than a walk.
    const act = this.act;
    this.act = Anim.none;
    rig.phase += dt * (2.2 + speed * 1.15);
    const amp = Math.min(0.85, speed * 0.16);
    const swing = Math.sin(rig.phase) * amp;
    const bob = speed > 0.3 ? Math.abs(Math.cos(rig.phase)) * 0.05 * Math.min(1, speed / 4) : 0;
    const lean = Math.min(0.22, speed * 0.025);
    o.position.set(x, gy + bob, z);
    o.scale.setScalar(SCALE);
    if (pose === 'down') {
      o.position.y = gy + 0.2;
      o.rotation.set(-Math.PI / 2, facing, 0, 'YXZ');
    } else if (pose === 'roll') {
      o.position.y = gy + 0.5 * SCALE * Math.sin(rollT * Math.PI) * 0.5;
      o.rotation.set(rollT * Math.PI * 2, facing, 0, 'YXZ');
      o.scale.set(SCALE, SCALE * 0.8, SCALE);
    } else if (pose === 'cower') {
      o.rotation.set(0.5, facing, 0, 'YXZ');
      o.scale.set(SCALE, SCALE * 0.62, SCALE);
    } else if (act === Anim.kneel) {
      o.position.y = gy - 0.4 * SCALE;
      o.rotation.set(0.3, facing, 0, 'YXZ');
    } else {
      o.rotation.set(lean, facing, act === Anim.loiter || act === Anim.wait ? this.sway : 0, 'YXZ');
    }
    o.updateMatrix();
    this.root.copy(o.matrix);

    this.torso.setMatrixAt(i, this.root);
    this.torso.setColorAt(i, jacket);
    o.position.set(0, NECK_Y, 0);
    o.rotation.set(pose === 'cower' ? -0.4 : act === Anim.nod ? Math.max(0, Math.sin(this.actT * 9)) * 0.45 : act === Anim.gawk ? 0.25 : 0, 0, 0);
    o.scale.setScalar(1);
    o.updateMatrix();
    this.head.setMatrixAt(i, this.out.multiplyMatrices(this.root, o.matrix));
    this.headM.copy(this.out);
    this.head.setColorAt(i, this.c.setHex(skin));

    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1;
      // Legs: opposite phase; arms counter-swing the legs.
      o.position.set(side * 0.12, HIP_Y, 0);
      o.rotation.set(pose === 'cower' ? -1.2 : act === Anim.kneel ? side * -1.05 : swing * side, 0, 0);
      o.updateMatrix();
      this.legs.setMatrixAt(i * 2 + s, this.out.multiplyMatrices(this.root, o.matrix));
      this.legs.setColorAt(i * 2 + s, this.c.setHex(trousers));

      o.position.set(side * 0.29, SHOULDER_Y, 0);
      if (pose === 'hands') o.rotation.set(-Math.PI + 0.15, 0, side * -0.25);
      else if (pose === 'wave' && side === 1) o.rotation.set(-Math.PI + 0.2, 0, -0.35 + Math.sin(rig.phase * 3) * 0.45);
      else if (aiming && side === -1) o.rotation.set(-Math.PI / 2 + 0.08, 0, 0);
      else if (pose === 'cower') o.rotation.set(-2.4, 0, side * 0.3);
      else if (act === Anim.hose) o.rotation.set(-Math.PI / 2 + 0.2, 0, -side * 0.18);
      else if (act === Anim.kneel) o.rotation.set(-1.0, 0, -side * 0.12);
      else if (act === Anim.shelter) o.rotation.set(-1.15, 0, -side * 0.85);
      else if (act === Anim.gawk && side === -1) o.rotation.set(-1.95, 0, 0.25);
      else if (this.umbrella && side === -1) o.rotation.set(-2.6, 0, 0.35);
      else o.rotation.set(-swing * side * 0.8, 0, side * 0.06);
      o.updateMatrix();
      this.out.multiplyMatrices(this.root, o.matrix);
      this.arms.setMatrixAt(i * 2 + s, this.out);
      this.arms.setColorAt(i * 2 + s, jacket);
      if (side === -1) this.local.copy(this.out);
    }
  }

  private map: MapContent | null = null;

  /** Show one gear piece at `frame` (a world matrix), tinted `colour`. */
  private addGear(kind: GearKind, frame: Matrix4, colour: number | Color): void {
    if (this.gearN >= MAX_GEAR) return;
    const id = this.gearN++;
    this.gear.setGeometryIdAt(id, this.gearIds[kind]);
    this.gear.setMatrixAt(id, frame);
    this.gear.setColorAt(id, typeof colour === 'number' ? this.gc.setHex(colour) : colour);
    this.gear.setVisibleAt(id, true);
  }

  /** A small glowing box at (x, y, z) in `frame`. */
  private addGlow(frame: Matrix4, x: number, y: number, z: number, sx: number, sy: number, sz: number, colour: Color): void {
    if (this.glowN >= MAX_GLOWS) return;
    const o = this.o;
    o.position.set(x, y, z);
    o.rotation.set(0, 0, 0);
    o.scale.set(sx, sy, sz);
    o.updateMatrix();
    o.scale.setScalar(1);
    this.shoulderLights.setMatrixAt(this.glowN, this.gm.multiplyMatrices(frame, o.matrix));
    this.shoulderLights.setColorAt(this.glowN++, colour);
  }

  /** The right hand's grip as a world matrix (after person()). */
  private hand(): Matrix4 {
    return this.gm.multiplyMatrices(this.local, this.handM);
  }

  /** Clothing, kit and glows for the ped just placed by person(). */
  private dress(world: World, id: number, look: number, anim: number, armed: boolean, down: boolean, time: number): void {
    const g = this.gc;
    const crews = world.gangs.crews;
    const dim = down ? 0.45 : 1;
    if (this.umbrella) this.addGear('umbrella', this.root, CANOPY[(id * 11) % CANOPY.length]!);
    if (look === Look.medic) {
      this.addGear('cap', this.headM, MEDIC.cap);
      this.addGear('bands', this.root, MEDIC.bands);
      if (!down) {
        const c = g.setHex(MEDIC.cross).multiplyScalar(1.6);
        this.addGlow(this.root, 0, 1.36, -0.14, 0.2, 0.06, 0.02, c);
        this.addGlow(this.root, 0, 1.36, -0.14, 0.06, 0.2, 0.02, c);
      }
    } else if (look === Look.firefighter) {
      this.addGear('helmet', this.headM, FIRE.helmet);
      this.addGear('bands', this.root, FIRE.bands);
      this.addGear('tanks', this.root, 0xffffff);
      if (anim === Anim.hose) this.addGear('nozzle', this.hand(), 0xffffff);
    } else if (look >= Look.crew && look < Look.crew + crews.length) {
      const crew = crews[look - Look.crew]!;
      const neon = this.jc.set(crew.colour);
      const glowC = this.c.copy(neon).multiplyScalar(down ? 0.3 : 1.8);
      switch (crew.look) {
        case 'hood':
          this.addGear('hood', this.headM, g.copy(neon).multiplyScalar(0.42 * dim));
          this.addGlow(this.headM, 0, 0.41, 0.135, 0.3, 0.03, 0.03, glowC);
          break;
        case 'visor':
          this.addGear('shell', this.headM, 0xffffff);
          this.addGear('pads', this.root, g.copy(neon).multiplyScalar(0.75 * dim));
          this.addGlow(this.headM, 0, 0.25, 0.145, 0.27, 0.06, 0.03, glowC);
          break;
        case 'hat':
          this.addGear('hat', this.headM, 0xffffff);
          this.addGear('tails', this.root, g.copy(neon).multiplyScalar(0.3 * dim));
          this.addGlow(this.headM, 0, 0.42, 0, 0.3, 0.035, 0.3, glowC);
          break;
        case 'beanie':
          this.addGear('beanie', this.headM, g.copy(neon).multiplyScalar(0.55 * dim));
          this.addGear('bands', this.root, g.copy(neon).multiplyScalar(0.9 * dim));
          break;
        case 'mohawk':
          this.addGear('crest', this.headM, g.copy(neon).multiplyScalar(0.9 * dim));
          this.addGlow(this.headM, 0, 0.625, -0.03, 0.03, 0.025, 0.24, glowC);
          this.addGear('antennaPack', this.root, 0xffffff);
          if (!down && Math.sin(time * 6 + id) > -0.3) this.addGlow(this.root, 0.1, 2.17, -0.22, 0.06, 0.06, 0.06, glowC);
          break;
      }
    } else {
      const h = Math.imul(id + 3, 2654435761) >>> 0;
      const kind = CIV_GEAR[h % CIV_GEAR.length]!;
      if (kind && !(this.umbrella && kind === 'hood')) this.addGear(kind, kind === 'pack' ? this.root : this.headM, CIV_TINT[(h >>> 8) % CIV_TINT.length]!);
    }
    if (armed && !down) this.addGear('gun', this.hand(), 0xffffff);
    if (anim === Anim.gawk && !down) {
      // A phone held up, screen lit.
      this.addGlow(this.hand(), 0, 0.02, 0.05, 0.1, 0.16, 0.02, this.c.setHex(0xbfe8ff).multiplyScalar(1.4));
    }
  }

  /** Dressing and kit only make sense where the pose fits (no umbrella while kneeling or filming). */
  private wantsUmbrella(world: World, id: number, look: number, anim: number, state: string): boolean {
    const cc = world.content.life.crowds;
    return (
      look === Look.civilian &&
      state === 'wander' &&
      anim !== Anim.gawk &&
      anim !== Anim.shelter &&
      world.weather.rain > cc.umbrellaRain &&
      hasUmbrella(id, cc.umbrellaShare)
    );
  }

  update(world: World, alpha: number, dt: number, time: number): void {
    this.map = world.content.map;
    const o = this.o;
    this.n = 0;
    this.gearN = 0;
    this.glowN = 0;

    // The player first: pale jacket, acid visor, pistol and a ground ring.
    const pc = world.playerCtl;
    const onFoot = pc.mode === 'foot';
    const combat = world.combat;
    const weapon = combat.weaponId;
    const melee = combat.weapon.kind === 'melee' && weapon === 'fists';
    for (const m of [this.visor, this.ring, this.facingMark]) m.visible = onFoot;
    this.pistol.visible = onFoot && !melee && !pc.incapacitated;
    this.playerOn.value = onFoot ? 1 : 0;
    if (onFoot) {
      const x = lerp(pc.prevX, pc.x, alpha);
      const z = lerp(pc.prevZ, pc.z, alpha);
      const facing = lerpAngle(pc.prevFacing, pc.facing, alpha);
      const speed = Math.hypot(pc.vx, pc.vz);
      const rolling = pc.dodgeTime > 0;
      const rollT = rolling ? 1 - pc.dodgeTime / world.content.peds.player.dodgeSec : 0;
      const aiming = combat.aimKind !== null || combat.sinceFired < 0.35;
      const pose = pc.dead ? 'down' : pc.busted ? 'hands' : rolling ? 'roll' : 'stand';
      this.person(x, z, facing, rolling || pc.busted ? 0 : speed, this.rigs[0]!, dt, pose, rollT, aiming && !pc.incapacitated, this.jc.setHex(0xfafaff), 0x1a1a2c, 0xd9a47a);
      // Visor across the face, pistol in the right hand.
      o.position.set(0, NECK_Y + 0.24, 0.14);
      o.rotation.set(0, 0, 0);
      o.scale.setScalar(1);
      o.updateMatrix();
      this.visor.matrix.multiplyMatrices(this.root, o.matrix);
      // The weapon in hand: one model stretched to read as each gun (long guns, the stubby launcher, the bat).
      const [wl, ww] = HAND_SCALE[weapon] ?? [1, 1];
      o.position.set(0, -0.62, 0.06);
      o.rotation.set(Math.PI / 2, 0, 0);
      o.scale.set(ww, ww, wl);
      o.updateMatrix();
      o.scale.setScalar(1);
      this.pistol.matrix.multiplyMatrices(this.local, o.matrix);
      const ringY = this.map ? groundHeight(this.map, x, z) : 0;
      this.ring.position.set(x, ringY + 0.06, z);
      const pulse = 1 + Math.sin(time * 4) * 0.05;
      this.ring.scale.setScalar(pulse);
      this.facingMark.position.set(x + Math.sin(facing) * 1.2, ringY + 0.07, z + Math.cos(facing) * 1.2);
      this.facingMark.rotation.set(0, facing - Math.PI / 2, 0);
    }

    // A taxi fare waiting at the kerb waves the cab down.
    const shift = world.activities.fares.shift;
    const waver = shift && shift.phase === 'seek' && shift.actor && !shift.actor.riding ? shift.actor.pedId : -1;
    for (const p of world.peds.peds) {
      if (!p.active || this.n >= MAX_PEOPLE) continue;
      const x = lerp(p.prevX, p.x, alpha);
      const z = lerp(p.prevZ, p.z, alpha);
      const rig = this.rigs[(p.id % (MAX_PEOPLE - 1)) + 1]!;
      const pose = p.state === 'down' ? 'down' : p.state === 'cower' ? 'cower' : p.id === waver && Math.hypot(p.vx, p.vz) < 0.5 ? 'wave' : 'stand';
      const speed = pose === 'stand' ? Math.hypot(p.vx, p.vz) : 0;
      const tags = world.peds.tags;
      const look = tags.look[p.id]!;
      const anim = tags.anim[p.id]!;
      const crew = look >= Look.crew && look < Look.crew + world.gangs.crews.length ? world.gangs.crews[look - Look.crew]! : null;
      if (pose === 'wave') rig.phase += dt * 2.5;
      const shade = p.state === 'down' ? 0.45 : 1;
      const jacket =
        look === Look.medic
          ? this.jc.setHex(MEDIC.jacket)
          : look === Look.firefighter
            ? this.jc.setHex(FIRE.jacket)
            : crew
              ? crewJacket(crew.look, this.jc.set(crew.colour))
              : this.jc.copy(this.jackets[p.colour % this.jackets.length]!);
      const trousers = look === Look.medic ? MEDIC.trousers : look === Look.firefighter ? FIRE.trousers : crew ? parseInt(crew.trousers.slice(1), 16) : TROUSERS[(p.id * 7) % TROUSERS.length]!;
      this.act = pose === 'stand' ? anim : Anim.none;
      this.actT = tags.animT[p.id]!;
      this.sway = Math.sin(time * 1.3 + p.id * 2.1) * 0.05;
      this.umbrella = pose === 'stand' && this.wantsUmbrella(world, p.id, look, anim, p.state);
      this.person(
        x,
        z,
        lerpAngle(p.prevFacing, p.facing, alpha),
        speed,
        rig,
        dt,
        pose,
        0,
        anim === Anim.aim && pose === 'stand',
        jacket.multiplyScalar(shade),
        trousers,
        SKIN[(p.id * 5 + p.colour) % SKIN.length]!,
      );
      this.dress(world, p.id, look, anim, tags.armed[p.id] === 1, pose !== 'stand', time);
      this.umbrella = false;
    }
    // Officers: navy uniforms, red/blue shoulder lights that alternate.
    const flash = Math.floor(time * 5) % 2 === 0;
    for (const off of world.officers.officers) {
      if (!off.active || this.n >= MAX_PEOPLE) continue;
      const x = lerp(off.prevX, off.x, alpha);
      const z = lerp(off.prevZ, off.z, alpha);
      const rig = this.rigs[MAX_PEOPLE - 1 - (off.id % 20)]!;
      const pose = off.state === 'down' ? 'down' : off.state === 'stunned' ? 'cower' : 'stand';
      const speed = pose === 'stand' ? Math.hypot(off.vx, off.vz) : 0;
      const shade = off.state === 'down' ? 0.5 : 1;
      this.person(
        x,
        z,
        lerpAngle(off.prevFacing, off.facing, alpha),
        speed,
        rig,
        dt,
        pose,
        0,
        off.sees && off.state === 'chase',
        this.jc.setHex(off.tactical ? TACTICAL_JACKET : OFFICER_JACKET).multiplyScalar(shade),
        OFFICER_TROUSERS,
        SKIN[(off.id * 3) % SKIN.length]!,
      );
      if (off.state === 'down') continue;
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? 1 : -1;
        const red = (s === 0) === flash;
        this.addGlow(this.root, side * 0.27, SHOULDER_Y + 0.07, 0, 0.16, 0.08, 0.16, this.c.setHex(red ? Palette.policeRed : Palette.policeBlue).multiplyScalar(off.state === 'stunned' ? 0.4 : 2.2));
      }
    }
    this.shoulderLights.count = this.glowN;
    this.shoulderLights.instanceMatrix.needsUpdate = true;
    if (this.shoulderLights.instanceColor) this.shoulderLights.instanceColor.needsUpdate = true;

    for (let i = this.gearN; i < this.gearShown; i++) this.gear.setVisibleAt(i, false);
    this.gearShown = this.gearN;

    for (const m of this.parts) {
      m.count = m === this.arms || m === this.legs ? this.n * 2 : this.n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }

    // Soft-lock marker on whatever the weapon is locked on to.
    const target =
      combat.aimKind === 'vehicle' ? world.vehicles[combat.aimId] : combat.aimKind === 'officer' ? world.officers.officers[combat.aimId] : combat.aimKind === 'ped' ? world.peds.peds[combat.aimId] : undefined;
    this.aimMarker.visible = !!target && !pc.incapacitated;
    if (target) {
      this.aimMarker.position.x = lerp(target.prevX, target.x, alpha);
      this.aimMarker.position.z = lerp(target.prevZ, target.z, alpha);
      this.aimMarker.rotation.z = time * 3;
      this.aimMarker.scale.setScalar(combat.aimKind === 'vehicle' ? 1 : 0.55);
    }

    let tn = 0;
    for (let i = 0; i < MAX_TRACERS; i++) {
      if (this.tracerLife[i]! <= 0) continue;
      this.tracerLife[i]! -= dt;
      const t = this.tracerData[i]!;
      const dx = t.hx - t.x;
      const dz = t.hz - t.z;
      const len = Math.hypot(dx, dz);
      o.position.set((t.x + t.hx) / 2, 1.4, (t.z + t.hz) / 2);
      o.rotation.set(0, Math.atan2(dx, dz), 0);
      o.scale.set(0.08, 0.08, len);
      o.updateMatrix();
      this.tracers.setMatrixAt(tn++, o.matrix);
    }
    this.tracers.count = tn;
    this.tracers.instanceMatrix.needsUpdate = true;
  }
}
