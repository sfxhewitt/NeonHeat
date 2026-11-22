import { BoxGeometry, CanvasTexture, Color, InstancedMesh, LinearFilter, MeshBasicMaterial, Object3D, type Scene } from 'three';
import { Rng, type MapContent } from '@neonheat/sim';
import { BLOOM_LAYER } from './layers';
import { NeonColours } from './palette';

export interface Sign {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  colour: number;
}

/**
 * Deterministically place emissive signage strips on building faces and
 * roof edges. The same list feeds the wet-road reflection texture.
 */
export function layoutSigns(map: MapContent, seed = 7): Sign[] {
  const rng = new Rng(seed);
  const signs: Sign[] = [];
  map.buildings.forEach((b, i) => {
    const colour = NeonColours[i % NeonColours.length]!;
    // Roof edge strip on the south face (the one the camera sees).
    signs.push({ x: b.x, y: b.h + 0.15, z: b.z + b.d / 2 - 0.2, w: b.w * 0.96, h: 0.3, d: 0.3, colour });
    // One or two vertical signs on faces.
    const n = rng.int(1, 2);
    for (let k = 0; k < n; k++) {
      const face = rng.int(0, 3);
      const c = NeonColours[(i + k + 1) % NeonColours.length]!;
      const hgt = Math.min(b.h * 0.6, rng.range(3, 7));
      const y = rng.range(2.5, Math.max(2.6, b.h - hgt - 1)) + hgt / 2;
      if (face === 0 || face === 1) {
        const z = face === 0 ? b.z + b.d / 2 + 0.15 : b.z - b.d / 2 - 0.15;
        const x = b.x + rng.range(-b.w / 2 + 1.5, b.w / 2 - 1.5);
        signs.push({ x, y, z, w: rng.chance(0.5) ? 1 : rng.range(3, 6), h: rng.chance(0.5) ? hgt : 0.9, d: 0.3, colour: c });
      } else {
        const x = face === 2 ? b.x + b.w / 2 + 0.15 : b.x - b.w / 2 - 0.15;
        const z = b.z + rng.range(-b.d / 2 + 1.5, b.d / 2 - 1.5);
        signs.push({ x, y, z, w: 0.3, h: hgt, d: rng.range(1, 4), colour: c });
      }
    }
  });
  return signs;
}

export function buildSignage(scene: Scene, signs: Sign[]): InstancedMesh {
  const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ toneMapped: false }), signs.length);
  const o = new Object3D();
  const c = new Color();
  signs.forEach((s, i) => {
    o.position.set(s.x, s.y, s.z);
    o.scale.set(s.w, s.h, s.d);
    o.updateMatrix();
    mesh.setMatrixAt(i, o.matrix);
    mesh.setColorAt(i, c.setHex(s.colour).multiplyScalar(1.6));
  });
  mesh.name = 'signage';
  mesh.layers.enable(BLOOM_LAYER);
  scene.add(mesh);
  return mesh;
}

/**
 * A tiny, blurred top-down map of where neon light falls, used by the wet-road
 * shader as a fake reflection. Painted once at load on a 2D canvas.
 */
export function buildReflectionTexture(map: MapContent, signs: Sign[], size = 128): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const extent = map.size[0];
  const toPx = (v: number): number => ((v + extent / 2) / extent) * size;
  ctx.globalCompositeOperation = 'lighter';
  for (const s of signs) {
    // Light pools along the sign's length, sized by its height above the street.
    const len = Math.max(s.w, s.d);
    const alongX = s.w >= s.d;
    const r = Math.max(1.5, ((4 + Math.min(s.y, 12) * 0.4) / extent) * size);
    const col = new Color(s.colour);
    const rgb = `${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)}`;
    const steps = Math.max(1, Math.round(len / 5));
    for (let k = 0; k < steps; k++) {
      const t = steps === 1 ? 0 : k / (steps - 1) - 0.5;
      const x = toPx(s.x + (alongX ? t * len : 0));
      const z = toPx(s.z + (alongX ? 0 : t * len));
      const g = ctx.createRadialGradient(x, z, 0, x, z, r);
      g.addColorStop(0, `rgba(${rgb},0.28)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, z - r, r * 2, r * 2);
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  return tex;
}
