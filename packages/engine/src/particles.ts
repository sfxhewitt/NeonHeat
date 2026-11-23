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
  private readonly fade: boolean;

  constructor(
    scene: Scene,
    capacity: number,
    mode: 'additive' | 'smoke' | 'solid',
    private readonly grow: number,
  ) {
    const geo = new BoxGeometry(1, 1, 1);
    const mat =
      mode === 'additive'
        ? new MeshBasicMaterial({ blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false })
        : mode === 'smoke'
          ? new MeshLambertMaterial({ transparent: true, opacity: 0.85, depthWrite: false })
          : new MeshLambertMaterial({ flatShading: true });
    this.fade = mode !== 'solid';
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
      const s = p.size * (this.grow > 0 ? 1 + (1 - t) * this.grow : this.fade ? t : Math.min(1, t * 4));
      o.position.set(p.x, p.y, p.z);
      if (!this.fade) o.rotation.set(p.vx * 0.3 + t * 9, p.vz * 0.3 + t * 7, 0);
      o.scale.set(s, s, s);
      o.updateMatrix();
      this.mesh.setMatrixAt(n, o.matrix);
      if (this.fade) this.mesh.setColorAt(n, c.setRGB(p.r * t, p.g * t, p.b * t));
      else this.mesh.setColorAt(n, c.setRGB(p.r, p.g, p.b));
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
  /** Chunks of smashed street furniture (solid, lit). */
  readonly debris: ParticleLayer;
  /** Deterministic-enough jitter source for visuals only. */
  private seed = 1;

  constructor(scene: Scene, capacity = 256) {
    this.sparks = new ParticleLayer(scene, capacity, 'additive', 0);
    this.smoke = new ParticleLayer(scene, capacity / 2, 'smoke', 2.5);
    this.debris = new ParticleLayer(scene, 160, 'solid', 0);
    this.debris.mesh.name = 'debris';
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

  /** A blast: a ball of fire that rises and fades, flying sparks, then dark smoke. */
  explosion(x: number, z: number, radius: number): void {
    const fire = [0xffe08a, 0xffa040, 0xff5a2a, 0xffffff];
    const sp = 2 + radius * 0.6;
    for (let i = 0; i < 36; i++) {
      const a = this.rand() * Math.PI * 2;
      const r = this.rand();
      this.sparks.spawn(x, 0.6 + this.rand(), z, Math.cos(a) * sp * r, 1.5 + this.rand() * 4, Math.sin(a) * sp * r, 0.35 + this.rand() * 0.35, 0.9 + this.rand() * 0.9, -2, fire[i % fire.length]!);
    }
    this.burstSparks(x, z, 26, radius * 2.5);
    for (let i = 0; i < 6; i++) this.puffSmoke(x + (this.rand() - 0.5) * radius * 0.5, z + (this.rand() - 0.5) * radius * 0.5, true);
  }

  muzzle(x: number, y: number, z: number, dx: number, dz: number): void {
    for (let i = 0; i < 4; i++) {
      this.sparks.spawn(x, y, z, dx * (10 + this.rand() * 10), 0.5, dz * (10 + this.rand() * 10), 0.08, 0.35, 0, 0xfff2a0);
    }
  }

  /** Smashed furniture: chunks thrown along the car's path, plus a spray for hydrants. */
  burstDebris(x: number, z: number, vx: number, vz: number, colour: number, count: number, spray = false): void {
    for (let i = 0; i < count; i++) {
      const k = 0.35 + this.rand() * 0.7;
      this.debris.spawn(
        x + (this.rand() - 0.5) * 0.6,
        0.4 + this.rand() * 0.6,
        z + (this.rand() - 0.5) * 0.6,
        vx * k + (this.rand() - 0.5) * 5,
        3 + this.rand() * 5,
        vz * k + (this.rand() - 0.5) * 5,
        1.4 + this.rand() * 1.2,
        0.12 + this.rand() * 0.22,
        18,
        colour,
      );
    }
    if (spray) {
      for (let i = 0; i < 40; i++) {
        const a = this.rand() * Math.PI * 2;
        const sp = this.rand() * 1.6;
        this.sparks.spawn(x, 0.6, z, Math.cos(a) * sp, 7 + this.rand() * 5, Math.sin(a) * sp, 0.9 + this.rand() * 0.6, 0.14, 14, 0x9fd8ff);
      }
    }
  }

  update(dt: number): void {
    this.sparks.update(dt);
    this.debris.update(dt);
    this.smoke.update(dt);
  }
}
