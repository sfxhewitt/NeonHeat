import {
  AdditiveBlending,
  Color,
  DataTexture,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type Material,
  type WebGLRenderer,
} from 'three';
import type { MapContent } from '@neonheat/sim';

/** Height map scale: texel value 1.0 = this many metres. */
const HEIGHT_SCALE = 64;
const MAX_LIGHTS = 640;

export interface LightFieldOptions {
  /** Light buffer resolution in texels (square). */
  size: number;
  /** World metres covered by the light buffer. */
  extent: number;
  /** Height-field ray-march steps per light texel; 0 = no shadows. */
  shadowSteps: number;
}

/**
 * Real-time lighting for a top-down city: every light (street lamps, neon
 * signs, headlights, police bars, muzzle flashes, fires, the drone's
 * searchlight) is splatted into a top-down HDR light buffer around the camera
 * each frame. Each light texel ray-marches the city height field towards its
 * light, so buildings cast real, soft-edged shadows from every light at once.
 * Materials then sample the buffer by world position: coloured spill on roads,
 * pavements, facades, cars and people, with gloss highlights on wet surfaces
 * and paint.
 *
 * The cost is one instanced draw into a small render target plus one texture
 * fetch per lit fragment, so it scales with the quality tier's buffer size and
 * step count, not with the number of lights.
 */
export class LightField {
  readonly uniforms: {
    uLfTex: { value: WebGLRenderTarget['texture'] | null };
    uLfOrigin: { value: Vector2 };
    uLfExtent: { value: number };
    uLfOn: { value: number };
  };
  /** Frame light count (static + dynamic), for stats and tests. */
  count = 0;
  private rt: WebGLRenderTarget | null = null;
  private readonly heightTex: DataTexture;
  private readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;
  private readonly geo: InstancedBufferGeometry;
  private readonly aPos: InstancedBufferAttribute;
  private readonly aCol: InstancedBufferAttribute;
  private readonly aDir: InstancedBufferAttribute;
  private readonly scene = new Scene();
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private staticCount = 0;
  private readonly c = new Color();
  private opts: LightFieldOptions = { size: 0, extent: 200, shadowSteps: 0 };

