import {
  AdditiveBlending,
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Scene,
} from 'three';
import { Rng } from '@neonheat/sim';
import { LIGHT_FIELD_GLSL } from './lightfield';

/**
 * Rain: one instanced streak mesh that follows the camera focus, plus one
 * instanced mesh of splash rings on the ground. All motion is in the vertex
 * shader, so the CPU cost per frame is two uniform updates.
 */
export class Rain {
  readonly streaks: Mesh;
  readonly splashes: Mesh;
  private readonly centre = new Vector3();
  private readonly streakMat: ShaderMaterial;
  private readonly splashMat: ShaderMaterial;

  constructor(scene: Scene, streakCount: number, splashCount: number, light: Record<string, { value: unknown }> = {}) {
    const lu = {
      uLfTex: light.uLfTex ?? { value: null },
      uLfOrigin: light.uLfOrigin ?? { value: new Vector2() },
      uLfExtent: light.uLfExtent ?? { value: 1 },
      uLfOn: light.uLfOn ?? { value: 0 },
    };
    const rng = new Rng(11);
    const box = new Vector3(150, 55, 130);

    const quad = new PlaneGeometry(0.06, 2.2);
    const g = new InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    const off = new Float32Array(streakCount * 4);
    for (let i = 0; i < streakCount; i++) {
      off[i * 4] = rng.next();
      off[i * 4 + 1] = rng.next();
      off[i * 4 + 2] = rng.next();
      off[i * 4 + 3] = 0.8 + rng.next() * 0.4;
    }
    g.setAttribute('aOffset', new InstancedBufferAttribute(off, 4));
    g.instanceCount = streakCount;
    this.streakMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { ...lu, uTime: { value: 0 }, uCentre: { value: this.centre }, uBox: { value: box }, uColour: { value: new Color(0x6f7fd8) } },
      vertexShader: /* glsl */ `
        attribute vec4 aOffset;
        uniform float uTime;
        uniform vec3 uCentre;
        uniform vec3 uBox;
        varying float vFade;
        varying vec3 vW;
        void main() {
          vec3 p = aOffset.xyz * uBox;
          p.y = mod(p.y - uTime * 38.0 * aOffset.w, uBox.y);
          vec2 rel = mod(p.xz - uCentre.xz + uBox.xz * 0.5, uBox.xz) - uBox.xz * 0.5;
          vec3 world = vec3(uCentre.x + rel.x, p.y, uCentre.z + rel.y);
          // Slight wind slant.
          world.x += position.y * 0.18;
          world += vec3(position.x, position.y, 0.0);
          vFade = smoothstep(0.0, 6.0, p.y) * (1.0 - smoothstep(uBox.y * 0.7, uBox.y, p.y));
          vW = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${LIGHT_FIELD_GLSL}
        uniform vec3 uColour;
        varying float vFade;
        varying vec3 vW;
        void main() {
          // Rain shows up where it falls through light: lamps, signs, headlights.
          vec3 L = lfSample(vec3(vW.x, min(vW.y, 6.0), vW.z), vec3(0.0, 1.0, 0.0)) * smoothstep(9.0, 2.0, vW.y);
          gl_FragColor = vec4((uColour * mix(0.55, 0.3, uLfOn) + L * 0.9) * vFade, 1.0);
        }`,
    });
    this.streaks = new Mesh(g, this.streakMat);
    this.streaks.frustumCulled = false;
    this.streaks.name = 'rain';
    scene.add(this.streaks);

    const ring = new PlaneGeometry(1, 1);
    ring.rotateX(-Math.PI / 2);
    const sg = new InstancedBufferGeometry();
    sg.index = ring.index;
    sg.setAttribute('position', ring.getAttribute('position'));
    sg.setAttribute('uv', ring.getAttribute('uv'));
    const soff = new Float32Array(splashCount * 3);
    for (let i = 0; i < splashCount; i++) {
      soff[i * 3] = rng.next();
      soff[i * 3 + 1] = rng.next();
      soff[i * 3 + 2] = rng.next();
    }
    sg.setAttribute('aOffset', new InstancedBufferAttribute(soff, 3));
    sg.instanceCount = splashCount;
    this.splashMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { ...lu, uTime: { value: 0 }, uCentre: { value: this.centre }, uArea: { value: 90 } },
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        uniform float uTime;
        uniform vec3 uCentre;
        uniform float uArea;
        varying vec2 vUv;
        varying float vLife;
        varying vec3 vW;
        float hash(float n) { return fract(sin(n) * 43758.5453); }
        void main() {
          float t = uTime * 1.7 + aOffset.z * 10.0;
          float cycle = floor(t);
          vLife = fract(t);
          vec2 rnd = vec2(hash(cycle + aOffset.x * 91.0), hash(cycle * 1.3 + aOffset.y * 57.0));
          vec2 xz = uCentre.xz + (rnd - 0.5) * uArea;
          float s = 0.2 + vLife * 0.9;
          vec3 world = vec3(xz.x + position.x * s, 0.07, xz.y + position.z * s);
          vUv = uv;
          vW = world;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${LIGHT_FIELD_GLSL}
        varying vec2 vUv;
        varying float vLife;
        varying vec3 vW;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float ring = smoothstep(0.12, 0.0, abs(d - 0.8)) * (1.0 - vLife);
          vec3 L = lfSample(vW, vec3(0.0, 1.0, 0.0));
          gl_FragColor = vec4((vec3(0.45, 0.5, 0.85) * 0.7 + L * 1.4) * ring, 1.0);
        }`,
    });
    this.splashes = new Mesh(sg, this.splashMat);
    this.splashes.frustumCulled = false;
    this.splashes.name = 'splashes';
    scene.add(this.splashes);
  }

  /** Quality tiers draw fewer instances of the same buffers. */
  setCounts(streaks: number, splashes: number): void {
    const sg = this.streaks.geometry as InstancedBufferGeometry;
    const pg = this.splashes.geometry as InstancedBufferGeometry;
    sg.instanceCount = Math.min(streaks, (sg.getAttribute('aOffset') as InstancedBufferAttribute).count);
    pg.instanceCount = Math.min(splashes, (pg.getAttribute('aOffset') as InstancedBufferAttribute).count);
  }

  set visible(v: boolean) {
    this.streaks.visible = v;
    this.splashes.visible = v;
  }

  update(time: number, focusX: number, focusZ: number): void {
    this.centre.set(focusX, 0, focusZ);
    this.streakMat.uniforms.uTime!.value = time;
    this.splashMat.uniforms.uTime!.value = time;
  }
}
