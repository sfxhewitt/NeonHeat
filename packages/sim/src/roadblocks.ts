import type { VehicleParams } from './content';
import { resetAiState } from './ai';
import type { Vehicle, World } from './world';

/** A spike strip across the road (pooled). */
export interface SpikeStrip {
  active: boolean;
  x: number;
  z: number;
  /** Unit vector along the strip (across the road). */
  dirX: number;
  dirZ: number;
  halfLength: number;
  halfWidth: number;
  time: number;
}

interface Block {
  active: boolean;
  x: number;
  z: number;
  /** The player's direction of travel when the block went up (the player has passed once beyond it). */
  hx: number;
  hz: number;
  time: number;
  cars: number[];
}

/**
 * HEAT 4+: roadblocks (patrol cars parked across the road ahead of the
 * player) with a spike strip in front. Running the strip pops the tyres:
 * less grip, lower top speed, slower acceleration until you change car.
 */
export class RoadblockSystem {
  readonly spikes: SpikeStrip[] = [];
  readonly blocks: Block[] = [];
  private timer = 0;
  private readonly popped = new Map<string, VehicleParams>();

  constructor(private readonly world: World) {
    const cfg = world.content.heat;
    for (let i = 0; i < cfg.spikes.pool; i++) this.spikes.push({ active: false, x: 0, z: 0, dirX: 1, dirZ: 0, halfLength: 0, halfWidth: 0, time: 0 });
    for (let i = 0; i < Math.max(1, cfg.roadblocks.maxActive); i++) this.blocks.push({ active: false, x: 0, z: 0, hx: 0, hz: 1, time: 0, cars: [] });
    this.timer = cfg.roadblocks.intervalSec * 0.4;
  }

  /** The handling a car has on burst tyres. */
  poppedParams(v: Vehicle): VehicleParams {
    let p = this.popped.get(v.variantId);
    if (!p) {
      const base = this.world.content.vehicles.variants[v.variantId]!;
      const s = this.world.content.heat.spikes;
      p = { ...base, grip: base.grip * s.gripMul, latGripMax: base.latGripMax * s.latGripMul, topSpeed: base.topSpeed * s.topSpeedMul, acceleration: base.acceleration * s.accelMul };
      this.popped.set(v.variantId, p);
    }
    return p;
  }

  isPopped(v: Vehicle): boolean {
    return v.params === this.popped.get(v.variantId);
  }

  pop(v: Vehicle): void {
    if (this.isPopped(v)) return;
    v.params = this.poppedParams(v);
    this.world.events.push({ type: 'tyresPopped', vehicleId: v.id, x: v.x, z: v.z, byPlayer: v === this.world.player.vehicle });
  }

  /** New tyres (a respray shop). */
  repair(v: Vehicle): void {
    if (this.isPopped(v)) v.params = this.world.content.vehicles.variants[v.variantId]!;
  }

  /** Lay a strip centred on (x, z) running along (dirX, dirZ). */
  placeSpikes(x: number, z: number, dirX: number, dirZ: number): SpikeStrip | null {
    const s = this.spikes.find((q) => !q.active);
    if (!s) return null;
    const cfg = this.world.content.heat.spikes;
    const len = Math.hypot(dirX, dirZ) || 1;
    s.active = true;
    s.x = x;
    s.z = z;
    s.dirX = dirX / len;
    s.dirZ = dirZ / len;
    s.halfLength = cfg.length / 2;
    s.halfWidth = cfg.width / 2;
    s.time = this.world.time;
    return s;
  }

  clear(): void {
    for (const s of this.spikes) s.active = false;
    for (const b of this.blocks) this.dissolve(b);
  }

  private dissolve(b: Block): void {
    const w = this.world;
    for (const id of b.cars) {
      const v = w.vehicles[id]!;
      if (v.active && v.role === 'police' && v.ai.mode === 'roadblock') v.ai.mode = 'leave';
    }
    b.cars.length = 0;
    b.active = false;
  }

