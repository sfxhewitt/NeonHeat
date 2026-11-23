import type { BufferGeometry } from 'three';
import { MeshBuilder } from './mesh-kit';

/**
 * Clothing and kit pieces that sit on the shared character rig: headwear in
 * the head's frame, packs, pads and bands in the torso's frame, tools in the
 * right hand's frame. White is paint (tinted per instance); other colours are
 * fixed. All of them share one batched draw call in the people view.
 */
export type GearKind =
  | 'hood'
  | 'hat'
  | 'beanie'
  | 'crest'
  | 'cap'
  | 'helmet'
  | 'shell'
  | 'pads'
  | 'tails'
  | 'bands'
  | 'pack'
  | 'antennaPack'
  | 'tanks'
  | 'umbrella'
  | 'gun'
  | 'nozzle';

/** Torso-frame heights (match the rig in people-view). */
const HIP_Y = 0.94;
const SHOULDER_Y = 1.48;

export function gearGeometries(): Record<GearKind, BufferGeometry> {
  const g = (): MeshBuilder => new MeshBuilder();
  return {
    // Head frame: the neck joint is the origin, the face looks down +Z.
    hood: g()
      .box(0, 0.4, -0.03, 0.33, 0.07, 0.34, 0xffffff)
      .box(0.155, 0.36, -0.03, 0.04, 0.3, 0.33, 0xffffff)
      .box(-0.155, 0.36, -0.03, 0.04, 0.3, 0.33, 0xffffff)
      .box(0, 0.38, -0.175, 0.34, 0.36, 0.05, 0xffffff)
      .build(),
    hat: g()
      .box(0, 0.385, 0.01, 0.48, 0.03, 0.48, 0x18121c)
      .box(0, 0.56, 0, 0.29, 0.18, 0.29, 0x18121c, { top: [0.02, 0.02, 0.02] })
      .build(),
    beanie: g()
      .box(0, 0.46, -0.01, 0.29, 0.13, 0.3, 0xffffff, { top: [0.05, 0.05, 0.05] })
      .box(0, 0.36, -0.01, 0.3, 0.05, 0.31, 0xffffff, { shadeTop: 0.8 })
      .build(),
    crest: g()
      .box(0, 0.54, -0.03, 0.07, 0.17, 0.32, 0xffffff, { top: [0.05, 0.07, 0.01] })
      .build(),
    cap: g()
      .box(0, 0.44, 0, 0.28, 0.09, 0.29, 0xffffff, { top: [0.04, 0.04, 0.04] })
      .box(0, 0.37, 0.19, 0.24, 0.025, 0.15, 0xffffff)
      .build(),
    helmet: g()
      .box(0, 0.47, 0, 0.32, 0.14, 0.32, 0xffffff, { top: [0.07, 0.07, 0.07] })
      .box(0, 0.36, -0.12, 0.36, 0.04, 0.18, 0xffffff)
      .box(0, 0.36, 0.15, 0.3, 0.025, 0.06, 0xffffff)
      .build(),
    // A close dark shell for the visor crew (the visor itself is a glow).
    shell: g()
      .box(0, 0.44, -0.02, 0.29, 0.12, 0.3, 0x24262e, { top: [0.05, 0.05, 0.04] })
      .box(0, 0.3, -0.13, 0.29, 0.2, 0.06, 0x24262e)
      .build(),

    // Torso frame: the feet are the origin.
    pads: g()
      .box(0.28, SHOULDER_Y + 0.1, 0, 0.17, 0.08, 0.22, 0xffffff, { top: [0.03, 0.03, 0.03] })
      .box(-0.28, SHOULDER_Y + 0.1, 0, 0.17, 0.08, 0.22, 0xffffff, { top: [0.03, 0.03, 0.03] })
      .build(),
    tails: g()
      .box(0, HIP_Y + 0.06, -0.01, 0.47, 0.42, 0.28, 0xffffff)
      .box(0, SHOULDER_Y + 0.14, -0.11, 0.4, 0.14, 0.06, 0xffffff)
      .build(),
    bands: g()
      .box(0, HIP_Y + 0.34, 0, 0.455, 0.05, 0.275, 0xffffff)
      .box(0, HIP_Y + 0.52, 0, 0.455, 0.05, 0.275, 0xffffff)
      .build(),
    pack: g()
      .box(0, HIP_Y + 0.62, -0.2, 0.3, 0.36, 0.14, 0xffffff, { top: [0.02, 0.02, 0.02] })
      .box(0, HIP_Y + 0.34, -0.25, 0.26, 0.08, 0.06, 0xffffff, { shadeTop: 0.7 })
      .build(),
    antennaPack: g()
      .box(0, HIP_Y + 0.62, -0.2, 0.3, 0.36, 0.14, 0x22262a, { top: [0.02, 0.02, 0.02] })
      .box(0.1, HIP_Y + 0.98, -0.22, 0.025, 0.36, 0.025, 0x3a3e44)
      .build(),
    tanks: g()
      .box(0.075, HIP_Y + 0.64, -0.21, 0.13, 0.5, 0.13, 0xa8adb4, { top: [0.025, 0.025, 0.025] })
      .box(-0.075, HIP_Y + 0.64, -0.21, 0.13, 0.5, 0.13, 0xa8adb4, { top: [0.025, 0.025, 0.025] })
      .box(0, HIP_Y + 0.4, -0.16, 0.3, 0.05, 0.05, 0x2a2a2a)
      .build(),
    // Held in the raised right hand: a pole and an eight-sided canopy over the head.
    umbrella: g()
      .box(-0.08, 2.22, 0.26, 0.03, 0.66, 0.03, 0x202024)
      .box(-0.06, 2.35, 0.14, 1.2, 0.26, 1.2, 0xffffff, { top: [0.57, 0.57, 0.57] })
      .box(-0.06, 2.35, 0.14, 1.2, 0.26, 1.2, 0xffffff, { top: [0.57, 0.57, 0.57], rot: [0, Math.PI / 4, 0] })
      .build(),

    // Hand frame: the grip is the origin, the barrel or nozzle points down +Z.
    gun: g().box(0, 0, 0.08, 0.07, 0.11, 0.26, 0x2a2a34).box(0, -0.08, 0, 0.06, 0.12, 0.08, 0x1a1a20).build(),
    nozzle: g().box(0, 0, 0.16, 0.07, 0.07, 0.32, 0x34342e).box(0, 0, 0.34, 0.1, 0.1, 0.07, 0xc8a828).build(),
  };
}
