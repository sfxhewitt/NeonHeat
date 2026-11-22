import {
  AdditiveBlending,
  BoxGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  RingGeometry,
  type Scene,
} from 'three';
import { lerp, lerpAngle, type World } from '@neonheat/sim';
import { Palette } from './palette';

const MAX_PEDS = 64;
const MAX_TRACERS = 16;

/** Pedestrians (one instanced draw call), the player, the aim marker and bullet tracers. */
export class PeopleView {
  readonly peds: InstancedMesh;
  readonly player = new Group();
  readonly aimMarker: Mesh;
  readonly tracers: InstancedMesh;
  private readonly tracerLife = new Float32Array(MAX_TRACERS);
  private readonly tracerData: { x: number; z: number; hx: number; hz: number }[] = [];
  private nextTracer = 0;
  private readonly o = new Object3D();
  private readonly c = new Color();
  private readonly pedColours: Color[];

  constructor(scene: Scene, pedColours: string[]) {
    this.pedColours = pedColours.map((h) => new Color(h));
    const body = new CapsuleGeometry(0.32, 1.0, 2, 6);
    body.translate(0, 0.82, 0);
    this.peds = new InstancedMesh(body, new MeshLambertMaterial({ flatShading: true }), MAX_PEDS);
    this.peds.instanceMatrix.setUsage(DynamicDrawUsage);
    this.peds.frustumCulled = false;
    this.peds.count = 0;
    this.peds.setColorAt(0, this.c.set(0xffffff));
    this.peds.name = 'peds';
    scene.add(this.peds);

    const pBody = new Mesh(new CapsuleGeometry(0.38, 1.1, 2, 8), new MeshLambertMaterial({ color: 0xe9e6ff, flatShading: true }));
    pBody.position.y = 0.95;
    // Neon visor pointing where the player faces (shape + colour cue).
    const visor = new Mesh(new BoxGeometry(0.5, 0.16, 0.3), new MeshBasicMaterial({ color: Palette.acid, toneMapped: false }));
    visor.position.set(0, 1.55, 0.3);
    const nose = new Mesh(new ConeGeometry(0.25, 0.6, 4), new MeshBasicMaterial({ color: Palette.acid, toneMapped: false }));
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.15, 0.85);
    this.player.add(pBody, visor, nose);
    this.player.name = 'player';
    scene.add(this.player);

    this.aimMarker = new Mesh(new RingGeometry(1.8, 2.3, 4), new MeshBasicMaterial({ color: Palette.policeRed, transparent: true, opacity: 0.9, toneMapped: false }));
    this.aimMarker.rotation.x = -Math.PI / 2;
    this.aimMarker.position.y = 0.08;
    this.aimMarker.visible = false;
    this.aimMarker.name = 'aim-marker';
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

  update(world: World, alpha: number, dt: number, time: number): void {
    const { o, c } = this;
    let n = 0;
    for (const p of world.peds.peds) {
      if (!p.active || n >= MAX_PEDS) continue;
      const x = lerp(p.prevX, p.x, alpha);
      const z = lerp(p.prevZ, p.z, alpha);
      o.position.set(x, 0, z);
      o.rotation.set(0, lerpAngle(p.prevFacing, p.facing, alpha), 0);
      o.scale.set(1, 1, 1);
      if (p.state === 'down') {
        o.rotation.x = Math.PI / 2;
        o.position.y = 0.3;
      } else if (p.state === 'cower') {
        o.scale.set(1.1, 0.55, 1.1);
      }
      o.updateMatrix();
      this.peds.setMatrixAt(n, o.matrix);
      c.copy(this.pedColours[p.colour % this.pedColours.length]!);
      if (p.state === 'down') c.multiplyScalar(0.35);
      this.peds.setColorAt(n, c);
      n++;
    }
    this.peds.count = n;
    this.peds.instanceMatrix.needsUpdate = true;
    if (this.peds.instanceColor) this.peds.instanceColor.needsUpdate = true;

    const pc = world.playerCtl;
    const onFoot = pc.mode === 'foot';
    this.player.visible = onFoot;
    if (onFoot) {
      this.player.position.set(lerp(pc.prevX, pc.x, alpha), 0, lerp(pc.prevZ, pc.z, alpha));
      this.player.rotation.set(pc.dead ? Math.PI / 2 : 0, lerpAngle(pc.prevFacing, pc.facing, alpha), 0);
      if (pc.dodgeTime > 0) this.player.rotation.x = (1 - pc.dodgeTime / world.content.peds.player.dodgeSec) * Math.PI * 2;
      if (pc.dead) this.player.position.y = 0.4;
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
      o.position.set((t.x + t.hx) / 2, 1.0, (t.z + t.hz) / 2);
      o.rotation.set(0, Math.atan2(dx, dz), 0);
      o.scale.set(0.08, 0.08, len);
      o.updateMatrix();
      this.tracers.setMatrixAt(tn++, o.matrix);
    }
    this.tracers.count = tn;
    this.tracers.instanceMatrix.needsUpdate = true;
  }
}
