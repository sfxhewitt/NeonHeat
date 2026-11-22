import { Color, DataTexture, LinearFilter, RepeatWrapping, RGBAFormat, ShaderMaterial, UniformsLib, UniformsUtils, type Texture } from 'three';
import { Rng, type MapContent } from '@neonheat/sim';
import { Palette } from './palette';

/** Tileable value-noise texture for the scrolling normal (seeded, generated once). */
export function buildNoiseTexture(size = 64, seed = 3): DataTexture {
  const rng = new Rng(seed);
  const grid = 8;
  const g: number[][] = [];
  for (let c = 0; c < 4; c++) {
    const vals: number[] = [];
    for (let i = 0; i < grid * grid; i++) vals.push(rng.next());
    g.push(vals);
  }
  const data = new Uint8Array(size * size * 4);
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * grid;
      const fy = (y / size) * grid;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = smooth(fx - x0);
      const ty = smooth(fy - y0);
      for (let c = 0; c < 4; c++) {
        const v = (ix: number, iy: number): number => g[c]![((iy % grid) * grid + (ix % grid)) % (grid * grid)]!;
        const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * tx;
        const b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * tx;
        data[(y * size + x) * 4 + c] = Math.round((a + (b - a) * ty) * 255);
      }
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Wet asphalt: dark base, procedural lane markings, and a fake neon reflection
 * sampled from a tiny blurred texture, wobbled by a scrolling noise normal.
 * No planar reflections.
 */
export function createWetRoadMaterial(map: MapContent, reflection: Texture, noise: Texture): ShaderMaterial {
  const p = map.roads.positions;
  return new ShaderMaterial({
    fog: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uRefl: { value: reflection },
        uNoise: { value: noise },
        uTime: { value: 0 },
        uBase: { value: new Color(Palette.road) },
        uLine: { value: new Color(0x6c68b8) },
        uExtent: { value: map.size[0] },
        uRoads: { value: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0] },
        uHalfWidth: { value: map.roads.width / 2 },
        uWetness: { value: 1 },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vXZ;
      void main() {
        vXZ = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform sampler2D uRefl;
      uniform sampler2D uNoise;
      uniform float uTime;
      uniform vec3 uBase;
      uniform vec3 uLine;
      uniform float uExtent;
      uniform float uRoads[4];
      uniform float uHalfWidth;
      uniform float uWetness;
      varying vec2 vXZ;

      float markings(float across, float along) {
        float d = 1e5;
        float m = 0.0;
        for (int i = 0; i < 4; i++) {
          float o = abs(across - uRoads[i]);
          d = min(d, o);
        }
        // Dashed centre line and solid edge lines.
        float centre = step(d, 0.12) * step(0.5, fract(along / 6.0));
        float edge = step(abs(d - (uHalfWidth - 0.6)), 0.08);
        return max(centre, edge * 0.7);
      }

      void main() {
        vec2 n1 = texture2D(uNoise, vXZ * 0.045 + vec2(0.0, uTime * 0.03)).rg - 0.5;
        vec2 n2 = texture2D(uNoise, vXZ * 0.11 - vec2(uTime * 0.02, 0.0)).ba - 0.5;
        vec2 n = n1 + n2 * 0.6;
        // Reflections smear towards the camera (screen-down = +Z).
        vec2 ruv = (vXZ + vec2(0.0, 7.0)) / uExtent + 0.5 + n * 0.035;
        vec3 refl = texture2D(uRefl, ruv).rgb;
        refl += texture2D(uRefl, ruv + vec2(0.0, 0.025)).rgb * 0.5;
        float puddle = smoothstep(-0.1, 0.45, n1.x + 0.2);
        vec3 col = uBase * (0.85 + 0.3 * n.y);
        float lane = max(markings(vXZ.y, vXZ.x), markings(vXZ.x, vXZ.y));
        col = mix(col, uLine, lane * 0.8);
        col += refl * (0.22 + 0.5 * puddle) * uWetness;
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
  });
}
