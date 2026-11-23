import type RAPIER_NS from '@dimforge/rapier3d-simd-compat';
import type { PropsConfig } from './content';
import { Groups, interactionGroups } from './physics';
import type { World } from './world';

export interface Prop {
  id: number;
  kind: string;
  x: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
  h: number;
  breakable: boolean;
  broken: boolean;
  /** Seconds since it was smashed. */
  brokenFor: number;
  collider: RAPIER_NS.Collider | null;
}

const CELL = 16;

/**
 * Street furniture. Everything is a static collider, so people and slow cars
 * bump into it. Breakable props (bins, benches, bollards, hydrants, crates,
 * barriers) are smashed by a vehicle arriving fast enough: the collider is
 * switched off just before the physics step, so the car ploughs through with
 * a little lost speed instead of stopping dead, and the prop comes back a
 * while later once nobody is near.
 */
export class PropSystem {
  readonly props: Prop[] = [];
  private readonly grid = new Map<number, number[]>();

  constructor(
    private readonly world: World,
    private readonly config: PropsConfig,
  ) {
    const { R, physics } = world;
    const groups = interactionGroups(Groups.static, 0xffff);
    world.content.map.props.forEach((p, id) => {
      const k = config.kinds[p.kind]!;
      const collider = physics.createCollider(
        R.ColliderDesc.cuboid(k.w / 2, k.h / 2, k.d / 2)
          .setTranslation(p.x, k.h / 2, p.z)
          .setRotation({ x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) })
          .setCollisionGroups(groups)
          .setFriction(0.1),
      );
      world.registerCollider(collider, 'static', -1);
      this.props.push({ ...p, id, w: k.w, d: k.d, h: k.h, breakable: k.breakable, broken: false, brokenFor: 0, collider });
      if (k.breakable) {
        const key = this.key(p.x, p.z);
        const cell = this.grid.get(key);
        if (cell) cell.push(id);
        else this.grid.set(key, [id]);
      }
    });
  }

  private key(x: number, z: number): number {
    return (Math.floor(x / CELL) + 512) * 1024 + (Math.floor(z / CELL) + 512);
  }

  /** Call after vehicle velocities are set and before the physics step. */
  step(dt: number): void {
    const w = this.world;
    const cfg = this.config;
    for (const v of w.vehicles) {
      if (!v.active) continue;
      const speed = Math.hypot(v.vx, v.vz);
      if (speed < 1.5) continue;
      // Where the car will be after this step (plus a little), so the collider is gone before contact.
      const px = v.x + v.vx * dt * 2;
      const pz = v.z + v.vz * dt * 2;
      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      const cx = Math.floor(px / CELL);
      const cz = Math.floor(pz / CELL);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
          const cell = this.grid.get((gx + 512) * 1024 + (gz + 512));
          if (!cell) continue;
          for (const id of cell) {
            const p = this.props[id]!;
            if (p.broken) continue;
            const k = cfg.kinds[p.kind]!;
            if (speed < k.breakSpeed) continue;
            const dx = p.x - px;
            const dz = p.z - pz;
            const rad = Math.max(p.w, p.d) / 2;
            const along = dx * fx + dz * fz;
            const lat = dx * fz - dz * fx;
            if (Math.abs(along) > v.params.length / 2 + rad + 0.25 || Math.abs(lat) > v.params.width / 2 + rad + 0.1) continue;
            p.broken = true;
            p.brokenFor = 0;
            p.collider?.setEnabled(false);
            v.vx *= 1 - k.slowdown;
            v.vz *= 1 - k.slowdown;
            v.body?.setLinvel({ x: v.vx, y: 0, z: v.vz }, true);
            w.events.push({
              type: 'propBroken',
              propId: id,
              kind: p.kind,
              x: p.x,
              z: p.z,
              vx: v.vx,
              vz: v.vz,
              byPlayer: v === w.player.vehicle,
            });
          }
        }
      }
    }
    for (const p of this.props) {
      if (!p.broken) continue;
      p.brokenFor += dt;
      if (p.brokenFor < cfg.respawnSec) continue;
      if (this.anyoneNear(p.x, p.z, cfg.respawnMinDist)) continue;
      p.broken = false;
      p.collider?.setEnabled(true);
    }
  }

  private anyoneNear(x: number, z: number, r: number): boolean {
    const w = this.world;
    const px = w.player.vehicle?.x ?? w.playerCtl.x;
    const pz = w.player.vehicle?.z ?? w.playerCtl.z;
    if (Math.hypot(px - x, pz - z) < r) return true;
    for (const v of w.vehicles) if (v.active && Math.hypot(v.x - x, v.z - z) < 4) return true;
    return false;
  }
}
