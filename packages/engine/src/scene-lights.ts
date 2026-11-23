import { lerp, lerpAngle, type World } from '@neonheat/sim';
import type { LightField } from './lightfield';
import { Palette } from './palette';
import type { Sign } from './signage';

const FLASHES = 32;

/**
 * Feeds the light field: static street lamps and neon signs once, then each
 * frame every car's headlights and tail lights, police light bars, burning
 * wrecks, muzzle flashes and the drone's searchlight.
 */
export class SceneLights {
  private readonly fx = new Float32Array(FLASHES * 5); // x, z, life, max life, colour
  private nextFlash = 0;
  /** Every static light in the city (lamps first, then lit props, then signs), streamed into the field near the camera. */
  private readonly statics: { x: number; y: number; z: number; r: number; colour: number; i: number; on: boolean }[] = [];
  private readonly lampStatic: number[] = [];
  private readonly propStatic = new Map<number, number>();
  private lastX = Infinity;
  private lastZ = Infinity;

  /** A street lamp was knocked down or put back. */
  setLampOn(index: number, on: boolean): void {
    this.setStatic(this.lampStatic[index] ?? -1, on);
  }

  /** A lit prop (vending machine, kiosk) was smashed or put back. */
  setPropLightOn(propId: number, on: boolean): void {
    this.setStatic(this.propStatic.get(propId) ?? -1, on);
  }

  private setStatic(k: number, on: boolean): void {
    const s = this.statics[k];
    if (!s || s.on === on) return;
    s.on = on;
    this.lastX = Infinity; // re-stream on the next frame
  }

  constructor(
    private readonly field: LightField,
    lamps: { x: number; z: number; colour: number }[],
    signs: Sign[],
    extra: { x: number; z: number; colour: number; radius: number; propId: number }[] = [],
  ) {
    for (const l of lamps) {
      this.lampStatic.push(this.statics.length);
      this.statics.push({ x: l.x, y: 6.4, z: l.z, r: 12.5, colour: l.colour, i: 1.6, on: true });
    }
    for (const l of extra) {
      this.propStatic.set(l.propId, this.statics.length);
      this.statics.push({ x: l.x, y: 1.6, z: l.z, r: l.radius, colour: l.colour, i: 0.9, on: true });
    }
    for (const s of signs) {
      // Push the light off the facade so it is not inside its own building.
      const big = Math.max(s.w, s.h, s.d);
      const rad = Math.min(9, 3.5 + big * 0.7);
      // Signs high up a tower barely reach the street.
      if (s.y > 16) continue;
      this.statics.push({ x: s.x + s.nx * 1.2, y: Math.max(2.5, s.y - s.h / 2), z: s.z + s.nz * 1.2, r: rad, colour: s.colour, i: 0.75, on: true });
    }
  }

  /** Load the static lights around (x, z) into the field (only when the camera has moved a little). */
  private streamStatics(x: number, z: number): void {
    if (Math.hypot(x - this.lastX, z - this.lastZ) < 10) return;
    this.lastX = x;
    this.lastZ = z;
    const f = this.field;
    f.clearStatic();
    const r = f.extent * 0.75;
    // Nearest first, so the static budget is spent where the camera is.
    const near: { d: number; k: number }[] = [];
    this.statics.forEach((s, k) => {
      if (!s.on) return;
      const d = Math.max(Math.abs(s.x - x), Math.abs(s.z - z));
      if (d < r) near.push({ d, k });
    });
    near.sort((a, b) => a.d - b.d);
    for (const { k } of near) {
      const s = this.statics[k]!;
      if (f.addStatic(s.x, s.y, s.z, s.r, s.colour, s.i) < 0) break;
    }
  }

  /** A short bright flash (gunfire, sparks, explosions). */
  flash(x: number, z: number, colour: number, life = 0.07): void {
    const i = this.nextFlash;
    this.nextFlash = (i + 1) % FLASHES;
    this.fx[i * 5] = x;
    this.fx[i * 5 + 1] = z;
    this.fx[i * 5 + 2] = life;
    this.fx[i * 5 + 3] = life;
    this.fx[i * 5 + 4] = colour;
  }

  update(world: World, alpha: number, dt: number, focusX = world.player.x, focusZ = world.player.z): void {
    const f = this.field;
    if (!f.enabled) return;
    this.streamStatics(focusX, focusZ);
    f.begin();
    const t = world.time;
    const phase = Math.floor(t * 6) % 2 === 0;
    for (const v of world.vehicles) {
      if (!v.active) continue;
      const x = lerp(v.prevX, v.x, alpha);
      const z = lerp(v.prevZ, v.z, alpha);
      const yaw = lerpAngle(v.prevYaw, v.yaw, alpha);
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const hl = v.params.length / 2;
      if (v.destroyed) {
        // Burning wreck: flickering orange, dying down as the fire burns out or is put out.
        const burn = world.services.burnOf(v.id);
        if (burn <= 0.01) continue;
        const fl = 0.75 + 0.25 * Math.sin(t * 23 + v.id) * Math.sin(t * 7.3 + v.id * 2);
        f.point(x, 1.4, z, 5 + 4 * Math.sqrt(burn), 0xff7a2a, 1.4 * fl * Math.min(1, burn * 1.6));
        continue;
      }
      const police = v.role === 'police' || v.role === 'squad';
      f.spot(x + fx * (hl - 0.2), 0.8, z + fz * (hl - 0.2), 24, police ? 0xc8d6ff : 0xffe2b0, 2.2, fx, fz, 0.86, 0.1);
      const braking = v.controls.brake > 0.1 || v.controls.handbrake;
      f.point(x - fx * (hl + 0.6), 0.7, z - fz * (hl + 0.6), braking ? 4 : 2.6, 0xff1a30, braking ? 0.9 : 0.35);
      if (v.beacons && !police) {
        // Ambulance and fire tender beacons light the street red and blue-white.
        const side = phase ? 1 : -1;
        f.point(x + Math.cos(yaw) * 0.7 * side, 2.4, z - Math.sin(yaw) * 0.7 * side, 13, phase ? 0xff2a3a : 0xd8e4ff, 2.2);
      }
      if (police) {
        const squad = v.role === 'squad';
        const side = phase ? 1 : -1;
        const rx = Math.cos(yaw) * 0.6 * side;
        const rz = -Math.sin(yaw) * 0.6 * side;
        f.point(x + rx, 1.8, z + rz, 15, squad || phase ? Palette.policeRed : Palette.policeBlue, 2.6);
      }
    }
    // A soft personal light on the player on foot, so they always read against the street.
    const pc = world.playerCtl;
    if (pc.mode === 'foot' && !pc.dead) f.point(lerp(pc.prevX, pc.x, alpha), 3, lerp(pc.prevZ, pc.z, alpha), 7, 0xcfe0ff, 0.55);
    const d = world.police.drone;
    if (d.active) {
      const x = lerp(d.prevX, d.x, alpha);
      const z = lerp(d.prevZ, d.z, alpha);
      f.point(x, 12, z, 11, d.sees ? Palette.policeRed : 0xb8c8ff, d.sees ? 2.2 : 1.4);
    }
    for (let i = 0; i < FLASHES; i++) {
      const life = this.fx[i * 5 + 2]!;
      if (life <= 0) continue;
      const k = life / this.fx[i * 5 + 3]!;
      f.point(this.fx[i * 5]!, 1.2, this.fx[i * 5 + 1]!, 7 + 3 * k, this.fx[i * 5 + 4]!, 3.2 * k);
      this.fx[i * 5 + 2] = life - dt;
    }
  }
}
