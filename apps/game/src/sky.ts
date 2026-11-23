import * as THREE from 'three';
import type { WeatherSystem } from '@neonheat/sim';
import type { Rain } from '@neonheat/engine';

/** One look of the sky: background, fog, ambient and key light. */
interface Grade {
  bg: THREE.Color;
  fog: THREE.Color;
  sky: THREE.Color;
  ground: THREE.Color;
  hemi: number;
  key: THREE.Color;
  keyI: number;
}

const grade = (bg: number, fog: number, sky: number, ground: number, hemi: number, key: number, keyI: number): Grade => ({
  bg: new THREE.Color(bg),
  fog: new THREE.Color(fog),
  sky: new THREE.Color(sky),
  ground: new THREE.Color(ground),
  hemi,
  key: new THREE.Color(key),
  keyI,
});

// Neon noir by night; an overcast steel-blue day; magenta-orange at dawn and dusk.
const NIGHT = grade(0x0b0d1a, 0x120f26, 0x7a74b0, 0x241228, 0.8, 0xc0b0ff, 0.85);
const DAY = grade(0x3c4462, 0x59618a, 0xb4bce0, 0x4a4458, 2.4, 0xe4e0ff, 1.6);
const GOLD = grade(0x4a2140, 0x5a2a48, 0xff9a86, 0x3a1a30, 1.1, 0xffa070, 1.1);
const FOG_TINT = new THREE.Color(0x8a90a8);
/** Night fog glows with the city's light. */
const FOG_NIGHT = new THREE.Color(0x3b3360);

/**
 * Grades the scene from the sim's clock and weather each frame: sky and fog
 * colour, fog distance, ambient and key light, rain amount, wet roads and the
 * odd lightning flash in a storm. No allocation per frame.
 */
export class SkyGrade {
  private readonly c = { bg: new THREE.Color(), fog: new THREE.Color(), sky: new THREE.Color(), ground: new THREE.Color(), key: new THREE.Color() };
  private flash = 0;
  private nextFlash = 8;

  apply(
    w: WeatherSystem,
    scene: THREE.Scene,
    hemi: THREE.HemisphereLight,
    key: THREE.DirectionalLight,
    rain: Rain,
    road: THREE.ShaderMaterial,
  ): void {
    const day = w.light;
    const gold = w.golden * (1 - w.fog * 0.6);
    const c = this.c;
    const mix = (out: THREE.Color, k: 'bg' | 'fog' | 'sky' | 'ground' | 'key'): THREE.Color =>
      out.copy(NIGHT[k]).lerp(DAY[k], day).lerp(GOLD[k], gold * 0.75);
    mix(c.bg, 'bg');
    mix(c.fog, 'fog');
    mix(c.sky, 'sky');
    mix(c.ground, 'ground');
    mix(c.key, 'key');
    // Fog and rain wash the colour out towards grey and pull the horizon in.
    const murk = Math.min(1, w.fog * 0.8 + w.rain * 0.25);
    c.fog.lerp(FOG_NIGHT, murk * (1 - day) * 0.8).lerp(FOG_TINT, murk * day * 0.5);
    c.bg.lerp(c.fog, murk * 0.7);
    if (scene.background instanceof THREE.Color) scene.background.copy(c.bg);
    const fog = scene.fog as THREE.Fog | null;
    if (fog) {
      fog.color.copy(c.fog);
      fog.near = 90 - 80 * w.fog;
      fog.far = 260 - 175 * w.fog - 30 * w.rain;
    }
    // Storm: a lightning flash every few seconds, decaying fast.
    const dt = 1 / 60;
    if (w.kind === 'storm' && w.rain > 0.7) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.flash = 1;
        // Pseudo-random from the clock: no RNG draw, so the sim stays deterministic.
        this.nextFlash = 5 + ((w.hour * 9973) % 1) * 11;
      }
    }
    this.flash = Math.max(0, this.flash - dt * 4);
    const f = this.flash * (0.6 + 0.4 * Math.sin(this.flash * 40));
    hemi.color.copy(c.sky);
    hemi.groundColor.copy(c.ground);
    hemi.intensity = NIGHT.hemi + (DAY.hemi - NIGHT.hemi) * day + f * 2.5;
    key.color.copy(c.key);
    key.intensity = (NIGHT.keyI + (DAY.keyI - NIGHT.keyI) * day) * (1 - w.fog * 0.3) + f * 2;
    rain.setAmount(w.rain);
    road.uniforms.uWetness!.value = 0.2 + 0.8 * w.wetness;
    (road.uniforms.uAmbient!.value as THREE.Color).copy(c.sky).multiplyScalar(day * 0.5 + gold * 0.15);
  }
}
