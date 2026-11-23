import {
  AdditiveBlending,
  Color,
  DepthTexture,
  Matrix4,
  type PerspectiveCamera,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { BLOOM_LAYER, OCCLUDER_LAYER } from './layers';

/**
 * Post-processing: selective, half-resolution bloom, optional screen-space
 * reflections on the wet ground, and a gentle filmic HDR tone map and grade.
 *
 * Selective, half-resolution bloom. Only objects on BLOOM_LAYER glow; objects
 * on OCCLUDER_LAYER are drawn black in the bloom pass so glow does not leak
 * through buildings and cars. Off on the low tier (direct render to screen).
 */
export class PostFx {
  enabled = true;
  strength = 1.15;
  /** Screen-space reflections on the wet street (top tiers). */
  ssr = false;
  ssrStrength = 0.85;
  /** Exposure before the tone map. */
  exposure = 1.0;
  /** Scene light above this luminance also blooms (headlight hot spots, flashes). */
  threshold = 1.15;
  private ssrA: WebGLRenderTarget;
  private ssrB: WebGLRenderTarget;
  private readonly ssrMat: ShaderMaterial;
  private readonly brightMat: ShaderMaterial;
  private time = 0;
  private sceneRT: WebGLRenderTarget;
  private bloomA: WebGLRenderTarget;
  private bloomB: WebGLRenderTarget;
  private readonly quadScene = new Scene();
  private readonly quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: Mesh;
  private readonly blurMat: ShaderMaterial;
  private readonly compositeMat: ShaderMaterial;
  private readonly black = new MeshBasicMaterial({ color: 0x000000 });
  private readonly occluders: Mesh[] = [];
  private readonly saved: Material[] = [];
  private readonly clear = new Color();

  constructor(private readonly renderer: WebGLRenderer) {
    const opts = { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: true };
    this.sceneRT = new WebGLRenderTarget(1, 1, opts);
    this.sceneRT.depthTexture = new DepthTexture(1, 1);
    this.ssrA = new WebGLRenderTarget(1, 1, { ...opts, depthBuffer: false });
    this.ssrB = new WebGLRenderTarget(1, 1, { ...opts, depthBuffer: false });
    this.ssrMat = new ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tDepth: { value: null },
        uProj: { value: new Matrix4() },
        uInvProj: { value: new Matrix4() },
        uView: { value: new Matrix4() },
        uInvView: { value: new Matrix4() },
        uNear: { value: 1 },
        uFar: { value: 100 },
        uTime: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: SSR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.brightMat = new ShaderMaterial({
      uniforms: { tScene: { value: null }, uThreshold: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene; uniform float uThreshold; varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tScene, vUv).rgb;
          float l = max(c.r, max(c.g, c.b));
          gl_FragColor = vec4(c * (max(0.0, l - uThreshold) / max(l, 1e-4)) * 0.6, 1.0);
        }`,
      blending: AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.bloomA = new WebGLRenderTarget(1, 1, { ...opts, depthBuffer: true });
    this.bloomB = new WebGLRenderTarget(1, 1, { ...opts, depthBuffer: false });
    this.blurMat = new ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new Vector2() } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb * 0.227027;
          c += texture2D(tDiffuse, vUv + uDir * 1.3846).rgb * 0.316216;
          c += texture2D(tDiffuse, vUv - uDir * 1.3846).rgb * 0.316216;
          c += texture2D(tDiffuse, vUv + uDir * 3.2308).rgb * 0.070270;
          c += texture2D(tDiffuse, vUv - uDir * 3.2308).rgb * 0.070270;
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMat = new ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        tSsr: { value: null },
        uStrength: { value: 1 },
        uSsr: { value: 0 },
        uExposure: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tSsr;
        uniform float uStrength; uniform float uSsr; uniform float uExposure; uniform float uTime;
        varying vec2 vUv;
        float grain(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          vec3 c = texture2D(tScene, vUv).rgb;
          if (uSsr > 0.0) c += texture2D(tSsr, vUv).rgb * uSsr;
          c += texture2D(tBloom, vUv).rgb * uStrength;
          c *= uExposure;
          // Filmic shoulder: linear up to 0.75, then rolls off smoothly so HDR light never clips hard.
          vec3 over = max(c - 0.75, 0.0);
          c = min(c, 0.75) + over / (1.0 + over * 1.6);
          // Grade: cool the shadows, keep neon saturated.
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c += vec3(-0.004, 0.0, 0.012) * (1.0 - smoothstep(0.0, 0.25, l));
          // Soft vignette.
          vec2 d = vUv - 0.5;
          c *= 1.0 - dot(d, d) * 0.55;
          // Fine grain hides banding in the dark gradients.
          c += (grain(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.012;
          gl_FragColor = vec4(max(c, 0.0), 1.0);
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.compositeMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Register a mesh as a bloom occluder (it is drawn black in the bloom pass). */
  addOccluder(...meshes: Object3D[]): void {
    for (const m of meshes) {
      m.layers.enable(OCCLUDER_LAYER);
      if ((m as Mesh).isMesh) this.occluders.push(m as Mesh);
    }
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    this.sceneRT.setSize(w, h);
    this.ssrA.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.ssrB.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.bloomA.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.bloomB.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  }

  render(scene: Scene, camera: Camera): void {
    const r = this.renderer;
    if (!this.enabled) {
      r.setRenderTarget(null);
      r.render(scene, camera);
      return;
    }
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);
    this.time += 1 / 60;

    // Bloom pass: emissive layer only, occluders in black, no background.
    const bg = scene.background;
    const fog = scene.fog;
    scene.background = null;
    scene.fog = null;
    r.getClearColor(this.clear);
    const clearAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 1);
    for (let i = 0; i < this.occluders.length; i++) {
      const m = this.occluders[i]!;
      this.saved[i] = m.material as Material;
      m.material = this.black;
    }
    camera.layers.set(BLOOM_LAYER);
    camera.layers.enable(OCCLUDER_LAYER);
    r.setRenderTarget(this.bloomA);
    r.clear();
    r.render(scene, camera);
    camera.layers.set(0);
    for (let i = 0; i < this.occluders.length; i++) this.occluders[i]!.material = this.saved[i]!;
    scene.background = bg;
    scene.fog = fog;
    r.setClearColor(this.clear, clearAlpha);
    // Over-bright scene light joins the bloom (additive into the emissive buffer).
    this.quad.material = this.brightMat;
    this.brightMat.uniforms.tScene!.value = this.sceneRT.texture;
    this.brightMat.uniforms.uThreshold!.value = this.threshold;
    r.autoClear = false;
    r.render(this.quadScene, this.quadCam);
    r.autoClear = true;

    if (this.ssr) this.renderSsr(camera as PerspectiveCamera);

    // Separable blur, two iterations.
    const w = this.bloomA.width;
    const h = this.bloomA.height;
    this.quad.material = this.blurMat;
    for (let it = 0; it < 2; it++) {
      const spread = it + 1;
      this.blurMat.uniforms.tDiffuse!.value = this.bloomA.texture;
      (this.blurMat.uniforms.uDir!.value as Vector2).set(spread / w, 0);
      r.setRenderTarget(this.bloomB);
      r.render(this.quadScene, this.quadCam);
      this.blurMat.uniforms.tDiffuse!.value = this.bloomB.texture;
      (this.blurMat.uniforms.uDir!.value as Vector2).set(0, spread / h);
      r.setRenderTarget(this.bloomA);
      r.render(this.quadScene, this.quadCam);
    }

    this.quad.material = this.compositeMat;
    this.compositeMat.uniforms.tScene!.value = this.sceneRT.texture;
    this.compositeMat.uniforms.tBloom!.value = this.bloomA.texture;
    this.compositeMat.uniforms.uStrength!.value = this.strength;
    this.compositeMat.uniforms.tSsr!.value = this.ssrA.texture;
    this.compositeMat.uniforms.uSsr!.value = this.ssr ? this.ssrStrength : 0;
    this.compositeMat.uniforms.uExposure!.value = this.exposure;
    this.compositeMat.uniforms.uTime!.value = this.time;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }

  /** Trace reflections of the scene in the wet ground at half resolution, then streak-blur them. */
  private renderSsr(camera: PerspectiveCamera): void {
    const r = this.renderer;
    const u = this.ssrMat.uniforms;
    u.tScene!.value = this.sceneRT.texture;
    u.tDepth!.value = this.sceneRT.depthTexture;
    (u.uProj!.value as Matrix4).copy(camera.projectionMatrix);
    (u.uInvProj!.value as Matrix4).copy(camera.projectionMatrixInverse);
    (u.uView!.value as Matrix4).copy(camera.matrixWorldInverse);
    (u.uInvView!.value as Matrix4).copy(camera.matrixWorld);
    u.uNear!.value = camera.near;
    u.uFar!.value = camera.far;
    u.uTime!.value = this.time;
    this.quad.material = this.ssrMat;
    r.setRenderTarget(this.ssrA);
    r.render(this.quadScene, this.quadCam);
    // Wet streaks: long vertical blur, short horizontal.
    const w = this.ssrA.width;
    const h = this.ssrA.height;
    this.quad.material = this.blurMat;
    this.blurMat.uniforms.tDiffuse!.value = this.ssrA.texture;
    (this.blurMat.uniforms.uDir!.value as Vector2).set(0, 1.3 / h);
    r.setRenderTarget(this.ssrB);
    r.render(this.quadScene, this.quadCam);
    this.blurMat.uniforms.tDiffuse!.value = this.ssrB.texture;
    (this.blurMat.uniforms.uDir!.value as Vector2).set(0.6 / w, 0);
    r.setRenderTarget(this.ssrA);
    r.render(this.quadScene, this.quadCam);
  }
}

/**
 * Screen-space reflections for a flat wet street: for each ground pixel,
 * reflect the view ray off the (rippled) ground plane and march it through the
 * depth buffer until it passes behind something on screen, then refine the
 * hit with a short binary search. Facades, signs, lamps, headlights and police
 * lights all reflect, with distance and screen-edge fades where the ray has no
 * data.
 */
const SSR_FRAG = /* glsl */ `
  #include <packing>
  uniform sampler2D tScene;
  uniform sampler2D tDepth;
  uniform mat4 uProj;
  uniform mat4 uInvProj;
  uniform mat4 uView;
  uniform mat4 uInvView;
  uniform float uNear;
  uniform float uFar;
  uniform float uTime;
  varying vec2 vUv;

  float viewZAt(vec2 uv) {
    return perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar);
  }
  vec3 viewPosAt(vec2 uv, float depth) {
    vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
  }
  vec2 project(vec3 v) {
    vec4 c = uProj * vec4(v, 1.0);
    return c.xy / c.w * 0.5 + 0.5;
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }

  void main() {
    float depth = texture2D(tDepth, vUv).x;
    if (depth >= 0.9999) { gl_FragColor = vec4(0.0); return; }
    vec3 vp = viewPosAt(vUv, depth);
    vec3 wp = (uInvView * vec4(vp, 1.0)).xyz;
    if (wp.y > 0.3) { gl_FragColor = vec4(0.0); return; }
    // Road (y ~ 0) is a mirror-ish puddle; pavement (kerb top) is rougher and dimmer.
    float onRoad = 1.0 - smoothstep(0.06, 0.14, wp.y);
    float puddle = smoothstep(0.35, 0.7, vnoise(wp.xz * 0.12));
    float strength = mix(0.1, 0.55 + 0.45 * puddle, onRoad);
    // Rain ripples perturb the normal.
    vec2 rip = vec2(vnoise(wp.xz * 2.3 + uTime * 1.7), vnoise(wp.zx * 2.1 - uTime * 1.3)) - 0.5;
    float rough = mix(0.09, mix(0.05, 0.015, puddle), onRoad);
    vec3 nW = normalize(vec3(rip.x * rough * 2.0, 1.0, rip.y * rough * 2.0));
    vec3 camW = (uInvView * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vec3 rW = reflect(normalize(wp - camW), nW);
    vec3 rV = normalize((uView * vec4(rW, 0.0)).xyz);
    float jitter = hash(gl_FragCoord.xy + fract(uTime * 7.0));
    float t = 0.4 + jitter * 0.5;
    float stepLen = 0.6;
    vec3 hitCol = vec3(0.0);
    float hit = 0.0;
    vec3 prev = vp;
    for (int i = 0; i < 28; i++) {
      vec3 p = vp + rV * t;
      vec2 uv = project(p);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
      float sz = viewZAt(uv);
      float diff = sz - p.z; // > 0: the ray is behind the visible surface
      if (diff > 0.0 && diff < 1.2 + t * 0.12) {
        // Refine between the last two samples.
        vec3 a = prev; vec3 b = p;
        for (int k = 0; k < 4; k++) {
          vec3 m = (a + b) * 0.5;
          vec2 muv = project(m);
          if (viewZAt(muv) - m.z > 0.0) b = m; else a = m;
        }
        vec2 huv = project(b);
        vec2 e = smoothstep(0.0, 0.08, huv) * smoothstep(1.0, 0.92, huv);
        hit = e.x * e.y * (1.0 - smoothstep(30.0, 70.0, t));
        hitCol = texture2D(tScene, huv).rgb;
        break;
      }
      prev = p;
      t += stepLen;
      stepLen *= 1.16;
    }
    gl_FragColor = vec4(hitCol * hit * strength, 1.0);
  }
`;
