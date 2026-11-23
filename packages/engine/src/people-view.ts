import {
  AdditiveBlending,
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
import { groundHeight, lerp, lerpAngle, type MapContent, type World } from '@neonheat/sim';
import { Palette } from './palette';
import { BLOOM_LAYER } from './layers';
import { MeshBuilder } from './mesh-kit';

const MAX_PEOPLE = 65;
const MAX_TRACERS = 16;
/** People are drawn a little larger than life so they read from the top-down camera on a phone. */
const SCALE = 1.45;

const HIP_Y = 0.94;
const SHOULDER_Y = 1.48;
const NECK_Y = 1.56;

/** Skin tones, jacket and trouser colours for pedestrians (instance colours). */
const SKIN = [0xf1c9a5, 0xd9a47a, 0xa86f4c, 0x7a4b31, 0x5a3622, 0xe8b98f];
const TROUSERS = [0x2a2a3a, 0x1d2433, 0x3b3242, 0x24302c, 0x3a3a3a, 0x463a2e];

interface Rig {
  phase: number;
}

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
  readonly meshes: InstancedMesh[];
  private readonly visor: Mesh;
  private readonly pistol: Mesh;
  private readonly ring: Mesh;
  private readonly facingMark: Mesh;
  readonly aimMarker: Mesh;
  readonly tracers: InstancedMesh;
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
  /** 1 while the player is drawn as instance 0 (on foot): the shader gives them a bright rim. */
  private readonly playerOn = { value: 0 };

  constructor(scene: Scene, pedColours: string[]) {
    this.jackets = pedColours.map((h) => new Color(h));
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
    this.meshes = [this.torso, this.head, this.arms, this.legs];
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
    pose: 'stand' | 'down' | 'cower' | 'roll',
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
    } else {
      o.rotation.set(lean, facing, 0, 'YXZ');
    }
    o.updateMatrix();
    this.root.copy(o.matrix);

    this.torso.setMatrixAt(i, this.root);
    this.torso.setColorAt(i, jacket);
    o.position.set(0, NECK_Y, 0);
    o.rotation.set(pose === 'cower' ? -0.4 : 0, 0, 0);
    o.scale.setScalar(1);
    o.updateMatrix();
    this.head.setMatrixAt(i, this.out.multiplyMatrices(this.root, o.matrix));
    this.head.setColorAt(i, this.c.setHex(skin));

    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1;
      // Legs: opposite phase; arms counter-swing the legs.
      o.position.set(side * 0.12, HIP_Y, 0);
      o.rotation.set(pose === 'cower' ? -1.2 : swing * side, 0, 0);
      o.updateMatrix();
      this.legs.setMatrixAt(i * 2 + s, this.out.multiplyMatrices(this.root, o.matrix));
      this.legs.setColorAt(i * 2 + s, this.c.setHex(trousers));

      o.position.set(side * 0.29, SHOULDER_Y, 0);
      if (aiming && side === -1) o.rotation.set(-Math.PI / 2 + 0.08, 0, 0);
      else if (pose === 'cower') o.rotation.set(-2.4, 0, side * 0.3);
      else o.rotation.set(-swing * side * 0.8, 0, side * 0.06);
      o.updateMatrix();
      this.out.multiplyMatrices(this.root, o.matrix);
      this.arms.setMatrixAt(i * 2 + s, this.out);
      this.arms.setColorAt(i * 2 + s, jacket);
      if (side === -1) this.local.copy(this.out);
    }
  }

  private map: MapContent | null = null;

  update(world: World, alpha: number, dt: number, time: number): void {
    this.map = world.content.map;
    const o = this.o;
    this.n = 0;

    // The player first: pale jacket, acid visor, pistol and a ground ring.
    const pc = world.playerCtl;
    const onFoot = pc.mode === 'foot';
    for (const m of [this.visor, this.pistol, this.ring, this.facingMark]) m.visible = onFoot;
    this.playerOn.value = onFoot ? 1 : 0;
    if (onFoot) {
      const x = lerp(pc.prevX, pc.x, alpha);
      const z = lerp(pc.prevZ, pc.z, alpha);
      const facing = lerpAngle(pc.prevFacing, pc.facing, alpha);
      const speed = Math.hypot(pc.vx, pc.vz);
      const rolling = pc.dodgeTime > 0;
      const rollT = rolling ? 1 - pc.dodgeTime / world.content.peds.player.dodgeSec : 0;
      const aiming = pc.aimTarget >= 0 || pc.fireCooldown > 0;
      this.person(x, z, facing, rolling ? 0 : speed, this.rigs[0]!, dt, pc.dead ? 'down' : rolling ? 'roll' : 'stand', rollT, aiming && !pc.dead, this.jc.setHex(0xfafaff), 0x1a1a2c, 0xd9a47a);
      // Visor across the face, pistol in the right hand.
      o.position.set(0, NECK_Y + 0.24, 0.14);
      o.rotation.set(0, 0, 0);
      o.scale.setScalar(1);
      o.updateMatrix();
      this.visor.matrix.multiplyMatrices(this.root, o.matrix);
      o.position.set(0, -0.62, 0.06);
      o.rotation.set(Math.PI / 2, 0, 0);
      o.updateMatrix();
      this.pistol.matrix.multiplyMatrices(this.local, o.matrix);
      const ringY = this.map ? groundHeight(this.map, x, z) : 0;
      this.ring.position.set(x, ringY + 0.06, z);
      const pulse = 1 + Math.sin(time * 4) * 0.05;
      this.ring.scale.setScalar(pulse);
      this.facingMark.position.set(x + Math.sin(facing) * 1.2, ringY + 0.07, z + Math.cos(facing) * 1.2);
      this.facingMark.rotation.set(0, facing - Math.PI / 2, 0);
    }

    for (const p of world.peds.peds) {
      if (!p.active || this.n >= MAX_PEOPLE) continue;
      const x = lerp(p.prevX, p.x, alpha);
      const z = lerp(p.prevZ, p.z, alpha);
      const rig = this.rigs[(p.id % (MAX_PEOPLE - 1)) + 1]!;
      const pose = p.state === 'down' ? 'down' : p.state === 'cower' ? 'cower' : 'stand';
      const speed = pose === 'stand' ? Math.hypot(p.vx, p.vz) : 0;
      const jacket = this.jackets[p.colour % this.jackets.length]!;
      const shade = p.state === 'down' ? 0.45 : 1;
      this.person(
        x,
        z,
        lerpAngle(p.prevFacing, p.facing, alpha),
        speed,
        rig,
        dt,
        pose,
        0,
        false,
        this.jc.copy(jacket).multiplyScalar(shade),
        TROUSERS[(p.id * 7) % TROUSERS.length]!,
        SKIN[(p.id * 5 + p.colour) % SKIN.length]!,
      );
    }
    for (const m of this.meshes) {
      m.count = m === this.arms || m === this.legs ? this.n * 2 : this.n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }

    const target = onFoot && pc.aimTarget >= 0 ? world.vehicles[pc.aimTarget] : undefined;
    this.aimMarker.visible = !!target;
    if (target) {
      this.aimMarker.position.x = lerp(target.prevX, target.x, alpha);
      this.aimMarker.position.z = lerp(target.prevZ, target.z, alpha);
      this.aimMarker.rotation.z = time * 3;
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
