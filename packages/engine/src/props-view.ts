import { Color, InstancedMesh, MeshBasicMaterial, MeshLambertMaterial, Object3D, type BufferGeometry, type Scene } from 'three';
import type { Prop } from '@neonheat/sim';
import { BLOOM_LAYER } from './layers';
import { MeshBuilder } from './mesh-kit';
import { NeonColours } from './palette';

interface KindModel {
  body: BufferGeometry;
  /** Emissive parts (bloom), tinted per instance. */
  glow?: BufferGeometry;
  /** Colour of the chunks thrown when smashed. */
  debris: number;
}

const CONCRETE = 0x4a4860;
const METAL = 0x3a3c50;
const DARK = 0x1c1c28;

function models(): Record<string, KindModel> {
  const m = (): MeshBuilder => new MeshBuilder();
  return {
    bin: {
      body: m()
        .box(0, 0.42, 0, 0.52, 0.84, 0.52, 0x2c4a44, { top: [0.03, 0.03, 0.03] })
        .box(0, 0.9, 0, 0.58, 0.1, 0.58, 0x3c5c56)
        .box(0, 0.55, 0.265, 0.3, 0.06, 0.01, 0xd8d8e8)
        .build(),
      debris: 0x3c5c56,
    },
    bench: {
      body: m()
        .box(-0.75, 0.22, 0, 0.08, 0.44, 0.44, METAL)
        .box(0.75, 0.22, 0, 0.08, 0.44, 0.44, METAL)
        .box(0, 0.47, 0.02, 1.8, 0.07, 0.48, 0x4a3a52)
        .box(0, 0.78, -0.22, 1.8, 0.32, 0.06, 0x4a3a52)
        .build(),
      debris: 0x4a3a52,
    },
    bollard: {
      body: m().box(0, 0.45, 0, 0.24, 0.9, 0.24, 0x5a5a70, { top: [0.04, 0.04, 0.04] }).build(),
      glow: m().box(0, 0.72, 0, 0.26, 0.08, 0.26, 0xffffff).build(),
      debris: 0x5a5a70,
    },
    hydrant: {
      body: m()
        .box(0, 0.06, 0, 0.42, 0.12, 0.42, 0x7a1424)
        .box(0, 0.36, 0, 0.3, 0.5, 0.3, 0xc0283a)
        .box(0, 0.66, 0, 0.22, 0.12, 0.22, 0xd8d0c0)
        .box(0, 0.42, 0, 0.5, 0.1, 0.12, 0xa02030)
        .build(),
      debris: 0xc0283a,
    },
    tree: {
      body: m()
        .box(0, 0.25, 0, 1.3, 0.5, 1.3, CONCRETE)
        .box(0, 0.52, 0, 1.1, 0.06, 1.1, 0x1a1410)
        .box(0, 1.5, 0, 0.18, 2.0, 0.18, 0x3a2a26)
        .box(0, 2.9, 0, 2.4, 1.2, 2.4, 0x1e4a46, { top: [0.4, 0.4, 0.4] })
        .box(0.2, 3.8, -0.1, 1.7, 1.0, 1.7, 0x25584f, { top: [0.4, 0.4, 0.4] })
        .box(-0.1, 4.55, 0.1, 0.9, 0.7, 0.9, 0x2e6a5c, { top: [0.25, 0.25, 0.25] })
        .build(),
      glow: m()
        .box(0, 0.47, 0.655, 1.3, 0.04, 0.02, 0xffffff)
        .box(0, 0.47, -0.655, 1.3, 0.04, 0.02, 0xffffff)
        .box(0.655, 0.47, 0, 0.02, 0.04, 1.3, 0xffffff)
        .box(-0.655, 0.47, 0, 0.02, 0.04, 1.3, 0xffffff)
        .build(),
      debris: 0x25584f,
    },
    vending: {
      body: m()
        .box(0, 0.95, 0, 1.0, 1.9, 0.8, DARK)
        .box(0, 0.25, 0.41, 0.6, 0.18, 0.02, 0x0a0a10)
        .box(0.34, 1.0, 0.41, 0.18, 0.5, 0.02, METAL)
        .build(),
      glow: m()
        .box(-0.12, 1.15, 0.405, 0.6, 1.1, 0.02, 0xffffff)
        .box(0, 1.84, 0.405, 0.9, 0.1, 0.02, 0xffffff)
        .build(),
      debris: DARK,
    },
    kiosk: {
      body: m()
        .box(0, 0.55, 0, 3.0, 1.1, 2.4, 0x2a2838)
        .box(0, 1.14, 0.5, 3.0, 0.08, 1.4, METAL)
        .box(-1.4, 1.9, -1.1, 0.12, 1.6, 0.12, METAL)
        .box(1.4, 1.9, -1.1, 0.12, 1.6, 0.12, METAL)
        .box(-1.4, 1.9, 1.1, 0.12, 1.6, 0.12, METAL)
        .box(1.4, 1.9, 1.1, 0.12, 1.6, 0.12, METAL)
        .box(0, 2.78, 0.1, 3.5, 0.16, 2.9, 0x332f48, { top: [0.2, 0.2, 0.1] })
        .box(0, 1.5, -1.12, 2.7, 0.7, 0.06, 0x191926)
        .build(),
      glow: m()
        .box(0, 2.7, 1.56, 3.5, 0.14, 0.04, 0xffffff)
        .box(0, 1.45, -1.08, 2.2, 0.5, 0.03, 0xffffff)
        .box(0, 0.9, 1.21, 2.6, 0.05, 0.02, 0xffffff)
        .build(),
      debris: 0x332f48,
    },
    dumpster: {
      body: m()
        .box(0, 0.6, 0, 2.0, 1.1, 1.2, 0x23463f, { top: [0, 0, 0.04] })
        .box(0, 1.2, -0.05, 2.04, 0.12, 1.26, 0x1a332e, { rot: [-0.08, 0, 0] })
        .box(-0.95, 0.08, 0.45, 0.14, 0.16, 0.14, DARK)
        .box(0.95, 0.08, 0.45, 0.14, 0.16, 0.14, DARK)
        .box(0, 0.6, 0.61, 1.6, 0.08, 0.02, 0x3a6a5e)
        .build(),
      debris: 0x23463f,
    },
    crate: {
      body: m()
        .box(0, 0.5, 0, 1.0, 1.0, 1.0, 0x5a4636)
        .box(0, 0.5, 0.505, 0.92, 0.12, 0.01, 0x3a2c22)
        .box(0, 0.5, -0.505, 0.92, 0.12, 0.01, 0x3a2c22)
        .box(0.505, 0.5, 0, 0.01, 0.12, 0.92, 0x3a2c22)
        .box(-0.505, 0.5, 0, 0.01, 0.12, 0.92, 0x3a2c22)
        .build(),
      debris: 0x5a4636,
    },
    barrier: {
      body: m()
        .box(-0.9, 0.08, 0, 0.3, 0.16, 0.6, DARK)
        .box(0.9, 0.08, 0, 0.3, 0.16, 0.6, DARK)
        .box(-0.9, 0.45, 0, 0.08, 0.7, 0.08, METAL)
        .box(0.9, 0.45, 0, 0.08, 0.7, 0.08, METAL)
        .box(-0.6, 0.7, 0, 0.6, 0.26, 0.06, 0xd8d8e0)
        .box(0, 0.7, 0, 0.6, 0.26, 0.06, 0xc02838)
        .box(0.6, 0.7, 0, 0.6, 0.26, 0.06, 0xd8d8e0)
        .build(),
      glow: m().box(0.9, 0.9, 0, 0.14, 0.12, 0.14, 0xffffff).build(),
      debris: 0xc02838,
    },
  };
}