  step(dt: number): void {
    const w = this.world;
    const cfg = w.content.heat;
    const lvl = w.heat.levelConfig;
    // Expire old strips and blocks.
    for (const s of this.spikes) if (s.active && w.time - s.time > cfg.spikes.lifetimeSec && w.distToPlayer(s.x, s.z) > 40) s.active = false;
    for (const b of this.blocks) {
      if (!b.active) continue;
      const passed = (b.x - w.player.x) * b.hx + (b.z - w.player.z) * b.hz < -20;
      if (w.heat.level === 0 || (w.time - b.time > cfg.roadblocks.lifetimeSec && w.distToPlayer(b.x, b.z) > 40) || (passed && w.distToPlayer(b.x, b.z) > 60)) this.dissolve(b);
    }
    if (w.heat.level === 0) {
      for (const s of this.spikes) if (s.active && w.time - s.time > 8 && w.distToPlayer(s.x, s.z) > 40) s.active = false;
    }
    this.checkSpikes();
    this.timer -= dt;
    if (!lvl.roadblocks || this.timer > 0) return;
    const pv = w.player.vehicle;
    if (!pv || Math.hypot(pv.vx, pv.vz) < cfg.roadblocks.minPlayerSpeed) return;
    const b = this.blocks.find((q) => !q.active);
    if (!b) return;
    this.timer = cfg.roadblocks.intervalSec;
    this.build(b, pv, lvl.spikes);
  }

  private checkSpikes(): void {
    const w = this.world;
    for (const s of this.spikes) {
      if (!s.active) continue;
      for (const v of w.vehicles) {
        if (!v.active || v.destroyed || v.role === 'police' || this.isPopped(v)) continue;
        const dx = v.x - s.x;
        const dz = v.z - s.z;
        const along = dx * s.dirX + dz * s.dirZ;
        if (Math.abs(along) > s.halfLength) continue;
        const across = Math.abs(dx * -s.dirZ + dz * s.dirX);
        if (across > s.halfWidth + v.params.length * 0.4) continue;
        this.pop(v);
      }
    }
  }

  /** Find a stretch of road ahead of the player, out of view, and block it. */
  private build(b: Block, pv: Vehicle, spikes: boolean): boolean {
    const w = this.world;
    const cfg = w.content.heat;
    const rb = cfg.roadblocks;
    const sp = Math.hypot(pv.vx, pv.vz);
    const hx = pv.vx / sp;
    const hz = pv.vz / sp;
    let best = -Infinity;
    let bx = 0;
    let bz = 0;
    let ux = 0;
    let uz = 0;
    for (const n of w.roads.nodes) {
      for (const l of n.links) {
        if (l < n.id) continue;
        const m = w.roads.nodes[l]!;
        const lx = m.x - n.x;
        const lz = m.z - n.z;
        const len = Math.hypot(lx, lz);
        if (len < 30) continue;
        const align = (lx * hx + lz * hz) / len;
        if (Math.abs(align) < rb.alignDot) continue;
        const cx = (n.x + m.x) / 2;
        const cz = (n.z + m.z) / 2;
        const dx = cx - w.player.x;
        const dz = cz - w.player.z;
        const d = Math.hypot(dx, dz);
        if (d < rb.minDist || d > rb.maxDist) continue;
        const ahead = (dx * hx + dz * hz) / d;
        if (ahead < 0.85) continue;
        if (!w.police.offScreen(cx, cz)) continue;
        if (ahead > best) {
          best = ahead;
          bx = cx;
          bz = cz;
          const s = align >= 0 ? 1 : -1;
          ux = (lx / len) * s;
          uz = (lz / len) * s;
        }
      }
    }
    if (best === -Infinity) return false;
    // Two cars nose to tail across the road, centred on the stretch.
    const px = -uz;
    const pz = ux;
    const yaw = Math.atan2(px, pz);
    b.cars.length = 0;
    for (const side of [-1, 1]) {
      const v = w.spawnVehicle(rb.variant, bx + px * 2.6 * side, bz + pz * 2.6 * side, yaw, 'police');
      if (!v) continue;
      resetAiState(v.ai);
      v.ai.mode = 'roadblock';
      b.cars.push(v.id);
    }
    if (b.cars.length === 0) return false;
    b.active = true;
    b.x = bx;
    b.z = bz;
    b.hx = ux;
    b.hz = uz;
    b.time = w.time;
    if (spikes) this.placeSpikes(bx - ux * rb.spikeOffset, bz - uz * rb.spikeOffset, px, pz);
    w.events.push({ type: 'roadblock', x: bx, z: bz });
    return true;
  }
}
