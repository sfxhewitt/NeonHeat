import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedMesh,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
  type Scene,
  type Material,
} from 'three';
import type { MapContent } from '@neonheat/sim';
import { Palette } from './palette';

export interface CityMeshes {
  ground: Mesh;
  roads: Mesh;
  buildings: InstancedMesh;
}

/** Build the static block: ground, road grid and instanced box buildings. */
export function buildCity(scene: Scene, map: MapContent, roadMaterial?: Material): CityMeshes {
  const [sx, sz] = map.size;
  const ground = new Mesh(new PlaneGeometry(sx + 40, sz + 40), new MeshLambertMaterial({ color: Palette.ground }));
  ground.rotation.x = -Math.PI / 2;
  ground.name = 'ground';
  scene.add(ground);

  const roads = new Mesh(buildRoadGeometry(map), roadMaterial ?? new MeshLambertMaterial({ color: Palette.road }));
  roads.name = 'roads';
  roads.position.y = 0.02;
  scene.add(roads);

  const geo = new BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  // Darken the lower part of each building with vertex colours: cheap baked "AO".
  const pos = geo.getAttribute('position');
  const colours = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const shade = y > 0.99 ? 1.25 : 0.55 + 0.45 * y;
    colours[i * 3] = colours[i * 3 + 1] = colours[i * 3 + 2] = shade;
  }
  geo.setAttribute('color', new BufferAttribute(colours, 3));
  const mat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const buildings = new InstancedMesh(geo, mat, map.buildings.length);
  buildings.name = 'buildings';
  const o = new Object3D();
  const col = new Color();
  map.buildings.forEach((b, i) => {
    o.position.set(b.x, 0, b.z);
    o.scale.set(b.w, b.h, b.d);
    o.updateMatrix();
    buildings.setMatrixAt(i, o.matrix);
    // Slight per-building tint variation within the base palette.
    col.setHex(Palette.building).offsetHSL(((i * 37) % 11) / 300 - 0.015, 0, ((i * 53) % 7) / 200);
    buildings.setColorAt(i, col);
  });
  buildings.instanceMatrix.needsUpdate = true;
  scene.add(buildings);

  return { ground, roads, buildings };
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
