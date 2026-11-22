import {
  AdditiveBlending,
  CylinderGeometry,
  DoubleSide,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RingGeometry,
  type Scene,
} from 'three';
import { BLOOM_LAYER } from './layers';

const MAX_GIVERS = 8;
const tmp = new Object3D();

/**
 * Mission markers: a cyan light beam over each job payphone (instanced) and an
 * acid-yellow ground ring plus beam on the current objective target.
 * Beams and rings are different shapes, so colour is never the only cue.
 */
export class MarkersView {
  private readonly givers: InstancedMesh;
  private readonly ring: Mesh;
  private readonly beam: Mesh;

  constructor(scene: Scene) {
    const beamGeo = new CylinderGeometry(0.6, 0.9, 30, 8, 1, true);
    beamGeo.translate(0, 15, 0);
    const giverMat = new MeshBasicMaterial({
      color: 0x2bf0ff,
      transparent: true,
      opacity: 0.35,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    this.givers = new InstancedMesh(beamGeo, giverMat, MAX_GIVERS);
    this.givers.count = 0;
    this.givers.frustumCulled = false;
    this.givers.name = 'giver-beams';
    this.givers.layers.enable(BLOOM_LAYER);
    scene.add(this.givers);

    const ringMat = new MeshBasicMaterial({ color: 0xe6ff2b, transparent: true, opacity: 0.8, depthWrite: false, side: DoubleSide });
    this.ring = new Mesh(new RingGeometry(0.85, 1, 40), ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.name = 'objective-ring';
    this.ring.visible = false;
    this.ring.layers.enable(BLOOM_LAYER);
    scene.add(this.ring);

    const beamMat = new MeshBasicMaterial({
      color: 0xe6ff2b,
      transparent: true,
      opacity: 0.22,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    this.beam = new Mesh(beamGeo, beamMat);
    this.beam.name = 'objective-beam';
    this.beam.visible = false;
    this.beam.layers.enable(BLOOM_LAYER);
    scene.add(this.beam);
  }

  setGivers(points: readonly { x: number; z: number }[]): void {
    const n = Math.min(MAX_GIVERS, points.length);
    for (let i = 0; i < n; i++) {
      tmp.position.set(points[i]!.x, 0, points[i]!.z);
      tmp.updateMatrix();
      this.givers.setMatrixAt(i, tmp.matrix);
    }
    this.givers.count = n;
    this.givers.instanceMatrix.needsUpdate = true;
  }

  /** Show the objective ring at a point (radius in metres), or hide it with null. */
  setTarget(x: number | null, z = 0, radius = 5, time = 0): void {
    if (x === null) {
      this.ring.visible = false;
      this.beam.visible = false;
      return;
    }
    const pulse = 1 + Math.sin(time * 4) * 0.06;
    this.ring.visible = true;
    this.ring.position.set(x, 0.08, z);
    this.ring.scale.setScalar(radius * pulse);
    this.beam.visible = true;
    this.beam.position.set(x, 0, z);
  }
}