/** Colour of a prop's glow: neon for machines and kiosks, cyan planter trim, amber for barriers. */
function glowColour(kind: string, id: number): number {
  if (kind === 'tree') return 0x21c8d8;
  if (kind === 'bollard') return 0xd8e8ff;
  if (kind === 'barrier') return 0xffa030;
  return NeonColours[(id * 7) % NeonColours.length]!;
}

/**
 * Street furniture, one instanced mesh per kind (plus one per kind with glowing
 * parts). Smashed props disappear until the sim puts them back.
 */
export class PropsView {
  readonly meshes: InstancedMesh[] = [];
  private readonly glows: InstancedMesh[] = [];
  private readonly slots: { prop: Prop; body: InstancedMesh; glow: InstancedMesh | null; index: number; shown: boolean }[] = [];
  private readonly o = new Object3D();
  private readonly zero = new Object3D();
  private readonly models = models();

  constructor(scene: Scene, props: readonly Prop[]) {
    const byKind = new Map<string, Prop[]>();
    for (const p of props) {
      const list = byKind.get(p.kind);
      if (list) list.push(p);
      else byKind.set(p.kind, [p]);
    }
    const bodyMat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const glowMat = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const c = new Color();
    this.zero.scale.set(0, 0, 0);
    this.zero.updateMatrix();
    for (const [kind, list] of byKind) {
      const model = this.models[kind];
      if (!model) continue;
      const body = new InstancedMesh(model.body, bodyMat, list.length);
      body.name = `props-${kind}`;
      scene.add(body);
      this.meshes.push(body);
      let glow: InstancedMesh | null = null;
      if (model.glow) {
        glow = new InstancedMesh(model.glow, glowMat, list.length);
        glow.name = `props-${kind}-glow`;
        glow.layers.enable(BLOOM_LAYER);
        scene.add(glow);
        this.glows.push(glow);
      }
      list.forEach((p, i) => {
        this.place(p, body, glow, i, true);
        if (glow) glow.setColorAt(i, c.setHex(glowColour(kind, p.id)).multiplyScalar(kind === 'bollard' ? 0.5 : 1.3));
        this.slots.push({ prop: p, body, glow, index: i, shown: true });
      });
      body.instanceMatrix.needsUpdate = true;
      if (glow) glow.instanceMatrix.needsUpdate = true;
    }
  }

