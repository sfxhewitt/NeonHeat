import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  ShaderMaterial,
  Color,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
  type Scene,
  type Material,
  Vector2,
  Vector3,
} from 'three';
import type { MapContent } from '@neonheat/sim';
import { Palette } from './palette';
import { BLOOM_LAYER } from './layers';
import { MeshBuilder } from './mesh-kit';

export interface CityMeshes {
  ground: Mesh;
  roads: Mesh;
  pavements: Mesh;
  buildings: InstancedMesh;
  roofProps: InstancedMesh;
  lampPosts: InstancedMesh;
  lampHeads: InstancedMesh;
  lightPools: InstancedMesh;
  /** Volumetric light shafts under each street lamp (rain catching the light). */
  lampCones: InstancedMesh;
  /** Set to the player's world position each frame: buildings between it and the camera are cut away. */
  focus: Vector3;
  /** Drawing-buffer size in pixels. */
  viewport: Vector2;
  /** The player's position on screen (0..1, origin bottom left), for the see-through cutaway. */
  focusScreen: Vector2;
  /** Street lamp positions (for reflections and pools). */
  lamps: { x: number; z: number; colour: number }[];
}

const PAVEMENT = 5.5;
const KERB = 0.18;

/** Build the static block: ground, roads, pavements with kerbs, lit buildings, roof clutter and street lights. */
export function buildCity(scene: Scene, map: MapContent, roadMaterial?: Material): CityMeshes {
  const [sx, sz] = map.size;
  const ground = new Mesh(new PlaneGeometry(sx + 40, sz + 40), new MeshLambertMaterial({ color: 0x0e0f1e }));
  ground.rotation.x = -Math.PI / 2;
  ground.name = 'ground';
  scene.add(ground);

  const roads = new Mesh(buildRoadGeometry(map), roadMaterial ?? new MeshLambertMaterial({ color: Palette.road }));
  roads.renderOrder = -2;
  roads.name = 'roads';
  roads.position.y = 0.02;
  scene.add(roads);

  const pavementMat = new MeshLambertMaterial({ vertexColors: true });
  installPavingPattern(pavementMat);
  const pavements = new Mesh(buildPavementGeometry(map), pavementMat);
  pavements.name = 'pavements';
  scene.add(pavements);

  // Buildings: one instanced box, windows and shopfronts drawn by the shader.
  const geo = new BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const pos = geo.getAttribute('position');
  const colours = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const shade = y > 0.99 ? 0.75 : 0.62 + 0.38 * y;
    colours[i * 3] = colours[i * 3 + 1] = colours[i * 3 + 2] = shade;
  }
  geo.setAttribute('color', new BufferAttribute(colours, 3));
  const mat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const focus = new Vector3();
  const viewport = new Vector2(1, 1);
  const focusScreen = new Vector2(0.5, 0.5);
  installBuildingShader(mat, focus, viewport, focusScreen);
  // Tall buildings get a setback tier on top: drawn as extra instances.
  const parts: { x: number; z: number; w: number; d: number; y: number; h: number; seed: number; tint: number }[] = [];
  map.buildings.forEach((b, i) => {
    const tint = i;
    parts.push({ x: b.x, z: b.z, w: b.w, d: b.d, y: 0, h: b.h, seed: i, tint });
    if (b.h > 15 && b.w > 11 && b.d > 11) {
      const th = Math.round(b.h * (0.22 + ((i * 13) % 7) / 40));
      parts.push({ x: b.x + ((i % 3) - 1) * b.w * 0.08, z: b.z, w: b.w * 0.62, d: b.d * 0.62, y: b.h, h: th, seed: i + 500, tint });
    }
  });
  const buildings = new InstancedMesh(geo, mat, parts.length);
  buildings.name = 'buildings';
  const o = new Object3D();
  const col = new Color();
  const base = [0x2c2e58, 0x33305a, 0x272a4e, 0x3a3462, 0x2a3350];
  parts.forEach((p, i) => {
    o.position.set(p.x, p.y, p.z);
    o.scale.set(p.w, p.h, p.d);
    o.updateMatrix();
    buildings.setMatrixAt(i, o.matrix);
    col.setHex(base[p.tint % base.length]!).offsetHSL(((p.tint * 37) % 11) / 400, 0, ((p.tint * 53) % 7) / 260);
    buildings.setColorAt(i, col);
  });
  buildings.instanceMatrix.needsUpdate = true;
  scene.add(buildings);

  // Roof clutter: AC units, water tanks, antennas, stair housings.
  const roofItems: { x: number; y: number; z: number; w: number; h: number; d: number }[] = [];
  parts.forEach((p, i) => {
    if (i > 0 && parts[i - 1]!.seed + 500 === p.seed) return; // the base below has a setback
    const top = p.y + p.h;
    const n = 2 + (p.seed % 3);
    for (let k = 0; k < n; k++) {
      const hx = (((p.seed * 31 + k * 17) % 100) / 100 - 0.5) * (p.w - 3);
      const hz = (((p.seed * 47 + k * 29) % 100) / 100 - 0.5) * (p.d - 3);
      const kind = (p.seed + k) % 4;
      if (kind === 3) roofItems.push({ x: p.x + hx, y: top, z: p.z + hz, w: 0.18, h: 3 + (k % 3), d: 0.18 });
      else if (kind === 2) roofItems.push({ x: p.x + hx, y: top, z: p.z + hz, w: 2.4, h: 2.2, d: 2.4 });
      else roofItems.push({ x: p.x + hx, y: top, z: p.z + hz, w: 1.6, h: 0.9, d: 1.1 });
    }
  });
  const roofProps = new InstancedMesh(geo, new MeshLambertMaterial({ color: 0x3a3a5c, flatShading: true }), roofItems.length);
  roofItems.forEach((r, i) => {
    o.position.set(r.x, r.y, r.z);
    o.scale.set(r.w, r.h, r.d);
    o.updateMatrix();
    roofProps.setMatrixAt(i, o.matrix);
  });
  roofProps.name = 'roof-props';
  scene.add(roofProps);

  // Street lights along both sides of every road, clear of junctions.
  const lamps = layoutLamps(map);
  const post = new MeshBuilder()
    .box(0, 0.25, 0, 0.36, 0.5, 0.36, 0x2a2a3a)
    .box(0, 3.4, 0, 0.16, 6.4, 0.16, 0x3a3a50)
    .box(0, 6.55, 0.7, 0.14, 0.14, 1.6, 0x3a3a50)
    .build();
  const lampPosts = new InstancedMesh(post, new MeshLambertMaterial({ vertexColors: true, flatShading: true }), lamps.length);
  const lampHeads = new InstancedMesh(new BoxGeometry(0.5, 0.14, 0.9), new MeshBasicMaterial({ toneMapped: false }), lamps.length);
  const lightPools = new InstancedMesh(
    poolGeometry(),
    new MeshBasicMaterial({ map: radialTexture(), transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
    lamps.length,
  );
  lamps.forEach((l, i) => {
    o.position.set(l.x, 0, l.z);
    o.rotation.set(0, l.yaw, 0);
    o.scale.set(1, 1, 1);
    o.updateMatrix();
    lampPosts.setMatrixAt(i, o.matrix);
    o.position.set(l.x + Math.sin(l.yaw) * 1.3, 6.5, l.z + Math.cos(l.yaw) * 1.3);
    o.updateMatrix();
    lampHeads.setMatrixAt(i, o.matrix);
    lampHeads.setColorAt(i, col.setHex(l.colour).multiplyScalar(1.4));
    o.position.set(l.x + Math.sin(l.yaw) * 2.2, 0.06, l.z + Math.cos(l.yaw) * 2.2);
    o.scale.set(13, 1, 13);
    o.updateMatrix();
    lightPools.setMatrixAt(i, o.matrix);
    lightPools.setColorAt(i, col.setHex(l.colour).multiplyScalar(0.32));
  });
  lampHeads.layers.enable(BLOOM_LAYER);
  lightPools.layers.enable(BLOOM_LAYER);
  lightPools.renderOrder = -1;
  lampPosts.name = 'lamp-posts';
  lampHeads.name = 'lamp-heads';
  lightPools.name = 'light-pools';
  const lampCones = new InstancedMesh(coneGeometry(), coneMaterial(), lamps.length);
  lamps.forEach((l, i) => {
    o.position.set(l.x + Math.sin(l.yaw) * 1.3, 0, l.z + Math.cos(l.yaw) * 1.3);
    o.rotation.set(0, 0, 0);
    o.scale.set(1, 1, 1);
    o.updateMatrix();
    lampCones.setMatrixAt(i, o.matrix);
    lampCones.setColorAt(i, col.setHex(l.colour));
  });
  lampCones.name = 'lamp-cones';
  lampCones.renderOrder = 2;
  lampCones.visible = false;
  scene.add(lampPosts, lampHeads, lightPools, lampCones);

  return {
    ground,
    roads,
    pavements,
    buildings,
    roofProps,
    lampPosts,
    lampHeads,
    lightPools,
    lampCones,
    focus,
    viewport,
    focusScreen,
    lamps: lamps.map((l) => ({ x: l.x + Math.sin(l.yaw) * 1.3, z: l.z + Math.cos(l.yaw) * 1.3, colour: l.colour })),
  };
}

interface Lamp {
  x: number;
  z: number;
  yaw: number;
  colour: number;
}

/** Sodium-warm lamps with the odd cold-white one, every ~24 m along each kerb. */
export function layoutLamps(map: MapContent): Lamp[] {
  const { positions, width, extent } = map.roads;
  const out: Lamp[] = [];
  const near = (v: number): boolean => positions.some((p) => Math.abs(v - p) < width / 2 + PAVEMENT + 2);
  let k = 0;
  for (const p of positions) {
    for (let t = -extent + 10; t <= extent - 10; t += 24) {
      if (near(t)) continue;
      for (const side of [-1, 1]) {
        const off = p + side * (width / 2 + 0.9);
        const colour = k++ % 5 === 0 ? 0xbfe6ff : 0xffb766;
        // East-west road (z = p): lamps along x. North-south road (x = p): lamps along z.
        out.push({ x: t, z: off, yaw: side > 0 ? Math.PI : 0, colour });
        out.push({ x: off, z: t, yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2, colour });
      }
    }
  }
  return out;
}

/** Raised pavement slabs filling every block, with a pale kerb along the road edge. */
export function buildPavementGeometry(map: MapContent): BufferGeometry {
  const { positions, width } = map.roads;
  const [sx, sz] = map.size;
  const b = new MeshBuilder();
  const cuts = (half: number): [number, number][] => {
    const c = [-half, ...positions.flatMap((p) => [p - width / 2, p + width / 2]), half];
    const out: [number, number][] = [];
    for (let i = 0; i < c.length; i += 2) out.push([c[i]!, c[i + 1]!]);
    return out;
  };
  for (const [x0, x1] of cuts(sx / 2)) {
    for (const [z0, z1] of cuts(sz / 2)) {
      const w = x1 - x0;
      const d = z1 - z0;
      b.box((x0 + x1) / 2, KERB / 2, (z0 + z1) / 2, w, KERB, d, 0x24233a);
      // Kerb stones: a pale lip on each edge.
      b.box((x0 + x1) / 2, KERB / 2 + 0.005, z0 + 0.2, w, KERB + 0.01, 0.4, 0x5a5878);
      b.box((x0 + x1) / 2, KERB / 2 + 0.005, z1 - 0.2, w, KERB + 0.01, 0.4, 0x5a5878);
      b.box(x0 + 0.2, KERB / 2 + 0.005, (z0 + z1) / 2, 0.4, KERB + 0.01, d, 0x5a5878);
      b.box(x1 - 0.2, KERB / 2 + 0.005, (z0 + z1) / 2, 0.4, KERB + 0.01, d, 0x5a5878);
    }
  }
  return b.build();
}

/** One merged mesh for the whole road grid, with world-space UVs for the road shader. */
export function buildRoadGeometry(map: MapContent): BufferGeometry {
  const { positions, width, extent } = map.roads;
  const quads: [number, number, number, number][] = [];
  for (const p of positions) {
    quads.push([-extent, p - width / 2, extent, p + width / 2]); // east-west
    quads.push([p - width / 2, -extent, p + width / 2, extent]); // north-south
  }
  const verts: number[] = [];
  const uvs: number[] = [];
  for (const [x0, z0, x1, z1] of quads) {
    const v = [
      [x0, z0],
      [x0, z1],
      [x1, z1],
      [x0, z0],
      [x1, z1],
      [x1, z0],
    ];
    for (const [x, z] of v) {
      verts.push(x!, 0, z!);
      uvs.push(x!, z!);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.computeVertexNormals();
  return g;
}

/** An open cone from the lamp head (6.4 m) to a 3.4 m circle on the ground. */
function coneGeometry(): BufferGeometry {
  const sides = 14;
  const top = 6.35;
  const rTop = 0.25;
  const rBot = 3.4;
  const pos: number[] = [];
  const nrm: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const q = [
      [Math.cos(a0) * rTop, top, Math.sin(a0) * rTop],
      [Math.cos(a0) * rBot, 0, Math.sin(a0) * rBot],
      [Math.cos(a1) * rBot, 0, Math.sin(a1) * rBot],
      [Math.cos(a1) * rTop, top, Math.sin(a1) * rTop],
    ];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos.push(...q[k]!);
      const a = k === 0 || k === 1 ? a0 : a1;
      nrm.push(Math.cos(a), 0.45, Math.sin(a));
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  return g;
}

/**
 * Additive light shaft: brightest down the middle of its silhouette and near
 * the lamp, broken up by falling rain.
 */
function coneMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      varying float vH;
      varying vec3 vCol;
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vH = position.y / 6.35;
        vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vV = normalize(cameraPosition - w.xyz);
        vCol = instanceColor;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vN;
      varying vec3 vV;
      varying float vH;
      varying vec3 vCol;
      varying vec3 vW;
      float h1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
      void main() {
        float facing = abs(dot(normalize(vN), vV));
        float core = pow(facing, 2.5);
        float fade = smoothstep(0.0, 0.25, vH) * (0.35 + 0.65 * vH);
        // Falling streaks of rain in the beam.
        vec2 q = vec2(floor(vW.x * 6.0 + vW.z * 6.0), vW.y * 0.6 + uTime * 9.0);
        float streak = 0.75 + 0.5 * step(0.82, h1(vec2(q.x, floor(q.y + h1(vec2(q.x, 1.0)) * 4.0))));
        gl_FragColor = vec4(vCol * core * fade * streak * 0.085, 1.0);
      }`,
  });
}

function poolGeometry(): BufferGeometry {
  const g = new PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

let radial: CanvasTexture | null = null;
/** Soft radial falloff used for light pools on the ground. */
export function radialTexture(): CanvasTexture {
  if (radial) return radial;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  radial = new CanvasTexture(canvas);
  return radial;
}

/** Paving slabs: a faint grid of grout lines in world space. */
function installPavingPattern(mat: Material): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNhP;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvNhP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNhP;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec2 cell = floor(vNhP.xz / 1.8);
          vec2 g = abs(fract(vNhP.xz / 1.8) - 0.5);
          float grout = step(0.45, max(g.x, g.y));
          float tone = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
          diffuseColor.rgb *= (0.82 + 0.36 * tone) * (1.0 - grout * 0.45);
        }`,
      );
  };
}

