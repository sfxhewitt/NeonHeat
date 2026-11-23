import { PerspectiveCamera } from 'three';
import { z } from 'zod';

export const CameraConfigSchema = z.object({
  pitchDeg: z.number().min(55).max(65),
  fovDeg: z.number().min(25).max(40),
  heightMin: z.number().positive(),
  heightMax: z.number().positive(),
  heightOnFoot: z.number().positive(),
  heightLerp: z.number().positive(),
  lookAheadSec: z.number().nonnegative(),
  lookAheadMax: z.number().nonnegative(),
  lookAheadLerp: z.number().positive(),
  followLerp: z.number().positive(),
});
export type CameraConfig = z.infer<typeof CameraConfigSchema>;

export interface CameraTarget {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Speed as a fraction of top speed, 0..1. */
  speedT: number;
  onFoot: boolean;
}

/**
 * Pitched top-down follow camera with a fixed yaw (north up). Height lerps with
 * speed and the focus point leads the target in its direction of travel.
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  private height: number;
  private lookX = 0;
  private lookZ = 0;
  private focusX = 0;
  private focusZ = 0;
  private shake = 0;
  private shakeTime = 0;
  shakeFrequency = 28;
  shakeDecay = 7;
  shakeMax = 1.4;
  /** Multiplies the target height (a big jump pulls the camera in); eased like the height itself. */
  heightScale = 1;

  constructor(public config: CameraConfig) {
    this.camera = new PerspectiveCamera(config.fovDeg, 16 / 9, 2, 600);
    this.height = config.heightMin;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  snap(t: CameraTarget): void {
    this.focusX = t.x;
    this.focusZ = t.z;
    this.lookX = this.lookZ = 0;
    this.height = t.onFoot ? this.config.heightOnFoot : this.config.heightMin;
  }

  addShake(amount: number): void {
    this.shake = Math.min(this.shakeMax, this.shake + amount);
  }

  update(t: CameraTarget, dt: number): void {
    const c = this.config;
    if (this.camera.fov !== c.fovDeg) {
      this.camera.fov = c.fovDeg;
      this.camera.updateProjectionMatrix();
    }
    const k = (rate: number): number => 1 - Math.exp(-rate * dt);
    const targetH = t.onFoot ? c.heightOnFoot : c.heightMin + (c.heightMax - c.heightMin) * Math.min(1, t.speedT);
    this.height += (targetH * this.heightScale - this.height) * k(c.heightLerp);

    let ax = t.vx * c.lookAheadSec;
    let az = t.vz * c.lookAheadSec;
    const len = Math.hypot(ax, az);
    if (len > c.lookAheadMax) {
      ax *= c.lookAheadMax / len;
      az *= c.lookAheadMax / len;
    }
    this.lookX += (ax - this.lookX) * k(c.lookAheadLerp);
    this.lookZ += (az - this.lookZ) * k(c.lookAheadLerp);
    this.focusX += (t.x - this.focusX) * k(c.followLerp);
    this.focusZ += (t.z - this.focusZ) * k(c.followLerp);

    const fx = this.focusX + this.lookX;
    const fz = this.focusZ + this.lookZ;
    const pitch = (c.pitchDeg * Math.PI) / 180;
    const back = this.height / Math.tan(pitch);

    this.shakeTime += dt;
    this.shake *= Math.exp(-this.shakeDecay * dt);
    const sx = this.shake * Math.sin(this.shakeTime * this.shakeFrequency * 1.13);
    const sz = this.shake * Math.cos(this.shakeTime * this.shakeFrequency * 0.91);

    this.camera.position.set(fx + sx, this.height, fz + back + sz);
    this.camera.lookAt(fx + sx, 0, fz + sz);
  }

  /** Current ground focus point (where the camera looks). */
  get focus(): { x: number; z: number } {
    return { x: this.focusX + this.lookX, z: this.focusZ + this.lookZ };
  }
}
