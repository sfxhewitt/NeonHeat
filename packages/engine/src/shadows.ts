import { CanvasTexture, DynamicDrawUsage, InstancedMesh, MeshBasicMaterial, Object3D, PlaneGeometry, type Scene } from 'three';
import { lerp, type World } from '@neonheat/sim';

/** Blob shadows under every car, ped and the player: one instanced draw call, no real-time shadows. */
export class BlobShadows {
  readonly mesh: InstancedMesh;
  private readonly o = new Object3D();

  constructor(scene: Scene, capacity = 128) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(0,0,0,0.75)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const geo = new PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new InstancedMesh(geo, new MeshBasicMaterial({ map: new CanvasTexture(c), transparent: true, depthWrite: false }), capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.name = 'blob-shadows';
    scene.add(this.mesh);
  }

  update(world: World, alpha: number): void {
    const o = this.o;
    let n = 0;
    const cap = this.mesh.instanceMatrix.count;
    const put = (x: number, z: number, yaw: number, w: number, l: number): void => {
      if (n >= cap) return;
      o.position.set(x, 0.04, z);
      o.rotation.set(0, yaw, 0);
      o.scale.set(w, 1, l);
      o.updateMatrix();
      this.mesh.setMatrixAt(n++, o.matrix);
    };
    for (const v of world.vehicles) {
      if (v.active) put(lerp(v.prevX, v.x, alpha), lerp(v.prevZ, v.z, alpha), v.yaw, v.params.width * 1.5, v.params.length * 1.3);
    }
    for (const p of world.peds.peds) if (p.active) put(lerp(p.prevX, p.x, alpha), lerp(p.prevZ, p.z, alpha), 0, 1.3, 1.3);
    const pc = world.playerCtl;
    if (pc.mode === 'foot') put(lerp(pc.prevX, pc.x, alpha), lerp(pc.prevZ, pc.z, alpha), 0, 1.5, 1.5);
    const d = world.police.drone;
    if (d.active) put(lerp(d.prevX, d.x, alpha), lerp(d.prevZ, d.z, alpha), 0, 3.5, 3.5);
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