/**
 * Building facades. Windows on a floor grid (some lit warm, some cold, some
 * dark glass), neon shopfront bands at street level, and two cutaways: the
 * part of a building between the camera and the player, and anything tall
 * drawn over the touch controls, are screen-door dithered away.
 */
function installBuildingShader(mat: Material, focus: Vector3, viewport: Vector2, focusScreen: Vector2, radius = 0.16): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFocus = { value: focus };
    shader.uniforms.uCutRadius = { value: radius };
    shader.uniforms.uFocusScreen = { value: focusScreen };
    shader.uniforms.uViewport = { value: viewport };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNhWorld;\nvarying vec3 vNhNormal;\nflat varying vec4 vNhBox;\nflat varying vec4 vNhCS;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 nhWorld = vec4(transformed, 1.0);
        vec3 nhN = normal;
        vNhBox = vec4(0.0, 0.0, 1.0, 1.0);
        vNhCS = vec4(0.0, 0.0, 1.0, 1.0);
        #ifdef USE_INSTANCING
          nhWorld = instanceMatrix * nhWorld;
          nhN = mat3(instanceMatrix) * normal;
          // seed from the instance position; base and height of this box
          vNhBox = vec4(instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.61, instanceMatrix[3].y, instanceMatrix[1].y, 0.0);
          vNhCS = vec4(instanceMatrix[3].x, instanceMatrix[3].z, instanceMatrix[0].x, instanceMatrix[2].z);
        #endif
        vNhWorld = (modelMatrix * nhWorld).xyz;
        vNhNormal = normalize(nhN);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vNhWorld;
        varying vec3 vNhNormal;
        flat varying vec4 vNhBox;
        flat varying vec4 vNhCS;
        uniform vec3 uFocus;
        uniform vec2 uFocusScreen;
        uniform float uCutRadius;
        uniform vec2 uViewport;
        float nhHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
      )
      .replace(
        'void main() {',
        `void main() {
        {
          // Cut a soft hole through anything standing between the camera and the player:
          // only near the player on screen, and only in front of them.
          vec2 sp = gl_FragCoord.xy / uViewport;
          vec2 dd = (sp - uFocusScreen) * vec2(uViewport.x / uViewport.y, 1.0);
          float r = length(dd) / uCutRadius;
          bool inFront = length(vNhWorld - cameraPosition) < length(uFocus - cameraPosition) - 1.5;
          if (inFront && vNhWorld.y > 1.2 && r < 1.0) {
            // 4x4 ordered dither: fully open in the middle, thinning out to the edge.
            vec2 q = mod(floor(gl_FragCoord.xy), 4.0);
            vec2 q2 = mod(q, 2.0);
            vec2 q1 = floor(q / 2.0);
            float bayer = (4.0 * mod(q2.x * 2.0 + q2.y * 3.0, 4.0) + mod(q1.x * 2.0 + q1.y * 3.0, 4.0)) / 16.0;
            float keep = smoothstep(0.55, 1.0, r);
            if (bayer + 0.03 > keep) discard;
          }
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 n = normalize(vNhNormal);
          if (n.y > 0.5) {
            // Roofs (what a top-down camera sees most): parapet lip, panel seams,
            // weathered patches, and a lit landing pad on the tallest towers.
            vec2 rel = vNhWorld.xz - vNhCS.xy;
            vec2 hs = vNhCS.zw * 0.5;
            float edge = min(hs.x - abs(rel.x), hs.y - abs(rel.y));
            float seed = vNhBox.x;
            vec2 cell = floor(rel / 3.2);
            vec2 g = abs(fract(rel / 3.2) - 0.5);
            float seam = step(0.46, max(g.x, g.y));
            float patchN = nhHash(cell + seed);
            float tone = 0.8 + 0.4 * nhHash(vec2(seed, 3.1));
            vec3 roof = mix(vec3(0.085, 0.085, 0.12), vec3(0.13, 0.12, 0.165), patchN) * tone;
            roof *= 1.0 - seam * 0.35;
            float lip = 1.0 - smoothstep(0.35, 0.5, edge);
            float lipShadow = smoothstep(0.5, 0.6, edge) * (1.0 - smoothstep(0.6, 1.3, edge));
            roof *= 1.0 - lipShadow * 0.35;
            roof = mix(roof, vec3(0.26, 0.25, 0.34), lip);
            diffuseColor.rgb = roof * 1.5;
            if (vNhBox.z > 27.0 && vNhBox.y < 0.5 && min(hs.x, hs.y) > 6.0) {
              float r = length(rel);
              float rad = min(hs.x, hs.y) * 0.62;
              float ring = step(abs(r - rad), 0.18);
              float hBar = step(abs(rel.x), rad * 0.35) * step(abs(rel.y), 0.22);
              float hPost = step(abs(abs(rel.x) - rad * 0.35), 0.22) * step(abs(rel.y), rad * 0.5);
              float blink = 0.6 + 0.4 * step(0.5, fract(seed * 7.3));
              totalEmissiveRadiance += vec3(1.0, 0.8, 0.3) * ring * 0.55 * blink;
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6, 0.6, 0.66), max(hBar, hPost));
            }
          } else if (abs(n.y) < 0.5) {
            vec2 tng = vec2(-n.z, n.x);
            float u = dot(vNhWorld.xz, tng);
            float y = vNhWorld.y;
            float seed = vNhBox.x;
            float topY = vNhBox.y + vNhBox.z;
            // Storefronts: a glowing band at street level on base boxes.
            if (vNhBox.y < 0.5 && y > 0.5 && y < 3.0) {
              float seg = floor(u / 7.0);
              float hs = nhHash(vec2(seg, seed));
              vec3 shop = hs < 0.33 ? vec3(1.0, 0.17, 0.84) : hs < 0.66 ? vec3(0.13, 0.94, 1.0) : vec3(1.0, 0.72, 0.35);
              float on = step(0.3, hs * 1.4 - 0.1);
              float frame = step(0.08, fract(u / 7.0)) * step(fract(u / 7.0), 0.92) * step(0.7, y) * step(y, 2.7);
              totalEmissiveRadiance += shop * on * frame * 0.55;
              diffuseColor.rgb *= 0.55;
            } else if (y > vNhBox.y + 3.4 && y < topY - 1.0) {
              vec2 cell = vec2(floor(u / 2.6), floor((y - 0.6) / 3.2));
              vec2 f = vec2(fract(u / 2.6), fract((y - 0.6) / 3.2));
              float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.3, f.y) * step(f.y, 0.82);
              float h = nhHash(cell + seed);
              float lit = step(0.58, h);
              vec3 warm = mix(vec3(1.0, 0.78, 0.48), vec3(1.0, 0.6, 0.85), step(0.9, h));
              vec3 cold = vec3(0.45, 0.8, 1.0);
              vec3 wc = mod(cell.x + cell.y * 3.0, 7.0) < 1.0 ? cold : warm;
              vec3 e = wc * win * lit * (0.55 + 0.45 * nhHash(cell.yx + seed));
              vec3 glass = mix(diffuseColor.rgb, vec3(0.09, 0.11, 0.22), win * (1.0 - lit));
              // Faces seen edge-on: the window grid is smaller than a pixel, so fade to its average instead of shimmering.
              float fw = max(fwidth(u) / 2.6, fwidth(y) / 3.2);
              float aa = smoothstep(0.25, 0.6, fw);
              totalEmissiveRadiance += mix(e, vec3(0.95, 0.75, 0.55) * 0.12, aa);
              diffuseColor.rgb = mix(glass, diffuseColor.rgb * 0.8, aa);
            }
          }
        }`,
      );
  };
}
