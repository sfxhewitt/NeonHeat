import {
  BoxGeometry,
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  RingGeometry,
  type Scene,
} from 'three';
import { lerp, type Drone } from '@neonheat/sim';
import { Palette } from './palette';

/** The surveillance drone and the ground circle that shows what it can see. */
export class DroneView {
  readonly group = new Group();
  readonly light: Mesh;
  readonly footprint: Mesh;
  private readonly footMat: MeshBasicMaterial;

  constructor(scene: Scene, sightRadius: number) {
    const body = new Mesh(new BoxGeometry(2.6, 0.7, 2.6), new MeshLambertMaterial({ color: 0x2b2d4a, flatShading: true }));
    const rotors = new Mesh(new RingGeometry(1.6, 2.3, 6), new MeshBasicMaterial({ color: 0x8890c0 }));
    rotors.rotation.x = -Math.PI / 2;
    rotors.position.y = 0.4;
    this.light = new Mesh(new BoxGeometry(0.8, 0.4, 0.8), new MeshBasicMaterial({ color: Palette.policeRed, toneMapped: false }));
    this.light.position.y = -0.5;
    this.group.add(body, rotors, this.light);
    this.group.visible = false;
    this.group.name = 'drone';
    scene.add(this.group);
    this.footMat = new MeshBasicMaterial({ color: Palette.policeRed, transparent: true, opacity: 0.12, depthWrite: false });
    this.footprint = new Mesh(new CircleGeometry(sightRadius, 40), this.footMat);
    this.footprint.rotation.x = -Math.PI / 2;
    this.footprint.position.y = 0.06;
    this.footprint.visible = false;
    this.footprint.name = 'drone-footprint';
    scene.add(this.footprint);
  }

  update(d: Drone, alpha: number, time: number): void {
    this.group.visible = d.active;
    this.footprint.visible = d.active && !d.leaving;
    if (!d.active) return;
    const x = lerp(d.prevX, d.x, alpha);
    const z = lerp(d.prevZ, d.z, alpha);
    this.group.position.set(x, d.y + Math.sin(time * 2) * 0.4, z);
    this.group.rotation.y = time * 0.6;
    const flash = Math.floor(time * 5) % 2 === 0;
    (this.light.material as MeshBasicMaterial).color.setHex(flash ? Palette.policeRed : Palette.policeBlue);
    this.footprint.position.x = x;
    this.footprint.position.z = z;
    this.footMat.color.setHex(d.sees ? Palette.policeRed : 0x8888aa);
    this.footMat.opacity = d.sees ? 0.14 + (flash ? 0.04 : 0) : 0.08;
  }
}
