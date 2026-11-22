import { BoxGeometry, Color, DynamicDrawUsage, InstancedMesh, MeshBasicMaterial, MeshLambertMaterial, Object3D, type Scene } from 'three';
import { lerp, lerpAngle, type Vehicle, type World } from '@neonheat/sim';
import { Palette } from './palette';
import { BLOOM_LAYER } from './layers';

const MAX = 48;

/**
 * All vehicles in three instanced draw calls: body, cabin and light strips.
 * Reads sim state and interpolates between the previous and current step.
 */
export class VehiclesView {
  readonly body: InstancedMesh;
  readonly cabin: InstancedMesh;
  readonly lights: InstancedMesh;
  private readonly o = new Object3D();
  private readonly c = new Color();
  private readonly base = new Color();

  constructor(scene: Scene) {
    const box = new BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    this.body = new InstancedMesh(box, new MeshLambertMaterial({ flatShading: true }), MAX);
    this.cabin = new InstancedMesh(box, new MeshLambertMaterial({ color: 0x0c0d18, flatShading: true }), MAX);
    this.lights = new InstancedMesh(box, new MeshBasicMaterial({ toneMapped: false }), MAX * 2);
    for (const m of [this.body, this.cabin, this.lights]) {
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
    this.lights.layers.enable(BLOOM_LAYER);
    this.body.name = 'vehicle-bodies';
    this.cabin.name = 'vehicle-cabins';
    this.lights.name = 'vehicle-lights';
    // Initialise instance colour buffers.
    this.body.setColorAt(0, this.c.set(0xffffff));
    this.lights.setColorAt(0, this.c.set(0xffffff));
  }

  update(world: World, alpha: number): void {
    const { o, c } = this;
    let n = 0;
    let ln = 0;
    const flash = Math.floor(world.time * 6) % 2 === 0;
    for (const v of world.vehicles) {
      if (!v.active || n >= MAX) continue;
      const p = v.params;
      const x = lerp(v.prevX, v.x, alpha);
      const z = lerp(v.prevZ, v.z, alpha);
      const yaw = lerpAngle(v.prevYaw, v.yaw, alpha);
      o.position.set(x, 0.25, z);
      o.rotation.set(0, yaw, 0);
      o.scale.set(p.width, p.height * 0.55, p.length);
      o.updateMatrix();
      this.body.setMatrixAt(n, o.matrix);
      const health = Math.max(0, v.hp / p.maxHealth);
      this.base.set(p.colour);
      if (v.destroyed) c.setHex(0x161616);
      else c.copy(this.base).multiplyScalar(0.35 + 0.65 * health);
      this.body.setColorAt(n, c);

      o.position.set(x - Math.sin(yaw) * p.length * 0.06, 0.25 + p.height * 0.55, z - Math.cos(yaw) * p.length * 0.06);
      o.scale.set(p.width * 0.82, p.height * 0.4, p.length * 0.5);
      o.updateMatrix();
      this.cabin.setMatrixAt(n, o.matrix);
      n++;

      if (v.destroyed) continue;
      // Front strip: headlights, or police light bar.
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      ln = this.light(ln, x + fx * p.length * 0.5, z + fz * p.length * 0.5, yaw, p.width * 0.9, 0.15, 0.6, lightColour(v, flash, true, c));
      ln = this.light(ln, x - fx * p.length * 0.5, z - fz * p.length * 0.5, yaw, p.width * 0.9, 0.15, 0.6, lightColour(v, flash, false, c));
    }
    this.body.count = n;
    this.cabin.count = n;
    this.lights.count = ln;
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
    this.lights.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    if (this.lights.instanceColor) this.lights.instanceColor.needsUpdate = true;
  }

  private light(i: number, x: number, z: number, yaw: number, w: number, d: number, y: number, col: Color): number {
    const o = this.o;
    o.position.set(x, y, z);
    o.rotation.set(0, yaw, 0);
    o.scale.set(w, 0.18, d);
    o.updateMatrix();
    this.lights.setMatrixAt(i, o.matrix);
    this.lights.setColorAt(i, col);
    return i + 1;
  }
}

function lightColour(v: Vehicle, flash: boolean, front: boolean, out: Color): Color {
  if (v.role === 'police' && front) return out.setHex(flash ? Palette.policeRed : Palette.policeBlue);
  if (v.role === 'squad' && front) return out.setHex(Palette.policeRed);
  if (front) return out.setHex(0xfff2d0);
  const braking = v.controls.brake > 0.1 || v.controls.handbrake;
  return out.setHex(braking ? 0xff2a3d : 0x7a0f1d);
}
