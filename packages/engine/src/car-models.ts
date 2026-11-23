import type { BufferGeometry } from 'three';
import { MeshBuilder } from './mesh-kit';

/** Vertex colours. PAINT is tinted by the instance colour; the rest are fixed trim. */
const PAINT = 0xffffff;
const GLASS = 0x2a3a66;
const TRIM = 0x1a1a24;
const CHROME = 0x8a8aa0;
const GRILLE = 0x0c0c12;

export interface CarDims {
  length: number;
  width: number;
  height: number;
}

/** Where lights and wheels sit on a body style, in local metres (+Z forward). */
export interface CarLayout {
  wheelZ: [number, number];
  wheelX: number;
  wheelR: number;
  wheelW: number;
  headY: number;
  tailY: number;
  roofY: number;
  roofZ: number;
}

export interface CarModel {
  geometry: BufferGeometry;
  layout: CarLayout;
}

type Style = 'coupe' | 'muscle' | 'van' | 'sedan' | 'suv' | 'super';

export function styleFor(variant: string): Style {
  switch (variant) {
    case 'kestrel':
      return 'coupe';
    case 'vandal':
      return 'muscle';
    case 'brick':
      return 'van';
    case 'interceptor':
      return 'sedan';
    case 'enforcer':
    case 'heavy':
      return 'suv';
    case 'tactical':
      return 'van';
    case 'prototype':
      return 'super';
    default:
      return 'sedan';
  }
}

/**
 * Original low-poly car bodies, one per style, sized to the variant's
 * collision box so what you see is what you hit.
 */
