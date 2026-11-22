import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
  type Scene,
} from 'three';
import type { World } from '@neonheat/sim';

const SEGMENTS = 900;
const LIFE = 14;
const WHEELS = 2;
const MAX_TRACKED = 64;

/**
 * Tyre marks: dark strips laid behind the rear wheels while a car slides,
 * handbrakes or brakes hard, fading out over a few seconds. One instanced
 * mesh used as a ring buffer of segments; no allocation per frame.
 */
export class SkidMarks {
  readonly mesh: InstancedMesh;
  private readonly born: InstancedBufferAttribute;
  private readonly mat: ShaderMaterial;
  private next = 0;
  private readonly last = new Float32Array(MAX_TRACKED * WHEELS * 3); // x, z, valid
  private readonly o = new Object3D();
  private readonly m = new Matrix4();
  /** Set each frame: where smoke should puff (for the particle system), as [x, z] pairs. */
  readonly smoke: number[] = [];

  constructor(scene: Scene) {
    const g = new PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    this.born = new InstancedBufferAttribute(new Float32Array(SEGMENTS).fill(-1000), 1);
    this.born.setUsage(DynamicDrawUsage);
    g.setAttribute('aBorn', this.born);
    this.mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uLife: { value: LIFE } },
      vertexShader: /* glsl */ `
        attribute float aBorn;
        uniform float uTime;
        uniform float uLife;
        varying float vA;
        varying vec2 vUv;
        void main() {
          vA = clamp(1.0 - (uTime - aBorn) / uLife, 0.0, 1.0);
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        varying vec2 vUv;
        void main() {
          float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x);
          gl_FragColor = vec4(0.02, 0.02, 0.03, 0.55 * vA * edge);
        }`,
    });
    this.mesh = new InstancedMesh(g, this.mat, SEGMENTS);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.name = 'skid-marks';
    // Park every segment far below the world until it is used.
    this.o.position.set(0, -100, 0);
    this.o.updateMatrix();
    for (let i = 0; i < SEGMENTS; i++) this.mesh.setMatrixAt(i, this.o.matrix);
    scene.add(this.mesh);
  }

  update(world: World, time: number): void {
    this.mat.uniforms.uTime!.value = time;
    this.smoke.length = 0;
    let dirty = false;
    for (const v of world.vehicles) {
      if (v.id >= MAX_TRACKED) continue;
      const base = v.id * WHEELS * 3;
      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      const vf = v.vx * fx + v.vz * fz;
      const vl = v.vx * fz - v.vz * fx;
      const speed = Math.hypot(v.vx, v.vz);
      const marking =
        v.active &&
        !v.destroyed &&
        speed > 4 &&
        (Math.abs(vl) > 2.6 || (v.controls.handbrake && speed > 5) || (v.controls.brake > 0.6 && vf > 9));
      for (let w = 0; w < WHEELS; w++) {
        const k = base + w * 3;
        if (!marking) {
          this.last[k + 2] = 0;
          continue;
        }
        const side = w === 0 ? 1 : -1;
        const back = v.params.length * 0.32;
        const half = v.params.width / 2 - 0.25;
        const x = v.x - fx * back + fz * half * side;
        const z = v.z - fz * back - fx * half * side;
        if (this.last[k + 2] === 1) {
          const lx = this.last[k]!;
          const lz = this.last[k + 1]!;
          const dx = x - lx;
          const dz = z - lz;
          const len = Math.hypot(dx, dz);
          if (len < 0.35) continue;
          if (len < 4) {
            const i = this.next;
            this.next = (i + 1) % SEGMENTS;
            this.o.position.set((x + lx) / 2, 0.035, (z + lz) / 2);
            this.o.rotation.set(0, Math.atan2(dx, dz), 0);
            this.o.scale.set(0.28, 1, len + 0.05);
            this.o.updateMatrix();
            this.mesh.setMatrixAt(i, this.m.copy(this.o.matrix));
            (this.born.array as Float32Array)[i] = time;
            dirty = true;
          }
          if (w === 0 && Math.abs(vl) > 4) this.smoke.push(x, z);
        }
        this.last[k] = x;
        this.last[k + 1] = z;
        this.last[k + 2] = 1;
      }
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.born.needsUpdate = true;
    }
  }
}