  /** Neon props that also light the street: vending machines and kiosks. */
  lights(): { x: number; z: number; colour: number; radius: number; propId: number }[] {
    const out: { x: number; z: number; colour: number; radius: number; propId: number }[] = [];
    for (const s of this.slots) {
      const p = s.prop;
      if (p.kind !== 'vending' && p.kind !== 'kiosk') continue;
      const fx = Math.sin(p.yaw);
      const fz = Math.cos(p.yaw);
      out.push({ x: p.x + fx * 1.2, z: p.z + fz * 1.2, colour: glowColour(p.kind, p.id), radius: p.kind === 'kiosk' ? 8 : 5, propId: p.id });
    }
    return out;
  }

  /** The chunk colour for a kind of prop. */
  debrisColour(kind: string): number {
    if (kind === 'lamp') return 0x3a3a50;
    return this.models[kind]?.debris ?? 0x55556a;
  }

  private place(p: Prop, body: InstancedMesh, glow: InstancedMesh | null, i: number, show: boolean): void {
    const o = this.o;
    o.position.set(p.x, 0, p.z);
    o.rotation.set(0, p.yaw, 0);
    o.scale.set(1, 1, 1);
    o.updateMatrix();
    const mat = show ? o.matrix : this.zero.matrix;
    body.setMatrixAt(i, mat);
    glow?.setMatrixAt(i, mat);
  }

  /** Hide smashed props, show restored ones. Only touches what changed. */
  update(): void {
    for (const s of this.slots) {
      const show = !s.prop.broken;
      if (show === s.shown) continue;
      s.shown = show;
      this.place(s.prop, s.body, s.glow, s.index, show);
      s.body.instanceMatrix.needsUpdate = true;
      if (s.glow) s.glow.instanceMatrix.needsUpdate = true;
    }
  }
}
