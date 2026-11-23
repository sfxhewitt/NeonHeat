import { Color, DataTexture, Vector2, LinearFilter, RepeatWrapping, RGBAFormat, ShaderMaterial, UniformsLib, UniformsUtils, type Texture } from 'three';
import { Rng, type MapContent } from '@neonheat/sim';
import { Palette } from './palette';
import { LIGHT_FIELD_GLSL } from './lightfield';

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
 * Wet asphalt: dark base, procedural lane markings, zebra crossings and stop
 * lines at junctions, and a fake neon reflection sampled from a tiny blurred
 * texture, wobbled by a scrolling noise normal. With a light field, the road
 * also takes real-time coloured light and a wet sheen from every lamp, sign
 * and headlight. No planar reflections (screen-space reflections are a
 * separate post pass on the top tiers).
 */
export function createWetRoadMaterial(
  map: MapContent,
  reflection: Texture,
  noise: Texture,
  lightUniforms: Record<string, { value: unknown }> = {},
): ShaderMaterial {
  const p = map.roads.positions;
  return new ShaderMaterial({
    fog: true,
    uniforms: {
      ...UniformsUtils.merge([
        UniformsLib.fog,
        {
          uRefl: { value: reflection },
          uNoise: { value: noise },
          uTime: { value: 0 },
          uBase: { value: new Color(Palette.road) },
          uLine: { value: new Color(0x8a86c8) },
          uExtent: { value: map.size[0] },
          uRoads: { value: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0] },
          uHalfWidth: { value: map.roads.width / 2 },
          uWetness: { value: 1 },
          uFakeRefl: { value: 1 },
        },
      ]),
      // Shared by reference so the light field can update them every frame.
      uLfTex: lightUniforms.uLfTex ?? { value: null },
      uLfOrigin: lightUniforms.uLfOrigin ?? { value: new Vector2() },
      uLfExtent: lightUniforms.uLfExtent ?? { value: 1 },
      uLfOn: lightUniforms.uLfOn ?? { value: 0 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vXZ;
      varying vec3 vW;
      void main() {
        vXZ = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      ${LIGHT_FIELD_GLSL}
      uniform sampler2D uRefl;
      uniform sampler2D uNoise;
      uniform float uTime;
      uniform vec3 uBase;
      uniform vec3 uLine;
      uniform float uExtent;
      uniform float uRoads[4];
      uniform float uHalfWidth;
      uniform float uWetness;
      uniform float uFakeRefl;
      varying vec2 vXZ;
      varying vec3 vW;

      // Nearest road centre to v, and the distance to it.
      vec2 nearestRoad(float v) {
        float best = 1e5; float c = 0.0;
        for (int i = 0; i < 4; i++) {
          float o = abs(v - uRoads[i]);
          if (o < best) { best = o; c = uRoads[i]; }
        }
        return vec2(c, best);
      }

      // Markings on a road running along 'along', at offset 'across' from its centre line.
      float markings(float across, float along, float distToJunction) {
        if (distToJunction < uHalfWidth) return 0.0;
        float d = abs(across);
        float centre = step(d, 0.12) * step(0.5, fract(along / 6.0)) * step(uHalfWidth + 4.6, distToJunction);
        float edge = step(abs(d - (uHalfWidth - 0.6)), 0.08);
        // Zebra crossing just outside the junction, then a stop line on the approach side.
        float zj = distToJunction - uHalfWidth;
        float zebra = step(0.8, zj) * step(zj, 3.8) * step(0.5, fract(across / 1.1)) * step(d, uHalfWidth - 0.9);
        float stop = step(abs(zj - 4.4), 0.2) * step(d, uHalfWidth - 0.9);
        return max(max(centre, edge * 0.7), max(zebra * 0.85, stop * 0.9));
      }

      void main() {
        vec2 n1 = texture2D(uNoise, vXZ * 0.045 + vec2(0.0, uTime * 0.03)).rg - 0.5;
        vec2 n2 = texture2D(uNoise, vXZ * 0.11 - vec2(uTime * 0.02, 0.0)).ba - 0.5;
        vec2 n3 = texture2D(uNoise, vXZ * 0.6 + vec2(uTime * 0.4, -uTime * 0.3)).rg - 0.5;
        vec2 n = n1 + n2 * 0.6;
        // Reflections smear towards the camera (screen-down = +Z).
        vec2 ruv = (vXZ + vec2(0.0, 7.0)) / uExtent + 0.5 + n * 0.035;
        vec3 refl = texture2D(uRefl, ruv).rgb;
        refl += texture2D(uRefl, ruv + vec2(0.0, 0.025)).rgb * 0.5;
        float puddle = smoothstep(-0.1, 0.45, n1.x + 0.2);
        // Fine aggregate so the tarmac is not a flat colour.
        float grit = texture2D(uNoise, vXZ * 1.7).r;
        vec3 col = uBase * (0.8 + 0.3 * n.y + 0.18 * grit) * mix(1.0, 0.7, puddle);
        vec2 ew = nearestRoad(vXZ.y); // east-west road: centre z
        vec2 ns = nearestRoad(vXZ.x); // north-south road: centre x
        float lane = 0.0;
        if (ew.y < uHalfWidth) lane = max(lane, markings(vXZ.y - ew.x, vXZ.x, ns.y));
        if (ns.y < uHalfWidth) lane = max(lane, markings(vXZ.x - ns.x, vXZ.y, ew.y));
        // Worn paint: broken up by the noise.
        lane *= 0.65 + 0.35 * smoothstep(0.2, 0.6, grit);
        col = mix(col, uLine, lane * 0.75);
        col += refl * (0.22 + 0.5 * puddle) * uWetness * uFakeRefl;
        // Real-time light: diffuse spill plus a wet sheen that is strongest in puddles.
        vec3 L = lfSample(vW, vec3(0.0, 1.0, 0.0));
        col += col * L * 1.6;
        col += L * (0.05 + 0.22 * puddle + 0.05 * n3.x) * uWetness;
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
  });
}