export function buildCarModel(style: Style, d: CarDims): CarModel {
  const L = d.length;
  const W = d.width;
  const b = new MeshBuilder();
  const hl = L / 2;
  let layout: CarLayout;
  switch (style) {
    case 'coupe': {
      const ride = 0.28;
      b.box(0, ride + 0.26, 0, W, 0.52, L, PAINT, { top: [0.35, 0.12, 0.06] });
      b.box(0, ride + 0.52 + 0.22, -0.3, W * 0.84, 0.44, L * 0.44, GLASS, { top: [0.42, 0.36, 0.14] });
      b.box(0, ride + 0.52 + 0.45, -0.35, W * 0.62, 0.05, L * 0.22, PAINT);
      b.box(0, ride + 0.12, hl - 0.06, W * 0.98, 0.22, 0.14, TRIM);
      b.box(0, ride + 0.12, -hl + 0.06, W * 0.98, 0.22, 0.14, TRIM);
      b.box(0, ride + 0.3, hl - 0.02, W * 0.42, 0.12, 0.06, GRILLE);
      b.box(W / 2 - 0.01, ride + 0.08, 0, 0.04, 0.12, L * 0.5, CHROME);
      b.box(-W / 2 + 0.01, ride + 0.08, 0, 0.04, 0.12, L * 0.5, CHROME);
      layout = { wheelZ: [hl * 0.66, -hl * 0.64], wheelX: W / 2 - 0.16, wheelR: 0.34, wheelW: 0.3, headY: ride + 0.36, tailY: ride + 0.4, roofY: ride + 1.0, roofZ: -0.35 };
      break;
    }
    case 'muscle': {
      const ride = 0.3;
      b.box(0, ride + 0.28, 0, W, 0.56, L, PAINT, { top: [0.12, 0.1, 0.05] });
      b.box(0, ride + 0.56 + 0.04, hl * 0.42, W * 0.36, 0.1, L * 0.2, TRIM, { top: [0.12, 0.02, 0.04] }); // scoop
      b.box(0, ride + 0.56 + 0.21, -hl * 0.22, W * 0.86, 0.42, L * 0.36, GLASS, { top: [0.4, 0.3, 0.12] });
      b.box(0, ride + 0.56 + 0.43, -hl * 0.26, W * 0.66, 0.05, L * 0.18, PAINT);
      b.box(0, ride + 0.62, -hl + 0.12, W * 0.9, 0.06, 0.24, TRIM); // ducktail
      b.box(0, ride + 0.14, hl - 0.06, W * 1.0, 0.26, 0.14, CHROME);
      b.box(0, ride + 0.14, -hl + 0.06, W * 1.0, 0.26, 0.14, CHROME);
      b.box(0, ride + 0.34, hl - 0.01, W * 0.7, 0.14, 0.06, GRILLE);
      // Twin racing stripes are painted by the hood: darker paint bands.
      b.box(0.22, ride + 0.565, hl * 0.1, 0.18, 0.01, L * 0.8, 0xb8b8c8);
      b.box(-0.22, ride + 0.565, hl * 0.1, 0.18, 0.01, L * 0.8, 0xb8b8c8);
      layout = { wheelZ: [hl * 0.68, -hl * 0.62], wheelX: W / 2 - 0.16, wheelR: 0.38, wheelW: 0.36, headY: ride + 0.36, tailY: ride + 0.42, roofY: ride + 1.0, roofZ: -hl * 0.26 };
      break;
    }
    case 'van': {
      const ride = 0.32;
      const H = d.height;
      b.box(0, ride + 0.42, 0, W, 0.84, L, PAINT);
      b.box(0, ride + 0.84 + (H - 1.16) / 2, -0.35, W * 0.98, H - 1.16, L - 0.7 - 0.6, PAINT, { top: [0, 0, 0.04] });
      b.box(0, ride + 0.84 + (H - 1.16) / 2, hl - 0.95, W * 0.96, H - 1.16, 0.7, GLASS, { top: [0.35, 0, 0.06] });
      b.box(0, ride + H - 1.16 + 0.84 + 0.12, -0.6, W * 0.8, 0.24, L * 0.5, TRIM); // roof rack
      b.box(0, ride + 0.14, hl - 0.06, W, 0.28, 0.14, TRIM);
      b.box(0, ride + 0.14, -hl + 0.06, W, 0.28, 0.14, TRIM);
      b.box(W / 2, ride + 0.9, -0.5, 0.03, 0.9, L * 0.48, 0xd8d8e0); // side panel band
      b.box(-W / 2, ride + 0.9, -0.5, 0.03, 0.9, L * 0.48, 0xd8d8e0);
      layout = { wheelZ: [hl * 0.64, -hl * 0.66], wheelX: W / 2 - 0.18, wheelR: 0.4, wheelW: 0.34, headY: ride + 0.5, tailY: ride + 0.6, roofY: ride + H - 0.32 + 0.2, roofZ: -0.6 };
      break;
    }
    case 'sedan':
    case 'suv': {
      const suv = style === 'suv';
      const ride = suv ? 0.42 : 0.3;
      const bodyH = suv ? 0.62 : 0.54;
      b.box(0, ride + bodyH / 2, 0, W, bodyH, L, PAINT, { top: [0.25, 0.15, 0.05] });
      const gH = suv ? 0.58 : 0.46;
      b.box(0, ride + bodyH + gH / 2, suv ? -0.35 : -0.15, W * 0.86, gH, L * (suv ? 0.6 : 0.5), GLASS, { top: suv ? [0.2, 0.05, 0.08] : [0.42, 0.34, 0.12] });
      b.box(0, ride + bodyH + gH + 0.025, suv ? -0.45 : -0.2, W * (suv ? 0.8 : 0.66), 0.05, L * (suv ? 0.5 : 0.28), PAINT);
      // Two-tone police livery: dark doors.
      b.box(W / 2 + 0.005, ride + bodyH * 0.45, -0.1, 0.02, bodyH * 0.6, L * 0.42, suv ? 0x14141c : 0x1c1c2a);
      b.box(-W / 2 - 0.005, ride + bodyH * 0.45, -0.1, 0.02, bodyH * 0.6, L * 0.42, suv ? 0x14141c : 0x1c1c2a);
      b.box(0, ride + 0.2, hl + 0.06, W * 0.9, 0.32, 0.16, TRIM); // push bar
      b.box(0, ride + 0.14, -hl + 0.06, W, 0.26, 0.14, TRIM);
      layout = {
        wheelZ: [hl * 0.66, -hl * 0.64],
        wheelX: W / 2 - 0.16,
        wheelR: suv ? 0.42 : 0.35,
        wheelW: suv ? 0.36 : 0.3,
        headY: ride + 0.36,
        tailY: ride + 0.4,
        roofY: ride + bodyH + gH + 0.06,
        roofZ: suv ? -0.45 : -0.2,
      };
      break;
    }
    case 'super': {
      const ride = 0.2;
      b.box(0, ride + 0.24, 0, W, 0.48, L, PAINT, { top: [0.7, 0.2, 0.12] });
      b.box(0, ride + 0.48 + 0.2, -0.25, W * 0.76, 0.4, L * 0.42, GLASS, { top: [0.75, 0.45, 0.18] });
      b.box(0, ride + 0.62, -hl + 0.2, W * 0.95, 0.06, 0.34, TRIM); // rear wing
      b.box(W * 0.38, ride + 0.52, -hl + 0.24, 0.06, 0.12, 0.12, TRIM);
      b.box(-W * 0.38, ride + 0.52, -hl + 0.24, 0.06, 0.12, 0.12, TRIM);
      b.box(W / 2 - 0.02, ride + 0.3, -0.3, 0.06, 0.18, 0.7, GRILLE); // side intakes
      b.box(-W / 2 + 0.02, ride + 0.3, -0.3, 0.06, 0.18, 0.7, GRILLE);
      b.box(0, ride + 0.08, hl - 0.08, W * 0.94, 0.14, 0.16, TRIM);
      layout = { wheelZ: [hl * 0.64, -hl * 0.62], wheelX: W / 2 - 0.14, wheelR: 0.34, wheelW: 0.34, headY: ride + 0.3, tailY: ride + 0.42, roofY: ride + 0.9, roofZ: -0.3 };
      break;
    }
  }
  return { geometry: b.build(), layout };
}
