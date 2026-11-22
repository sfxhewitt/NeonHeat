import {
  Color,
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
 * Selective, half-resolution bloom. Only objects on BLOOM_LAYER glow; objects
 * on OCCLUDER_LAYER are drawn black in the bloom pass so glow does not leak
 * through buildings and cars. Off on the low tier (direct render to screen).
 */
export class PostFx {
  enabled = true;
  strength = 1.15;
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
      uniforms: { tScene: { value: null }, tBloom: { value: null }, uStrength: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene; uniform sampler2D tBloom; uniform float uStrength; varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * uStrength;
          // Soft vignette.
          vec2 d = vUv - 0.5;
          c *= 1.0 - dot(d, d) * 0.55;
          gl_FragColor = vec4(c, 1.0);
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
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }
}
