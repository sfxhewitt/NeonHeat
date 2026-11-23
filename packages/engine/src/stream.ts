import type { InstancedMesh, Matrix4 } from 'three';

const CELL = 64;

/**
 * Streams a big set of instances into an InstancedMesh: only the ones within a
 * radius of the camera focus are drawn. The full list lives in typed arrays and
 * a coarse grid; the visible set is rebuilt when the focus has moved a few
 * metres, so a city of thousands of buildings, lamps and props costs only what
 * is near the player.
 */
export class InstanceStream {
  readonly count: number;
  private readonly mats: Float32Array;
  private readonly cols: Float32Array | null;
  private readonly xs: Float32Array;
  private readonly zs: Float32Array;
  private readonly cells = new Map<number, number[]>();
  private readonly overrides = new Map<number, Float32Array | null>();
  private lastX = Infinity;
  private lastZ = Infinity;
  /** Instance index of each item currently drawn, or -1. */
  readonly slotOf: Int32Array;
  private dirty = true;

  constructor(
    readonly mesh: InstancedMesh,
    items: { x: number; z: number; matrix: Matrix4; colour?: { r: number; g: number; b: number } }[],
    readonly radius = 230,
    readonly step = 12,
  ) {
    const n = items.length;
    this.count = n;
    this.mats = new Float32Array(n * 16);
    this.cols = items.some((i) => i.colour) ? new Float32Array(n * 3) : null;
    this.xs = new Float32Array(n);
    this.zs = new Float32Array(n);
    this.slotOf = new Int32Array(n).fill(-1);
    items.forEach((it, i) => {
      this.mats.set(it.matrix.elements, i * 16);
      if (this.cols && it.colour) {
        this.cols[i * 3] = it.colour.r;
        this.cols[i * 3 + 1] = it.colour.g;
        this.cols[i * 3 + 2] = it.colour.b;
      }
      this.xs[i] = it.x;
      this.zs[i] = it.z;
      const k = this.key(Math.floor(it.x / CELL), Math.floor(it.z / CELL));
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      c.push(i);
    });
    mesh.count = 0;
    mesh.frustumCulled = false;
  }

  private key(gx: number, gz: number): number {
    return (gx + 256) * 512 + gz + 256;
  }

  /** Replace an item's matrix (null hides it), e.g. a knocked-down lamp. */
  override(index: number, matrix: Float32Array | null | undefined): void {
    if (matrix === undefined) this.overrides.delete(index);
    else this.overrides.set(index, matrix);
    const slot = this.slotOf[index]!;
    if (slot >= 0) {
      const arr = this.mesh.instanceMatrix.array as Float32Array;
      const m = matrix === undefined ? this.mats.subarray(index * 16, index * 16 + 16) : (matrix ?? ZERO);
      arr.set(m, slot * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** The stored matrix of an item. */
  matrixOf(index: number): Float32Array {
    return this.mats.subarray(index * 16, index * 16 + 16);
  }

  /** Force the next update to rebuild. */
  invalidate(): void {
    this.dirty = true;
  }

  update(fx: number, fz: number): void {
    if (!this.dirty && Math.hypot(fx - this.lastX, fz - this.lastZ) < this.step) return;
    this.dirty = false;
    this.lastX = fx;
    this.lastZ = fz;
    const mesh = this.mesh;
    const arr = mesh.instanceMatrix.array as Float32Array;
    const carr = mesh.instanceColor ? (mesh.instanceColor.array as Float32Array) : null;
    this.slotOf.fill(-1);
    const r = this.radius;
    const r2 = r * r;
    let n = 0;
    const cap = mesh.instanceMatrix.count;
    const g0x = Math.floor((fx - r) / CELL);
    const g1x = Math.floor((fx + r) / CELL);
    const g0z = Math.floor((fz - r) / CELL);
    const g1z = Math.floor((fz + r) / CELL);
    for (let gx = g0x; gx <= g1x; gx++) {
      for (let gz = g0z; gz <= g1z; gz++) {
        const c = this.cells.get(this.key(gx, gz));
        if (!c) continue;
        for (const i of c) {
          const dx = this.xs[i]! - fx;
          const dz = this.zs[i]! - fz;
          if (dx * dx + dz * dz > r2 || n >= cap) continue;
          const o = this.overrides.get(i);
          arr.set(o === undefined ? this.mats.subarray(i * 16, i * 16 + 16) : (o ?? ZERO), n * 16);
          if (carr && this.cols) carr.set(this.cols.subarray(i * 3, i * 3 + 3), n * 3);
          this.slotOf[i] = n;
          n++;
        }
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, n * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  }
}

const ZERO = new Float32Array(16);