  constructor(map: MapContent) {
    this.heightTex = buildHeightTexture(map);
    this.uniforms = {
      uLfTex: { value: null },
      uLfOrigin: { value: new Vector2() },
      uLfExtent: { value: 200 },
      uLfOn: { value: 0 },
    };
    const quad = new PlaneGeometry(2, 2);
    this.geo = new InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.aPos = new InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4);
    this.aCol = new InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 3), 3);
    this.aDir = new InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * 4), 4);
    for (const a of [this.aPos, this.aCol, this.aDir]) a.setUsage(35048 /* DynamicDrawUsage */);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aCol', this.aCol);
    this.geo.setAttribute('aDir', this.aDir);
    this.geo.instanceCount = 0;
    const [mx, mz] = map.size;
    this.mat = new ShaderMaterial({
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      defines: { STEPS: 0 },
      uniforms: {
        uOrigin: this.uniforms.uLfOrigin,
        uExtent: this.uniforms.uLfExtent,
        uHeight: { value: this.heightTex },
        uMapSize: { value: new Vector2(mx + 40, mz + 40) },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aPos; // x, y (height), z, radius
        attribute vec3 aCol;
        attribute vec4 aDir; // dir x, dir z, cone cos, cone softness (cos <= -1: omni)
        uniform vec2 uOrigin;
        uniform float uExtent;
        varying vec2 vW;
        varying vec4 vPos;
        varying vec3 vCol;
        varying vec4 vDir;
        void main() {
          vec2 w = aPos.xz + position.xy * aPos.w;
          vW = w;
          vPos = aPos;
          vCol = aCol;
          vDir = aDir;
          gl_Position = vec4((w - uOrigin) / (uExtent * 0.5), 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uHeight;
        uniform vec2 uMapSize;
        varying vec2 vW;
        varying vec4 vPos;
        varying vec3 vCol;
        varying vec4 vDir;
        float bh(vec2 p) { return texture2D(uHeight, p / uMapSize + 0.5).r * ${HEIGHT_SCALE.toFixed(1)}; }
        void main() {
          vec2 d = vW - vPos.xz;
          float dist = length(d);
          float r = vPos.w;
          if (dist > r) discard;
          float x = dist / r;
          // Smooth windowed inverse-square: bright core, long soft tail, exactly 0 at r.
          float win = (1.0 - x * x);
          float att = win * win / (1.0 + dist * dist * 0.06);
          if (vDir.z > -1.0) {
            float ca = dot(d / max(dist, 1e-3), vDir.xy);
            att *= smoothstep(vDir.z, vDir.z + vDir.w, ca) * smoothstep(0.0, 1.2, dist) + 0.25 * smoothstep(2.5, 0.0, dist);
          }
          float sh = 1.0;
          #if STEPS > 0
          {
            // Ray-march the city height field from this texel (ground) to the light.
            float h0 = 0.4;
            for (int i = 1; i <= STEPS; i++) {
              float s = (float(i) - 0.5) / float(STEPS) * 0.92;
              vec2 p = vW - d * s;
              float rayH = mix(h0, vPos.y, s);
              float gap = rayH - bh(p);
              // Penumbra: how close the ray passes over an edge, relative to distance travelled.
              sh = min(sh, clamp(0.5 + gap * 4.0 / max(0.6, dist * s), 0.0, 1.0));
            }
            sh = sh * sh * (3.0 - 2.0 * sh);
          }
          #endif
          gl_FragColor = vec4(vCol * att * sh, 1.0);
        }`,
    });
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  get enabled(): boolean {
    return this.opts.size > 0;
  }

  /** Configure for a quality tier. size 0 turns the light field off. */
  configure(opts: LightFieldOptions): void {
    this.opts = opts;
    this.uniforms.uLfExtent.value = opts.extent;
    this.uniforms.uLfOn.value = opts.size > 0 ? 1 : 0;
    if (this.mat.defines.STEPS !== opts.shadowSteps) {
      this.mat.defines.STEPS = opts.shadowSteps;
      this.mat.needsUpdate = true;
    }
    if (opts.size <= 0) {
      this.rt?.dispose();
      this.rt = null;
      this.uniforms.uLfTex.value = null;
      return;
    }
    if (!this.rt) {
      this.rt = new WebGLRenderTarget(opts.size, opts.size, {
        type: HalfFloatType,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        depthBuffer: false,
      });
    } else this.rt.setSize(opts.size, opts.size);
    this.uniforms.uLfTex.value = this.rt.texture;
  }

  private write(i: number, x: number, y: number, z: number, radius: number, colour: number, intensity: number, dx: number, dz: number, cone: number, soft: number): void {
    const p = this.aPos.array as Float32Array;
    const c = this.aCol.array as Float32Array;
    const d = this.aDir.array as Float32Array;
    p[i * 4] = x;
    p[i * 4 + 1] = y;
    p[i * 4 + 2] = z;
    p[i * 4 + 3] = radius;
    this.c.setHex(colour);
    c[i * 3] = this.c.r * intensity;
    c[i * 3 + 1] = this.c.g * intensity;
    c[i * 3 + 2] = this.c.b * intensity;
    d[i * 4] = dx;
    d[i * 4 + 1] = dz;
    d[i * 4 + 2] = cone;
    d[i * 4 + 3] = soft;
  }

  /** Add a light that never moves (street lamps, signs). Call before the first frame. */
  addStatic(x: number, y: number, z: number, radius: number, colour: number, intensity: number): number {
    if (this.staticCount >= MAX_LIGHTS / 2) return -1;
    const slot = this.staticCount++;
    this.write(slot, x, y, z, radius, colour, intensity, 0, 0, -2, 0);
    this.staticCol.set((this.aCol.array as Float32Array).subarray(slot * 3, slot * 3 + 3), slot * 3);
    this.count = this.staticCount;
    return slot;
  }

  /** Switch a static light off (a smashed lamp or vending machine) or back on. */
  setStaticOn(slot: number, on: boolean): void {
    if (slot < 0 || slot >= this.staticCount) return;
    const c = this.aCol.array as Float32Array;
    for (let k = 0; k < 3; k++) c[slot * 3 + k] = on ? this.staticCol[slot * 3 + k]! : 0;
  }
  private readonly staticCol = new Float32Array((MAX_LIGHTS / 2) * 3);

  /** Start a frame's dynamic lights. */
  begin(): void {
    this.count = this.staticCount;
  }

  /** An omni light for this frame. */
  point(x: number, y: number, z: number, radius: number, colour: number, intensity: number): void {
    if (this.count >= MAX_LIGHTS) return;
    this.write(this.count++, x, y, z, radius, colour, intensity, 0, 0, -2, 0);
  }

  /** A cone light for this frame (headlights): dir is the unit ground direction, cone the cosine of the half-angle. */
  spot(x: number, y: number, z: number, radius: number, colour: number, intensity: number, dx: number, dz: number, cone: number, soft = 0.12): void {
    if (this.count >= MAX_LIGHTS) return;
    this.write(this.count++, x, y, z, radius, colour, intensity, dx, dz, cone, soft);
  }

  /** Render the buffer centred near (cx, cz). Snaps to the texel grid so lights do not shimmer. */
  render(renderer: WebGLRenderer, cx: number, cz: number): void {
    if (!this.rt) return;
    const texel = this.opts.extent / this.opts.size;
    this.uniforms.uLfOrigin.value.set(Math.round(cx / texel) * texel, Math.round(cz / texel) * texel);
    this.geo.instanceCount = this.count;
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aDir.needsUpdate = true;
    // Only upload what is used this frame.
    this.aPos.clearUpdateRanges();
    this.aCol.clearUpdateRanges();
    this.aDir.clearUpdateRanges();
    this.aPos.addUpdateRange(0, this.count * 4);
    this.aCol.addUpdateRange(0, this.count * 3);
    this.aDir.addUpdateRange(0, this.count * 4);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
  }

  /**
   * Make a built-in (Lambert) material receive the light field. `gloss` adds a
   * view-dependent sheen that picks up nearby light (wet paint, glass, puddles).
   */
  inject(mat: Material, opts: { gloss?: number } = {}): void {
    const gloss = opts.gloss ?? 0;
    const prev = mat.onBeforeCompile.bind(mat);
    const prevKey = mat.customProgramCacheKey();
    const u = this.uniforms;
    mat.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer);
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLfW;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          {
            vec4 lfw = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
              lfw = instanceMatrix * lfw;
            #endif
            #ifdef USE_BATCHING
              lfw = batchingMatrix * lfw;
            #endif
            vLfW = (modelMatrix * lfw).xyz;
          }`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vLfW;\n${LIGHT_FIELD_GLSL}`)
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          {
            vec3 lfN = inverseTransformDirection(normal, viewMatrix);
            vec3 lfL = lfSample(vLfW, lfN);
            reflectedLight.directDiffuse += diffuseColor.rgb * lfL;
            ${
              gloss > 0
                ? `{
              vec3 V = normalize(vLfW - cameraPosition);
              vec3 R = reflect(V, lfN);
              float fres = pow(1.0 - clamp(dot(-V, lfN), 0.0, 1.0), 3.0);
              vec3 env = lfSample(vLfW + vec3(R.x, 0.0, R.z) * 5.0, vec3(0.0, 1.0, 0.0));
              totalEmissiveRadiance += env * (${gloss.toFixed(3)} * (0.25 + fres));
            }`
                : ''
            }
          }`,
        );
    };
    mat.customProgramCacheKey = () => `${prevKey}|lf${gloss}`;
    mat.needsUpdate = true;
  }
}

/**
 * GLSL helper shared by every lit material: the light reaching a surface at
 * world position p with world normal n. Vertical faces sample just in front of
 * themselves; light fades with height above the street.
 */
export const LIGHT_FIELD_GLSL = /* glsl */ `
  uniform sampler2D uLfTex;
  uniform vec2 uLfOrigin;
  uniform float uLfExtent;
  uniform float uLfOn;
  vec3 lfSample(vec3 p, vec3 n) {
    if (uLfOn < 0.5) return vec3(0.0);
    vec2 uv = (p.xz + n.xz * 0.9 - uLfOrigin) / uLfExtent + 0.5;
    vec2 edge = smoothstep(0.0, 0.04, uv) * smoothstep(1.0, 0.96, uv);
    float fall = exp2(-max(0.0, p.y - 1.5) * 0.11);
    // Faces turned towards the street catch more than tops lit from the side.
    float facing = mix(1.0, 0.75, step(abs(n.y), 0.5));
    return texture2D(uLfTex, uv).rgb * edge.x * edge.y * fall * facing;
  }
`;

/** Building heights over the map, one byte per texel at about 0.5 m. */
function buildHeightTexture(map: MapContent): DataTexture {
  const [sx, sz] = map.size;
  const W = sx + 40;
  const D = sz + 40;
  const res = 2; // texels per metre
  const w = Math.ceil(W * res);
  const h = Math.ceil(D * res);
  const data = new Uint8Array(w * h);
  for (const b of map.buildings) {
    const x0 = Math.max(0, Math.floor((b.x - b.w / 2 + W / 2) * res));
    const x1 = Math.min(w - 1, Math.ceil((b.x + b.w / 2 + W / 2) * res) - 1);
    const z0 = Math.max(0, Math.floor((b.z - b.d / 2 + D / 2) * res));
    const z1 = Math.min(h - 1, Math.ceil((b.z + b.d / 2 + D / 2) * res) - 1);
    const v = Math.min(255, Math.round((b.h / HEIGHT_SCALE) * 255));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) data[z * w + x] = Math.max(data[z * w + x]!, v);
  }
  const tex = new DataTexture(data, w, h, RedFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
