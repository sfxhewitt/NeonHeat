import { BLOOM_LAYER } from './layers';
import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  type Scene,
} from 'three';

interface Particle {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  gravity: number;
  r: number;
  g: number;
  b: number;
}

/** A pooled particle layer drawn as one instanced mesh. No allocation after construction. */
class ParticleLayer {
  readonly mesh: InstancedMesh;
  private readonly pool: Particle[] = [];
  private next = 0;
  private readonly o = new Object3D();
  private readonly c = new Color();

  constructor(
    scene: Scene,
    capacity: number,
    additive: boolean,
    private readonly grow: number,
  ) {
    const geo = new BoxGeometry(1, 1, 1);
    const mat = additive
      ? new MeshBasicMaterial({ blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false })
      : new MeshLambertMaterial({ transparent: true, opacity: 0.85, depthWrite: false });
    this.mesh = new InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.setColorAt(0, this.c.set(0xffffff));
    scene.add(this.mesh);
    for (let i = 0; i < capacity; i++) {
      this.pool.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 1, gravity: 0, r: 1, g: 1, b: 1 });
    }
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, gravity: number, colour: number): void {
    const p = this.pool[this.next]!;
    this.next = (this.next + 1) % this.pool.length;
    p.alive = true;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.life = p.maxLife = life;
    p.size = size;
    p.gravity = gravity;
    this.c.setHex(colour);
    p.r = this.c.r;
    p.g = this.c.g;
    p.b = this.c.b;
  }

  update(dt: number): void {
    let n = 0;
    const { o, c } = this;
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        continue;
      }
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.05) {
        p.y = 0.05;
        p.vy *= -0.3;
        p.vx *= 0.6;
        p.vz *= 0.6;
      }
      const t = p.life / p.maxLife;
      const s = p.size * (this.grow > 0 ? 1 + (1 - t) * this.grow : t);
      o.position.set(p.x, p.y, p.z);
      o.scale.set(s, s, s);
      o.updateMatrix();
      this.mesh.setMatrixAt(n, o.matrix);
      this.mesh.setColorAt(n, c.setRGB(p.r * t, p.g * t, p.b * t));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/** Sparks (additive, glowing) and smoke (dark, growing). */
export class Particles {
  readonly sparks: ParticleLayer;
  readonly smoke: ParticleLayer;
  /** Deterministic-enough jitter source for visuals only. */
  private seed = 1;

  constructor(scene: Scene, capacity = 256) {
    this.sparks = new ParticleLayer(scene, capacity, true, 0);
    this.smoke = new ParticleLayer(scene, capacity / 2, false, 2.5);
    this.sparks.mesh.name = 'sparks';
    this.sparks.mesh.layers.enable(BLOOM_LAYER);
    this.smoke.mesh.name = 'smoke';
  }

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  burstSparks(x: number, z: number, count: number, strength: number): void {
    const colours = [0xffd27a, 0xff9a3c, 0xffffff, 0x21f0ff];
    for (let i = 0; i < count; i++) {
      const a = this.rand() * Math.PI * 2;
      const sp = (0.4 + this.rand()) * (4 + strength * 0.6);
      this.sparks.spawn(x, 0.8, z, Math.cos(a) * sp, 2 + this.rand() * 6, Math.sin(a) * sp, 0.25 + this.rand() * 0.35, 0.22, 22, colours[i % colours.length]!);
    }
  }

  puffSmoke(x: number, z: number, dark: boolean): void {
    this.smoke.spawn(x + (this.rand() - 0.5), 1.2, z + (this.rand() - 0.5), (this.rand() - 0.5) * 1.5, 2 + this.rand() * 2, (this.rand() - 0.5) * 1.5, 1.4, 0.9, -0.5, dark ? 0x1a1a22 : 0x55556a);
  }

  muzzle(x: number, y: number, z: number, dx: number, dz: number): void {
    for (let i = 0; i < 4; i++) {
      this.sparks.spawn(x, y, z, dx * (10 + this.rand() * 10), 0.5, dz * (10 + this.rand() * 10), 0.08, 0.35, 0, 0xfff2a0);
    }
  }

  update(dt: number): void {
    this.sparks.update(dt);
    this.smoke.update(dt);
  }
}
