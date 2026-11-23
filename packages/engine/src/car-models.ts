import type { BufferGeometry } from 'three';
import { MeshBuilder } from './mesh-kit';

/**
 * Original low-poly vehicle bodies (flat-shaded, vertex-coloured), one builder
 * per body model, each sized to the variant's collision box so what you see is
 * what you hit. Every model also returns where its wheels and lamps sit, so the
 * view can draw spinning wheels and emissive lights with shared instanced meshes.
 *
 * Vertex colour pure white (PAINT) is tinted by the instance paint; every other
 * colour is fixed trim and keeps its colour whatever the paint.
 */
const PAINT = 0xffffff;
const GLASS = 0x2c3d6e;
const GLASS_DARK = 0x1a2340;
const TRIM = 0x1a1a24;
const BLACK = 0x0e0e14;
const CHROME = 0x8a8aa0;
const GRILLE = 0x0c0c12;
const FIXED_WHITE = 0xe6e6ee;
const ROOF_GREY = 0xb4b4c2;
const RUBBER = 0x22222a;

export interface CarDims {
  length: number;
  width: number;
  height: number;
}

export interface WheelSpec {
  x: number;
  z: number;
  r: number;
  w: number;
  steer: boolean;
}

/**
 * Emissive lamps. head/tail react to driving (tail brightens under braking);
 * beaconA/beaconB alternate while the vehicle is on a call; sign, amber and
 * accent glow steadily in their own colour.
 */
export type LightKind = 'head' | 'tail' | 'beaconA' | 'beaconB' | 'sign' | 'amber' | 'accent';
export type BeaconScheme = 'none' | 'police' | 'squad' | 'ambulance' | 'fire';

export interface LightSpec {
  k: LightKind;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  /** Colour for sign and accent lamps. */
  c?: number;
}

/** Where wheels, lamps and (on bikes) the rider sit on a model, in local metres (+Z forward, +X left). */
export interface CarLayout {
  wheels: WheelSpec[];
  lights: LightSpec[];
  beacons: BeaconScheme;
  /** Headlight beam origin height on the road and width scale. */
  beamWidth: number;
  /** Bikes: the rider model to seat (see buildRiderModel). */
  rider: RiderStyle | null;
  /** Uniform scale the view applies (bikes are modelled at a nominal size and scaled to their collision box). */
  scale: number;
}

export type RiderStyle = 'upright' | 'tucked';

export interface CarModel {
  geometry: BufferGeometry;
  layout: CarLayout;
  triangles: number;
}

/** Every body model this file can build. vehicles.json picks one per variant with `model`. */
export const MODEL_IDS = [
  'coupe',
  'muscle',
  'van',
  'sedan',
  'suv',
  'super',
  'hatch',
  'saloon',
  'taxi',
  'estate',
  'cuv',
  'sports',
  'hyper',
  'pickup',
  'boxtruck',
  'hauler',
  'bus',
  'ambulance',
  'fireengine',
  'policevan',
  'heavyinterceptor',
  'moto',
  'sportbike',
] as const;
export type ModelId = (typeof MODEL_IDS)[number];

const LEGACY: Record<string, ModelId> = {
  kestrel: 'coupe',
  vandal: 'muscle',
  brick: 'van',
  interceptor: 'sedan',
  enforcer: 'suv',
  prototype: 'super',
};

export function isModelId(m: string): m is ModelId {
  return (MODEL_IDS as readonly string[]).includes(m);
}

/** The body model for a variant: its `model` field when known, else a legacy pick by id. */
export function modelFor(variant: string, model?: string): ModelId {
  if (model && isModelId(model)) return model;
  return LEGACY[variant] ?? 'sedan';
}

/** @deprecated use modelFor; kept for older callers. */
export function styleFor(variant: string): ModelId {
  return modelFor(variant);
}

/** Shared state while one model is being built. */
class Kit {
  readonly b = new MeshBuilder();
  readonly wheels: WheelSpec[] = [];
  readonly lights: LightSpec[] = [];
  readonly hl: number;
  readonly hw: number;
  constructor(
    readonly L: number,
    readonly W: number,
    readonly H: number,
  ) {
    this.hl = L / 2;
    this.hw = W / 2;
  }

  /** A box by its bottom face: (x, y0, z) is the centre of the base. */
  slab(x: number, y0: number, z: number, w: number, h: number, d: number, col: number, top?: [number, number, number]): this {
    this.b.box(x, y0 + h / 2, z, w, h, d, col, top ? { top } : {});
    return this;
  }

  /** The same slab mirrored either side of the centre line. */
  pair(x: number, y0: number, z: number, w: number, h: number, d: number, col: number, top?: [number, number, number]): this {
    this.slab(x, y0, z, w, h, d, col, top);
    this.slab(-x, y0, z, w, h, d, col, top);
    return this;
  }

  axle(z: number, r: number, w: number, steer: boolean, inset = 0.16, x?: number): this {
    const wx = x ?? this.hw - inset;
    this.wheels.push({ x: wx, z, r, w, steer }, { x: -wx, z, r, w, steer });
    return this;
  }

  /** A single wheel on the centre line (bikes). */
  wheel(z: number, r: number, w: number, steer: boolean): this {
    this.wheels.push({ x: 0, z, r, w, steer });
    return this;
  }

  light(k: LightKind, x: number, y: number, z: number, w: number, h: number, d: number, c?: number): this {
    this.lights.push(c === undefined ? { k, x, y, z, w, h, d } : { k, x, y, z, w, h, d, c });
    return this;
  }

  lightPair(k: LightKind, x: number, y: number, z: number, w: number, h: number, d: number, c?: number): this {
    this.light(k, x, y, z, w, h, d, c);
    this.light(k, -x, y, z, w, h, d, c);
    return this;
  }

  /** Head and tail lamp pairs at the very ends of the body. */
  lamps(headY: number, tailY: number, spread = 0.68, size = 0.22, headZ = this.hl, tailZ = -this.hl): this {
    this.lightPair('head', this.hw * spread, headY, headZ + 0.02, this.W * size, 0.12, 0.06);
    this.lightPair('tail', this.hw * (spread + 0.02), tailY, tailZ - 0.02, this.W * (size + 0.02), 0.1, 0.06);
    return this;
  }

  /** A roof light bar: a dark housing with two beacon halves. */
  lightBar(y: number, z: number, width: number, depth = 0.3): this {
    this.slab(0, y, z, width + 0.08, 0.08, depth + 0.06, TRIM);
    this.light('beaconA', width * 0.25, y + 0.14, z, width * 0.48, 0.14, depth);
    this.light('beaconB', -width * 0.25, y + 0.14, z, width * 0.48, 0.14, depth);
    return this;
  }

  /** Front and rear bumpers. */
  bumpers(y: number, h = 0.24, col = TRIM, widthMul = 0.98): this {
    this.slab(0, y, this.hl - 0.07, this.W * widthMul, h, 0.14, col);
    this.slab(0, y, -this.hl + 0.07, this.W * widthMul, h, 0.14, col);
    return this;
  }

  done(beacons: BeaconScheme = 'none', rider: RiderStyle | null = null, beamWidth = this.W, scale = 1): CarModel {
    const triangles = this.b.triangles;
    return { geometry: this.b.build(), layout: { wheels: this.wheels, lights: this.lights, beacons, beamWidth, rider, scale }, triangles };
  }
}

/** Build one body model sized to a variant's collision box. */
export function buildCarModel(model: ModelId, d: CarDims): CarModel {
  const k = new Kit(d.length, d.width, d.height);
  switch (model) {
    case 'coupe':
      return coupe(k);
    case 'muscle':
      return muscle(k);
    case 'van':
      return van(k);
    case 'sedan':
      return policeCar(k, false);
    case 'suv':
      return policeCar(k, true);
    case 'super':
      return prototype(k);
    case 'hatch':
      return hatch(k);
    case 'saloon':
      return saloon(k, false);
    case 'taxi':
      return saloon(k, true);
    case 'estate':
      return estate(k);
    case 'cuv':
      return cuv(k);
    case 'sports':
      return sports(k);
    case 'hyper':
      return hyper(k);
    case 'pickup':
      return pickup(k);
    case 'boxtruck':
      return boxTruck(k);
    case 'hauler':
      return hauler(k);
    case 'bus':
      return bus(k);
    case 'ambulance':
      return ambulance(k);
    case 'fireengine':
      return fireEngine(k);
    case 'policevan':
      return policeVan(k);
    case 'heavyinterceptor':
      return heavyInterceptor(k);
    case 'moto':
      return moto(k);
    case 'sportbike':
      return sportBike(k);
  }
}

// ---------------------------------------------------------------- cars

function coupe(k: Kit): CarModel {
  const { W, L, hl } = k;
  const ride = 0.28;
  k.slab(0, ride, 0, W, 0.52, L, PAINT, [0.35, 0.12, 0.06]);
  k.slab(0, ride + 0.52, -0.3, W * 0.84, 0.44, L * 0.44, GLASS, [0.42, 0.36, 0.14]);
  k.slab(0, ride + 0.96, -0.35, W * 0.6, 0.05, L * 0.22, PAINT);
  k.bumpers(ride);
  k.slab(0, ride + 0.24, hl - 0.03, W * 0.42, 0.12, 0.06, GRILLE);
  k.pair(W / 2 - 0.01, ride + 0.02, 0, 0.04, 0.12, L * 0.5, CHROME);
  k.axle(hl * 0.66, 0.34, 0.3, true).axle(-hl * 0.64, 0.34, 0.3, false);
  k.lamps(ride + 0.36, ride + 0.4);
  return k.done();
}

function muscle(k: Kit): CarModel {
  const { W, L, hl } = k;
  const ride = 0.3;
  k.slab(0, ride, 0, W, 0.56, L, PAINT, [0.12, 0.1, 0.05]);
  k.slab(0, ride + 0.56, hl * 0.42, W * 0.36, 0.1, L * 0.2, TRIM, [0.12, 0.02, 0.04]);
  k.slab(0, ride + 0.56, -hl * 0.22, W * 0.86, 0.42, L * 0.36, GLASS, [0.4, 0.3, 0.12]);
  k.slab(0, ride + 0.98, -hl * 0.26, W * 0.66, 0.05, L * 0.18, PAINT);
  k.slab(0, ride + 0.59, -hl + 0.12, W * 0.9, 0.06, 0.24, TRIM);
  k.bumpers(ride + 0.01, 0.26, CHROME, 1);
  k.slab(0, ride + 0.27, hl - 0.01, W * 0.7, 0.14, 0.06, GRILLE);
  k.pair(0.22, ride + 0.56, hl * 0.1, 0.18, 0.012, L * 0.8, 0xc8c8d6);
  k.axle(hl * 0.68, 0.38, 0.36, true).axle(-hl * 0.62, 0.38, 0.36, false);
  k.lamps(ride + 0.36, ride + 0.42);
  return k.done();
}

function van(k: Kit): CarModel {
  const { W, L, H, hl } = k;
  const ride = 0.32;
  k.slab(0, ride, 0, W, 0.84, L, PAINT);
  k.slab(0, ride + 0.84, -0.35, W * 0.98, H - 1.16, L - 1.3, PAINT, [0, 0, 0.04]);
  k.slab(0, ride + 0.84, hl - 0.95, W * 0.96, H - 1.16, 0.7, GLASS, [0.35, 0, 0.06]);
  k.slab(0, ride + H - 0.32, -0.6, W * 0.8, 0.14, L * 0.5, TRIM);
  k.bumpers(ride, 0.28, TRIM, 1);
  k.pair(W / 2, ride + 0.45, -0.5, 0.03, 0.9, L * 0.48, FIXED_WHITE);
  k.axle(hl * 0.64, 0.4, 0.34, true, 0.18).axle(-hl * 0.66, 0.4, 0.34, false, 0.18);
  k.lamps(ride + 0.5, ride + 0.6);
  return k.done();
}

function policeCar(k: Kit, suv: boolean): CarModel {
  const { W, L, hl } = k;
  const ride = suv ? 0.42 : 0.3;
  const bodyH = suv ? 0.62 : 0.54;
  k.slab(0, ride, 0, W, bodyH, L, PAINT, [0.25, 0.15, 0.05]);
  const gH = suv ? 0.58 : 0.46;
  k.slab(0, ride + bodyH, suv ? -0.35 : -0.15, W * 0.86, gH, L * (suv ? 0.6 : 0.5), GLASS, suv ? [0.2, 0.05, 0.08] : [0.42, 0.34, 0.12]);
  const roofY = ride + bodyH + gH;
  k.slab(0, roofY, suv ? -0.45 : -0.2, W * (suv ? 0.8 : 0.66), 0.05, L * (suv ? 0.5 : 0.28), PAINT);
  // Two-tone livery: dark doors.
  k.pair(W / 2 + 0.005, ride + bodyH * 0.15, -0.1, 0.02, bodyH * 0.6, L * 0.42, suv ? 0x14141c : 0x1c1c2a);
  k.slab(0, ride + 0.04, hl + 0.06, W * 0.9, 0.32, 0.16, TRIM); // push bar
  k.slab(0, ride + 0.01, -hl + 0.07, W, 0.26, 0.14, TRIM);
  k.axle(hl * 0.66, suv ? 0.42 : 0.35, suv ? 0.36 : 0.3, true).axle(-hl * 0.64, suv ? 0.42 : 0.35, suv ? 0.36 : 0.3, false);
  k.lamps(ride + 0.36, ride + 0.4);
  k.lightBar(roofY + 0.05, suv ? -0.45 : -0.2, 1.1);
  return k.done(suv ? 'squad' : 'police');
}

function prototype(k: Kit): CarModel {
  const { W, L, hl } = k;
  const ride = 0.2;
  k.slab(0, ride, 0, W, 0.48, L, PAINT, [0.7, 0.2, 0.12]);
  k.slab(0, ride + 0.48, -0.25, W * 0.76, 0.4, L * 0.42, GLASS, [0.75, 0.45, 0.18]);
  k.slab(0, ride + 0.59, -hl + 0.2, W * 0.95, 0.06, 0.34, TRIM);
  k.pair(W * 0.38, ride + 0.46, -hl + 0.24, 0.06, 0.12, 0.12, TRIM);
  k.pair(W / 2 - 0.02, ride + 0.21, -0.3, 0.06, 0.18, 0.7, GRILLE);
  k.slab(0, ride + 0.01, hl - 0.08, W * 0.94, 0.14, 0.16, TRIM);
  k.axle(hl * 0.64, 0.34, 0.34, true, 0.14).axle(-hl * 0.62, 0.34, 0.34, false, 0.14);
  k.lamps(ride + 0.3, ride + 0.42);
  k.lightPair('accent', W / 2 + 0.01, ride + 0.1, 0, 0.03, 0.04, L * 0.6, 0x21f0ff);
  return k.done();
}

function hatch(k: Kit): CarModel {
  const { W, L, hl } = k;
  const ride = 0.27;
  const bodyH = 0.56;
  k.slab(0, ride, 0, W, bodyH, L, PAINT, [0.3, 0.06, 0.06]);
  // Tall glasshouse running almost to the tail: the hatchback's stubby box silhouette.
  const gz = -0.22;
  const gl = L * 0.6;
  k.slab(0, ride + bodyH, gz, W * 0.88, 0.5, gl, GLASS, [0.36, 0.08, 0.1]);
  k.slab(0, ride + bodyH + 0.5, gz - 0.12, W * 0.68, 0.05, gl - 0.6, PAINT);
  k.slab(0, ride + bodyH + 0.42, -hl + 0.22, W * 0.7, 0.08, 0.18, BLACK); // tailgate spoiler
  k.bumpers(ride - 0.02, 0.24, TRIM, 1);
  k.slab(0, ride + 0.22, hl - 0.02, W * 0.5, 0.1, 0.05, GRILLE);
  k.pair(W / 2 + 0.005, ride + 0.06, 0, 0.02, 0.1, L * 0.5, BLACK); // side rubbing strip
  k.axle(hl * 0.7, 0.31, 0.26, true, 0.15).axle(-hl * 0.7, 0.31, 0.26, false, 0.15);
  k.lightPair('head', k.hw * 0.7, ride + 0.38, hl + 0.02, W * 0.2, 0.14, 0.06);
  k.lightPair('tail', k.hw * 0.78, ride + 0.62, -hl - 0.02, W * 0.12, 0.26, 0.06);
  return k.done();
}

function saloon(k: Kit, taxi: boolean): CarModel {
  const { W, L, hl } = k;
  const ride = 0.29;
  const bodyH = 0.55;
  k.slab(0, ride, 0, W, bodyH, L, PAINT, [0.28, 0.16, 0.06]);
  const gl = L * 0.46;
  k.slab(0, ride + bodyH, -0.18, W * 0.86, 0.46, gl, GLASS, [0.44, 0.38, 0.12]);
  const roofY = ride + bodyH + 0.46;
  k.slab(0, roofY, -0.2, W * 0.64, 0.05, gl - 0.84, PAINT);
  k.bumpers(ride - 0.01, 0.22, taxi ? BLACK : TRIM);
  k.slab(0, ride + 0.24, hl - 0.02, W * 0.56, 0.12, 0.05, CHROME);
  k.pair(W / 2 + 0.005, ride + 0.48, -0.18, 0.02, 0.04, gl * 0.95, CHROME); // window line
  k.axle(hl * 0.66, 0.34, 0.28, true).axle(-hl * 0.64, 0.34, 0.28, false);
  k.lamps(ride + 0.36, ride + 0.42, 0.66, 0.24);
  if (taxi) {
    // Black chequer band down each flank and a glowing roof sign: reads as a cab from any angle.
    const n = 8;
    const seg = (L * 0.78) / n;
    for (let i = 0; i < n; i += 2) {
      const z = -L * 0.39 + seg * (i + 0.5);
      k.pair(W / 2 + 0.01, ride + 0.24, z, 0.02, 0.1, seg, BLACK);
      k.pair(W / 2 + 0.01, ride + 0.14, z + seg, 0.02, 0.1, seg, BLACK);
    }
    k.slab(0, roofY + 0.05, -0.15, 0.95, 0.06, 0.36, BLACK);
    k.light('sign', 0, roofY + 0.2, -0.15, 0.82, 0.22, 0.3, 0xfff0a0);
    // Bonnet chequer stripe, seen from above.
    for (let i = 0; i < 4; i++) k.slab(-0.42 + i * 0.28, ride + bodyH, hl - 0.75, 0.14, 0.015, 0.14, BLACK);
  }
  return k.done();
}

function estate(k: Kit): CarModel {
  const { W, L, hl } = k;
  const ride = 0.3;
  const bodyH = 0.56;
  k.slab(0, ride, 0, W, bodyH, L, PAINT, [0.3, 0.05, 0.06]);
  const gl = L * 0.66;
  const gz = -hl + gl / 2 + 0.12;
  k.slab(0, ride + bodyH, gz, W * 0.87, 0.5, gl, GLASS, [0.5, 0.06, 0.1]);
  const roofY = ride + bodyH + 0.5;
  k.slab(0, roofY, gz - 0.15, W * 0.68, 0.05, gl - 0.85, PAINT);
  k.pair(W * 0.33, roofY + 0.05, gz - 0.15, 0.05, 0.07, gl - 0.9, CHROME); // roof rails
  k.bumpers(ride - 0.01, 0.22);
  k.slab(0, ride + 0.24, hl - 0.02, W * 0.5, 0.12, 0.05, GRILLE);
  k.pair(W / 2 + 0.005, ride + 0.12, 0, 0.02, 0.14, L * 0.62, 0x6a5038); // faux-wood side panels
  k.axle(hl * 0.66, 0.34, 0.28, true).axle(-hl * 0.64, 0.34, 0.28, false);
  k.lightPair('head', k.hw * 0.68, ride + 0.38, hl + 0.02, W * 0.22, 0.12, 0.06);
  k.lightPair('tail', k.hw * 0.8, ride + 0.6, -hl - 0.02, W * 0.12, 0.3, 0.06);
  return k.done();
}

function cuv(k: Kit): CarModel {
  const { W, L, hl } = k;
  const ride = 0.44;
  const bodyH = 0.7;
  k.slab(0, ride, 0, W, bodyH, L, PAINT, [0.32, 0.08, 0.05]);
  // Black cladding all round the bottom: the off-roader tell.
  k.slab(0, ride - 0.06, 0, W + 0.04, 0.24, L + 0.04, BLACK);
  const gl = L * 0.62;
  const gz = -0.3;
  k.slab(0, ride + bodyH, gz, W * 0.88, 0.5, gl, GLASS, [0.34, 0.06, 0.08]);
  const roofY = ride + bodyH + 0.5;
  k.slab(0, roofY, gz - 0.08, W * 0.76, 0.05, gl - 0.6, PAINT);
  k.pair(W * 0.36, roofY + 0.05, gz - 0.08, 0.06, 0.08, gl - 0.6, BLACK); // roof rails
  k.slab(0, ride + 0.2, hl - 0.02, W * 0.62, 0.22, 0.06, GRILLE);
  k.slab(0, ride + 0.22, -hl - 0.12, 0.62, 0.62, 0.2, BLACK); // spare wheel on the tailgate
  k.axle(hl * 0.66, 0.42, 0.34, true, 0.17).axle(-hl * 0.64, 0.42, 0.34, false, 0.17);
  k.lamps(ride + 0.42, ride + 0.5, 0.7, 0.2);
  return k.done();
}

function sports(k: Kit): CarModel {
  const { W, L, hl } = k;
  const ride = 0.2;
  const bodyH = 0.44;
  k.slab(0, ride, 0, W * 0.92, bodyH, L, PAINT, [0.55, 0.15, 0.04]);
  // Wide rear haunches over the back wheels.
  k.pair(W / 2 - 0.15, ride, -hl * 0.55, 0.3, bodyH + 0.04, L * 0.34, PAINT, [0.3, 0.05, 0.08]);
  k.pair(W / 2 - 0.13, ride, hl * 0.6, 0.26, bodyH - 0.04, L * 0.26, PAINT, [0.12, 0.12, 0.06]);
  // Cabin set well back behind a long bonnet.
  k.slab(0, ride + bodyH, -hl * 0.28, W * 0.7, 0.38, L * 0.34, GLASS, [0.5, 0.36, 0.14]);
  k.slab(0, ride + bodyH + 0.38, -hl * 0.32, W * 0.5, 0.04, L * 0.12, PAINT);
  k.pair(0.2, ride + bodyH, hl * 0.45, 0.2, 0.03, 0.5, BLACK); // bonnet vents
  k.slab(0, ride + bodyH + 0.04, -hl + 0.16, W * 0.84, 0.05, 0.24, BLACK); // ducktail lip
  k.pair(W * 0.36, ride + bodyH, -hl + 0.16, 0.05, 0.06, 0.12, BLACK);
  k.slab(0, ride - 0.01, hl - 0.08, W * 0.9, 0.16, 0.16, BLACK);
  k.slab(0, ride - 0.01, -hl + 0.08, W * 0.9, 0.18, 0.14, BLACK);
  k.axle(hl * 0.64, 0.34, 0.34, true, 0.14).axle(-hl * 0.6, 0.36, 0.38, false, 0.14);
  k.lightPair('head', k.hw * 0.66, ride + 0.3, hl - 0.05, W * 0.24, 0.07, 0.14);
  k.light('tail', 0, ride + 0.36, -hl - 0.02, W * 0.84, 0.07, 0.06); // full-width tail bar
  return k.done();
}

function hyper(k: Kit): CarModel {
  const { W, L, hl } = k;
  const ride = 0.16;
  const bodyH = 0.38;
  // Wedge nose, cab-forward teardrop canopy, slatted engine deck and a big wing on struts.
  k.slab(0, ride, 0, W, bodyH, L, PAINT, [0.9, 0.05, 0.1]);
  k.slab(0, ride + bodyH, 0.1, W * 0.6, 0.36, L * 0.38, GLASS_DARK, [0.6, 0.55, 0.18]);
  for (let i = 0; i < 4; i++) k.slab(0, ride + bodyH, -hl * 0.38 - i * 0.22, W * 0.56, 0.05, 0.1, GRILLE);
  k.pair(W / 2 - 0.05, ride + 0.12, -0.15, 0.14, 0.2, L * 0.36, BLACK, [0.2, 0, 0.04]); // side pods
  k.pair(W * 0.32, ride + bodyH, -hl + 0.3, 0.06, 0.32, 0.12, BLACK); // wing struts
  k.slab(0, ride + bodyH + 0.32, -hl + 0.28, W * 1.02, 0.05, 0.42, BLACK, [0.06, 0, 0]);
  k.slab(0, ride - 0.04, hl - 0.18, W * 0.96, 0.08, 0.36, BLACK); // front splitter
  k.slab(0, ride - 0.02, -hl + 0.12, W * 0.9, 0.14, 0.24, GRILLE); // diffuser
  k.axle(hl * 0.62, 0.33, 0.32, true, 0.14).axle(-hl * 0.6, 0.35, 0.4, false, 0.14);
  k.lightPair('head', k.hw * 0.62, ride + 0.18, hl - 0.18, W * 0.22, 0.04, 0.22);
  k.light('tail', 0, ride + 0.3, -hl - 0.02, W * 0.9, 0.05, 0.05);
  k.lightPair('accent', W / 2 + 0.01, ride + 0.02, 0, 0.03, 0.04, L * 0.7, 0xff2bd6); // underglow
  return k.done();
}

function pickup(k: Kit): CarModel {
  const { W, L, H, hl } = k;
  const ride = 0.46;
  const bodyH = 0.62;
  k.slab(0, ride, 0, W, bodyH, L, PAINT, [0.08, 0, 0.04]);
  // Cab: windscreen, roof and rear window; the open load bed behind is the silhouette.
  const cabF = hl - 1.4;
  const cabR = cabF - 1.55;
  const cabZ = (cabF + cabR) / 2;
  const gH = H - ride - bodyH - 0.06;
  k.slab(0, ride + bodyH, cabZ, W * 0.9, gH, cabF - cabR, GLASS, [0.36, 0.04, 0.08]);
  k.slab(0, ride + bodyH + gH, cabZ - 0.1, W * 0.78, 0.06, cabF - cabR - 0.5, PAINT);
  // Bed: dark floor between paint walls and a tailgate.
  const bedL = cabR + hl - 0.1;
  const bedZ = (cabR - 0.05 + (-hl + 0.05)) / 2;
  k.slab(0, ride + bodyH - 0.01, bedZ, W - 0.24, 0.02, bedL, BLACK);
  k.pair(W / 2 - 0.06, ride + bodyH, bedZ, 0.12, 0.26, bedL, PAINT);
  k.slab(0, ride + bodyH, -hl + 0.08, W, 0.26, 0.12, PAINT);
  k.slab(0, ride + bodyH, cabR - 0.04, W - 0.24, 0.3, 0.08, CHROME); // headache rack
  k.slab(0, ride + bodyH + gH + 0.06, cabZ + 0.35, W * 0.66, 0.08, 0.16, TRIM); // roof lamp pod
  k.slab(0, ride + 0.3, hl - 0.01, W * 0.8, 0.26, 0.06, CHROME); // grille
  k.bumpers(ride - 0.06, 0.24, CHROME, 1.02);
  k.axle(hl * 0.68, 0.45, 0.36, true, 0.2).axle(-hl * 0.6, 0.45, 0.36, false, 0.2);
  k.lamps(ride + 0.44, ride + 0.42, 0.74, 0.18);
  k.lightPair('amber', 0.3, ride + bodyH + gH + 0.15, cabZ + 0.35, 0.16, 0.06, 0.08);
  return k.done();
}

// ---------------------------------------------------------------- heavy

function boxTruck(k: Kit): CarModel {
  const { W, H, hl } = k;
  const ride = 0.5;
  const cabL = 2.1;
  const cabH = 2.6;
  const cabZ = hl - cabL / 2;
  // Cab (paint) with a big windscreen and a roof fairing.
  k.slab(0, ride, cabZ, W * 0.96, cabH - ride - 0.8, cabL, PAINT, [0.1, 0, 0.04]);
  k.slab(0, cabH - 0.8, cabZ + 0.05, W * 0.94, 0.72, cabL - 0.2, GLASS, [0.3, 0, 0.06]);
  k.slab(0, cabH - 0.08, cabZ - 0.05, W * 0.9, 0.08, cabL - 0.5, PAINT);
  k.slab(0, cabH, cabZ - 0.2, W * 0.86, 0.4, 0.9, PAINT, [0.6, 0, 0.1]); // wind deflector
  k.slab(0, ride + 0.2, hl - 0.02, W * 0.7, 0.4, 0.06, GRILLE);
  k.slab(0, ride - 0.1, hl - 0.08, W, 0.3, 0.18, TRIM);
  // Cargo box: light grey with a paint stripe and roof ribs that read from above.
  const boxF = hl - cabL - 0.15;
  const boxL = boxF + hl;
  const boxZ = (boxF - hl) / 2;
  const boxY = ride + 0.35;
  k.slab(0, boxY, boxZ, W, H - boxY, boxL, FIXED_WHITE);
  k.pair(W / 2 + 0.01, boxY + 0.55, boxZ, 0.02, 0.45, boxL - 0.3, PAINT);
  for (let i = 1; i < 6; i++) k.slab(0, H, boxF - (boxL * i) / 6, W - 0.08, 0.03, 0.08, ROOF_GREY);
  k.slab(0, ride, boxZ, W * 0.8, 0.35, boxL, TRIM); // chassis rails
  k.slab(0, boxY + 0.1, -hl - 0.02, W - 0.1, H - boxY - 0.2, 0.04, ROOF_GREY); // roller door
  k.slab(0, ride - 0.1, -hl + 0.1, W * 0.9, 0.2, 0.16, TRIM);
  k.axle(hl - 1.1, 0.5, 0.38, true, 0.2).axle(-hl + 1.5, 0.5, 0.6, false, 0.3);
  k.lightPair('head', k.hw * 0.72, ride + 0.25, hl + 0.02, 0.36, 0.16, 0.06);
  k.lightPair('tail', k.hw * 0.8, ride + 0.2, -hl - 0.03, 0.3, 0.16, 0.06);
  k.lightPair('amber', k.hw - 0.1, H + 0.02, boxF - 0.1, 0.14, 0.08, 0.14);
  k.lightPair('amber', k.hw - 0.1, H + 0.02, -hl + 0.1, 0.14, 0.08, 0.14);
  k.lightPair('amber', 0.3, cabH + 0.42, cabZ - 0.1, 0.12, 0.06, 0.1);
  return k.done();
}

function hauler(k: Kit): CarModel {
  const { W, H, hl } = k;
  const ride = 0.55;
  // Tractor unit: dark cab, chrome stacks, then a long paint-coloured box trailer.
  const cabL = 2.4;
  const cabH = 3.1;
  const cabZ = hl - cabL / 2;
  const CAB = 0x2a2c3a;
  k.slab(0, ride, cabZ, W * 0.96, cabH - ride - 0.85, cabL, CAB, [0.12, 0, 0.04]);
  k.slab(0, cabH - 0.85, cabZ + 0.35, W * 0.94, 0.7, cabL - 0.7, GLASS, [0.28, 0, 0.06]);
  k.slab(0, cabH - 0.85, cabZ - cabL / 2 + 0.35, W * 0.94, 0.85, 0.7, CAB); // sleeper
  k.slab(0, cabH - 0.15, cabZ, W * 0.9, 0.15, cabL - 0.3, CAB);
  k.slab(0, cabH, cabZ - 0.1, W * 0.9, 0.55, 1.2, CAB, [0.8, 0, 0.12]); // roof fairing
  k.slab(0, ride + 0.2, hl - 0.03, W * 0.76, 1.0, 0.08, CHROME); // big grille
  k.slab(0, ride - 0.12, hl - 0.1, W, 0.32, 0.2, CHROME);
  k.pair(W / 2 - 0.12, ride + 0.2, cabZ - cabL / 2 - 0.1, 0.16, cabH - 0.2, 0.16, CHROME); // exhaust stacks
  k.pair(W / 2 - 0.05, ride + 0.05, cabZ - 0.2, 0.2, 0.45, 1.0, CHROME); // fuel tanks
  // Fifth wheel gap and trailer.
  const trF = hl - cabL - 0.45;
  const trL = trF + hl;
  const trZ = (trF - hl) / 2;
  const trY = ride + 0.75;
  k.slab(0, ride, hl - cabL - 1.0, W * 0.6, 0.5, 2.0, TRIM); // chassis under the coupling
  k.slab(0, trY, trZ, W, H - trY, trL, PAINT);
  // Corrugated sides and roof ribs: reads as a container from above.
  for (let i = 0; i < 9; i++) {
    const z = trF - 0.6 - (i * (trL - 1.2)) / 8;
    k.slab(0, H, z, W - 0.06, 0.03, 0.1, 0x9a9aa8);
  }
  k.pair(W / 2 + 0.01, trY + 0.2, trZ, 0.02, 0.1, trL - 0.2, TRIM);
  k.slab(0, trY + 0.1, -hl - 0.02, W - 0.12, H - trY - 0.2, 0.04, 0x55556a); // rear doors
  k.slab(0, trY - 0.35, trZ - trL * 0.15, W * 0.8, 0.35, trL * 0.5, TRIM); // trailer chassis
  k.slab(0, ride - 0.05, -hl + 0.1, W * 0.94, 0.2, 0.14, 0xd02040); // rear under-run bar
  k.axle(hl - 1.0, 0.52, 0.38, true, 0.2);
  k.axle(hl - cabL - 0.3, 0.52, 0.6, false, 0.3).axle(hl - cabL - 1.5, 0.52, 0.6, false, 0.3);
  k.axle(-hl + 3.0, 0.5, 0.6, false, 0.3).axle(-hl + 1.8, 0.5, 0.6, false, 0.3);
  k.lightPair('head', k.hw * 0.74, ride + 0.25, hl + 0.02, 0.34, 0.16, 0.06);
  k.lightPair('tail', k.hw * 0.8, ride + 0.25, -hl - 0.03, 0.34, 0.16, 0.06);
  for (const z of [trF - 0.1, trZ, -hl + 0.1]) k.lightPair('amber', k.hw - 0.08, H + 0.02, z, 0.12, 0.08, 0.14);
  for (let i = 0; i < 4; i++) k.light('amber', -0.45 + i * 0.3, cabH + 0.56, cabZ - 0.5, 0.1, 0.06, 0.08);
  return k.done();
}

function bus(k: Kit): CarModel {
  const { W, L, H, hl } = k;
  const ride = 0.36;
  // Lower body in paint, a continuous window band, light grey roof with a/c pods,
  // a glowing destination board and doors on the nearside (left, +X).
  k.slab(0, ride, 0, W, 1.15, L, PAINT, [0.02, 0, 0.02]);
  const winY = ride + 1.15;
  const winH = H - winY - 0.32;
  k.slab(0, winY, 0, W * 0.98, winH, L - 0.1, GLASS);
  k.slab(0, H - 0.32, 0, W, 0.32, L, ROOF_GREY, [0.15, 0.05, 0.08]);
  for (let i = 0; i < 6; i++) k.pair(W / 2 + 0.005, winY, hl - 1.6 - i * 1.55, 0.02, winH, 0.12, BLACK); // window pillars
  k.pair(W / 2 + 0.005, winY - 0.18, 0, 0.02, 0.14, L - 0.4, PAINT);
  k.slab(0, H, -1.0, W * 0.6, 0.28, 2.6, 0x9a9aa8, [0.3, 0.3, 0.1]); // a/c pod
  k.slab(0, H, 2.6, W * 0.5, 0.2, 1.2, 0x9a9aa8, [0.2, 0.2, 0.1]);
  for (const z of [hl - 1.0, -0.6]) k.slab(W / 2 + 0.01, ride + 0.1, z, 0.03, H - ride - 0.5, 1.1, 0x14141c); // doors
  k.slab(0, ride - 0.06, hl - 0.07, W, 0.3, 0.14, TRIM);
  k.slab(0, ride - 0.06, -hl + 0.07, W, 0.3, 0.14, TRIM);
  k.slab(0, ride + 0.2, -hl - 0.02, W * 0.7, 0.5, 0.06, GRILLE); // rear engine grille
  k.axle(hl - 2.3, 0.5, 0.38, true, 0.22).axle(-hl + 3.1, 0.5, 0.56, false, 0.28);
  k.lightPair('head', k.hw * 0.74, ride + 0.3, hl + 0.02, 0.34, 0.16, 0.06);
  k.lightPair('tail', k.hw * 0.82, ride + 0.6, -hl - 0.02, 0.2, 0.4, 0.06);
  k.light('sign', 0, H - 0.5, hl + 0.01, W * 0.7, 0.24, 0.05, 0xffb21f);
  k.light('sign', 0, H - 0.5, -hl - 0.01, W * 0.4, 0.2, 0.05, 0xffb21f);
  k.lightPair('accent', W / 2 + 0.02, H - 0.36, 0, 0.03, 0.05, L * 0.9, 0x21f0ff); // roofline strip
  return k.done('none', null, W * 0.9);
}

function ambulance(k: Kit): CarModel {
  const { W, H, hl } = k;
  const ride = 0.38;
  // Van cab up front, tall white box behind, chequered flanks and beacons all round.
  const cabL = 1.9;
  const cabZ = hl - cabL / 2;
  k.slab(0, ride, cabZ, W * 0.94, 0.7, cabL, PAINT, [0.5, 0, 0.05]);
  k.slab(0, ride + 0.7, cabZ - 0.25, W * 0.9, 0.62, cabL - 0.5, GLASS, [0.45, 0, 0.08]);
  const boxF = hl - cabL;
  const boxL = boxF + hl;
  const boxZ = (boxF - hl) / 2;
  k.slab(0, ride, boxZ, W, H - ride, boxL, PAINT, [0.05, 0, 0.03]);
  k.slab(0, ride + 1.32, cabZ - 0.1, W * 0.9, 0.05, cabL - 0.8, PAINT);
  // Chequer band (acid and cyan) along both sides, cyan stripe across the roof.
  const n = 8;
  const seg = (boxL - 0.2) / n;
  for (let i = 0; i < n; i++) {
    const z = boxF - 0.1 - seg * (i + 0.5);
    k.pair(W / 2 + 0.01, ride + 0.55, z, 0.02, 0.3, seg, i % 2 ? 0xd7ff2b : 0x1ec8ff);
    k.pair(W / 2 + 0.01, ride + 0.85, z, 0.02, 0.3, seg, i % 2 ? 0x1ec8ff : 0xd7ff2b);
  }
  k.pair(0.45, H, boxZ, 0.28, 0.02, boxL - 0.4, 0x1ec8ff); // twin roof stripes
  k.slab(0, H, boxZ - boxL * 0.25, 0.5, 0.06, 0.9, 0x9a9aa8); // roof vent
  k.slab(0, H, boxZ + boxL * 0.2, 0.7, 0.12, 0.7, 0x9a9aa8);
  k.slab(0, ride + 0.3, -hl - 0.02, 0.04, H - ride - 0.5, 0.04, BLACK); // rear door split
  k.bumpers(ride - 0.05, 0.26, TRIM, 1);
  k.slab(0, ride + 0.22, hl - 0.01, W * 0.6, 0.2, 0.05, GRILLE);
  k.axle(hl - 0.95, 0.42, 0.32, true, 0.2).axle(-hl + 1.3, 0.42, 0.44, false, 0.24);
  k.lamps(ride + 0.4, ride + 0.4, 0.74, 0.18);
  k.lightBar(ride + 1.37, cabZ - 0.2, 1.3);
  k.light('beaconB', k.hw - 0.14, H + 0.02, -hl + 0.15, 0.2, 0.12, 0.2);
  k.light('beaconA', -k.hw + 0.14, H + 0.02, -hl + 0.15, 0.2, 0.12, 0.2);
  k.light('beaconA', k.hw - 0.14, H + 0.02, boxF - 0.15, 0.2, 0.12, 0.2);
  k.light('beaconB', -k.hw + 0.14, H + 0.02, boxF - 0.15, 0.2, 0.12, 0.2);
  return k.done('ambulance');
}

function fireEngine(k: Kit): CarModel {
  const { W, L, H, hl } = k;
  const ride = 0.5;
  // Crew cab, locker body with shutter ribs, a ladder along the roof, beacons front and rear.
  const cabL = 2.6;
  const cabH = 2.7;
  const cabZ = hl - cabL / 2;
  k.slab(0, ride, cabZ, W, cabH - ride - 0.8, cabL, PAINT, [0.08, 0, 0.04]);
  k.slab(0, cabH - 0.8, cabZ, W * 0.98, 0.7, cabL - 0.1, GLASS, [0.25, 0.02, 0.06]);
  k.slab(0, cabH - 0.1, cabZ - 0.05, W * 0.96, 0.1, cabL - 0.4, PAINT);
  const bodyF = hl - cabL - 0.05;
  const bodyL = bodyF + hl;
  const bodyZ = (bodyF - hl) / 2;
  const bodyH = H - 0.55 - ride;
  k.slab(0, ride, bodyZ, W, bodyH, bodyL, PAINT);
  for (let i = 0; i < 4; i++) {
    const z = bodyF - 0.5 - i * ((bodyL - 0.8) / 4) - (bodyL - 0.8) / 8;
    k.pair(W / 2 + 0.01, ride + 0.35, z, 0.02, bodyH - 0.6, (bodyL - 1.2) / 4, 0xb0b0c0); // shutters
  }
  k.pair(W / 2 + 0.02, ride + 0.18, 0, 0.02, 0.12, L - 0.2, 0xf0f0f6); // white stripe
  const deckY = ride + bodyH;
  k.slab(0, deckY, bodyZ, W - 0.2, 0.06, bodyL - 0.2, 0x3a3a46);
  // Ladder: two rails with rungs, from the tail forward over the cab.
  const ladL = L - 1.2;
  const ladZ = -hl + ladL / 2 + 0.1;
  const ladY = Math.max(deckY, cabH) + 0.22;
  k.pair(0.42, ladY, ladZ, 0.08, 0.12, ladL, CHROME);
  for (let i = 0; i < 10; i++) k.slab(0, ladY + 0.03, ladZ - ladL / 2 + 0.4 + (i * (ladL - 0.8)) / 9, 0.78, 0.05, 0.06, ROOF_GREY);
  k.slab(0, deckY, -hl + 1.2, 0.5, 0.25, 0.5, TRIM); // turntable
  k.slab(0, deckY + 0.05, bodyF - 0.7, 0.8, 0.34, 0.7, 0xc8c8d4); // hose reel
  k.slab(0, ride + 0.25, hl - 0.02, W * 0.76, 0.4, 0.06, CHROME);
  k.slab(0, ride - 0.12, hl - 0.1, W, 0.32, 0.2, CHROME);
  k.slab(0, ride - 0.06, -hl + 0.1, W * 0.94, 0.24, 0.16, TRIM);
  k.axle(hl - 1.3, 0.52, 0.38, true, 0.2).axle(-hl + 2.2, 0.52, 0.6, false, 0.3);
  k.lightPair('head', k.hw * 0.72, ride + 0.3, hl + 0.02, 0.36, 0.16, 0.06);
  k.lightPair('tail', k.hw * 0.82, ride + 0.3, -hl - 0.02, 0.24, 0.3, 0.06);
  k.lightBar(cabH + 0.02, hl - 0.45, 1.6, 0.3);
  k.light('beaconA', k.hw - 0.15, deckY + 0.08, -hl + 0.2, 0.22, 0.14, 0.22);
  k.light('beaconB', -k.hw + 0.15, deckY + 0.08, -hl + 0.2, 0.22, 0.14, 0.22);
  k.lightPair('amber', k.hw + 0.02, ride + 0.6, hl - 0.4, 0.04, 0.12, 0.2);
  return k.done('fire');
}

function policeVan(k: Kit): CarModel {
  const { W, L, H, hl } = k;
  const ride = 0.38;
  // High-roof van in white with a blue and cyan chequer band, caged windows and a long light bar.
  k.slab(0, ride, 0, W, 0.86, L, PAINT, [0.45, 0, 0.04]);
  const upH = H - ride - 0.86;
  k.slab(0, ride + 0.86, -0.3, W * 0.97, upH, L - 1.1, PAINT, [0, 0, 0.04]);
  k.slab(0, ride + 0.86, hl - 0.85, W * 0.95, upH - 0.1, 0.5, GLASS, [0.35, 0, 0.06]);
  k.pair(W / 2 + 0.01, ride + 0.96, hl - 1.4, 0.02, 0.5, 0.8, GLASS);
  k.pair(W / 2 + 0.01, ride + 0.96, -0.8, 0.02, 0.5, 2.0, GRILLE); // caged rear windows
  const n = 10;
  const seg = (L - 0.4) / n;
  for (let i = 0; i < n; i++) {
    const z = hl - 0.2 - seg * (i + 0.5);
    k.pair(W / 2 + 0.01, ride + 0.42, z, 0.02, 0.36, seg, i % 2 ? 0x2f6bff : 0x21f0ff);
  }
  k.slab(0, H, -0.6, W - 0.4, 0.02, 1.4, 0x2f6bff); // roof ID panel
  k.bumpers(ride - 0.05, 0.28, TRIM, 1);
  k.slab(0, ride + 0.25, hl - 0.01, W * 0.6, 0.2, 0.05, GRILLE);
  k.axle(hl * 0.66, 0.42, 0.34, true, 0.2).axle(-hl * 0.64, 0.42, 0.38, false, 0.22);
  k.lamps(ride + 0.45, ride + 0.6, 0.74, 0.18);
  k.lightBar(H, hl - 0.95, 1.5);
  k.light('beaconA', k.hw - 0.12, H + 0.02, -hl + 0.12, 0.16, 0.1, 0.16);
  k.light('beaconB', -k.hw + 0.12, H + 0.02, -hl + 0.12, 0.16, 0.1, 0.16);
  return k.done('police');
}

function heavyInterceptor(k: Kit): CarModel {
  const { W, L, H, hl } = k;
  const ride = 0.44;
  // Armoured wedge: steep nose, flared black arches, a short slab cabin set well back,
  // a white chevron on the bonnet, a ram bar and a full-width light bar.
  const bodyH = 0.62;
  k.slab(0, ride, 0, W * 0.94, bodyH, L, PAINT, [0.7, 0.12, 0.1]);
  const fz = hl * 0.64;
  const rz = -hl * 0.62;
  for (const z of [fz, rz]) k.pair(W / 2 - 0.12, ride - 0.06, z, 0.3, 0.5, 1.15, BLACK, [0.2, 0.2, 0.06]); // flared arches
  const gH = H - ride - bodyH;
  const cabZ = -hl * 0.22;
  const cabL = L * 0.42;
  k.slab(0, ride + bodyH, cabZ, W * 0.8, gH, cabL, PAINT, [0.42, 0.22, 0.18]);
  k.slab(0, ride + bodyH + 0.04, cabZ + cabL / 2 - 0.3, W * 0.66, gH * 0.55, 0.1, GLASS_DARK, [0.06, 0, 0.04]); // slit screen
  k.pair(W * 0.4, ride + bodyH + gH * 0.32, cabZ, 0.06, gH * 0.28, cabL * 0.6, GLASS_DARK); // slit side windows
  // Bonnet chevron (fixed white) pointing forwards.
  k.b.box(0.3, ride + bodyH - 0.03, hl * 0.42, 0.18, 0.08, 1.0, 0xf0f0f6, { rot: [0, -0.5, 0] });
  k.b.box(-0.3, ride + bodyH - 0.03, hl * 0.42, 0.18, 0.08, 1.0, 0xf0f0f6, { rot: [0, 0.5, 0] });
  k.slab(0, ride - 0.12, hl + 0.14, W * 1.04, 0.5, 0.22, BLACK); // ram bar
  for (const x of [-0.6, -0.2, 0.2, 0.6]) k.slab(x, ride - 0.12, hl + 0.26, 0.1, 0.6, 0.06, 0x3a3a48);
  k.slab(0, ride - 0.06, -hl + 0.1, W * 0.96, 0.34, 0.2, BLACK);
  k.slab(0, ride + 0.12, -hl - 0.1, 0.7, 0.5, 0.2, 0x2a2a38); // armour plate on the tail
  k.axle(fz, 0.46, 0.42, true, 0.14).axle(rz, 0.46, 0.44, false, 0.14);
  k.lightPair('head', k.hw * 0.36, ride + 0.34, hl + 0.02, 0.2, 0.08, 0.06);
  k.lightPair('head', k.hw * 0.66, ride + 0.34, hl + 0.02, 0.2, 0.08, 0.06);
  k.lightPair('tail', k.hw * 0.7, ride + 0.44, -hl - 0.02, 0.4, 0.08, 0.06);
  k.lightPair('accent', W * 0.47 + 0.01, ride + 0.46, 0, 0.03, 0.05, L * 0.5, 0xff2a3d);
  k.lightBar(H, cabZ - 0.1, W * 0.86, 0.36);
  k.slab(0, H + 0.08, cabZ + 0.45, 0.3, 0.16, 0.24, TRIM); // roof spotlight
  return k.done('police');
}

// ---------------------------------------------------------------- bikes

function moto(k: Kit): CarModel {
  const nominal = 2.1;
  const hl = nominal / 2;
  const r = 0.33;
  // Naked roadster: round lamp, tank, flat seat, chunky engine between the wheels.
  k.slab(0, r + 0.1, 0.05, 0.3, 0.36, 0.62, CHROME, [0.05, 0.05, 0.04]); // engine
  k.slab(0, r + 0.42, 0.2, 0.42, 0.24, 0.62, PAINT, [0.12, 0.08, 0.08]); // tank
  k.slab(0, r + 0.44, -0.35, 0.34, 0.12, 0.62, BLACK); // seat
  k.slab(0, r + 0.36, -hl + 0.32, 0.28, 0.16, 0.4, PAINT, [0, 0.12, 0.06]); // tail
  k.pair(0.1, r, hl - 0.38, 0.05, 0.62, 0.08, CHROME); // forks
  k.slab(0, r + 0.6, hl - 0.48, 0.8, 0.05, 0.06, BLACK); // handlebar
  k.slab(0, r + 0.42, hl - 0.28, 0.24, 0.22, 0.14, TRIM); // lamp bucket
  k.slab(0.16, r - 0.06, -0.3, 0.08, 0.08, 0.7, CHROME); // exhaust
  k.slab(0, r + 0.06, hl - 0.32, 0.18, 0.06, 0.5, PAINT); // front mudguard
  k.slab(0, r + 0.08, -hl + 0.32, 0.18, 0.06, 0.5, PAINT);
  k.wheel(hl - r - 0.02, r, 0.14, true).wheel(-hl + r + 0.02, r, 0.18, false);
  k.light('head', 0, r + 0.5, hl - 0.2, 0.2, 0.18, 0.06);
  k.light('tail', 0, r + 0.42, -hl + 0.1, 0.16, 0.06, 0.04);
  return k.done('none', 'upright', 1.1, k.L / nominal);
}

function sportBike(k: Kit): CarModel {
  const nominal = 2.2;
  const hl = nominal / 2;
  const r = 0.32;
  // Full fairing: pointed nose cowl, small screen, raised tail, accent strip down the flank.
  k.slab(0, r - 0.05, 0.1, 0.36, 0.5, 0.9, PAINT, [0.25, 0.05, 0.06]); // fairing belly
  k.slab(0, r + 0.25, hl - 0.48, 0.42, 0.34, 0.5, PAINT, [0.32, 0, 0.1]); // nose cowl
  k.slab(0, r + 0.55, hl - 0.6, 0.3, 0.12, 0.22, GLASS, [0.14, 0, 0.04]); // screen
  k.slab(0, r + 0.45, 0.02, 0.4, 0.2, 0.5, PAINT, [0.15, 0.05, 0.08]); // tank
  k.slab(0, r + 0.5, -0.4, 0.26, 0.08, 0.46, BLACK); // seat
  k.slab(0, r + 0.48, -hl + 0.3, 0.26, 0.2, 0.56, PAINT, [0, 0.3, 0.06]); // raised tail
  k.pair(0.1, r, hl - 0.4, 0.05, 0.55, 0.08, 0xd0a040); // gold forks
  k.slab(0, r + 0.56, hl - 0.66, 0.6, 0.04, 0.05, BLACK); // clip-ons
  k.slab(0, r + 0.3, -hl + 0.18, 0.12, 0.12, 0.3, CHROME); // under-tail exhaust
  k.wheel(hl - r - 0.02, r, 0.14, true).wheel(-hl + r + 0.04, r, 0.22, false);
  k.lightPair('head', 0.08, r + 0.36, hl - 0.24, 0.1, 0.06, 0.12);
  k.light('tail', 0, r + 0.56, -hl + 0.03, 0.18, 0.05, 0.04);
  k.lightPair('accent', 0.19, r + 0.2, 0.1, 0.02, 0.03, 0.8, 0x21f0ff);
  return k.done('none', 'tucked', 1.1, k.L / nominal);
}

/** A box from one point to another in the YZ plane (limbs, torsos), `t` thick. */
function limb(b: MeshBuilder, x: number, y0: number, z0: number, y1: number, z1: number, t: number, col: number, w = t): void {
  const len = Math.hypot(y1 - y0, z1 - z0);
  const ang = Math.atan2(z1 - z0, y1 - y0);
  // MeshBuilder boxes pivot on the centre of their base, so the base sits at the start point.
  b.box(x, y0 + len / 2, z0, w, len, t, col, { rot: [ang, 0, 0] });
}

/**
 * A low-poly rider for a bike, in the bike's frame. White jacket is tinted per
 * rider; the helmet is fixed black with a neon visor.
 */
export function buildRiderModel(style: RiderStyle): BufferGeometry {
  const b = new MeshBuilder();
  const tucked = style === 'tucked';
  const hipY = tucked ? 0.92 : 0.9;
  const hipZ = tucked ? -0.42 : -0.36;
  const barY = tucked ? 0.9 : 0.97;
  const barZ = tucked ? 0.44 : 0.55;
  const lean = tucked ? 0.95 : 0.42;
  const tLen = 0.64;
  const TROUSERS = 0x1d2030;
  for (const sx of [1, -1]) {
    const kneeY = hipY - 0.04;
    const kneeZ = hipZ + 0.5;
    limb(b, sx * 0.16, hipY, hipZ, kneeY, kneeZ, 0.15, TROUSERS);
    limb(b, sx * 0.19, kneeY, kneeZ, hipY - 0.5, kneeZ - 0.08, 0.13, TROUSERS);
    b.box(sx * 0.19, hipY - 0.52, kneeZ - 0.02, 0.12, 0.08, 0.24, RUBBER);
  }
  const shY = hipY + Math.cos(lean) * tLen;
  const shZ = hipZ + Math.sin(lean) * tLen;
  limb(b, 0, hipY - 0.04, hipZ, shY, shZ, 0.3, PAINT, 0.5);
  limb(b, 0, hipY, hipZ - 0.03, shY, shZ - 0.03, 0.3, 0x2a2a38, 0.22); // back stripe
  for (const sx of [1, -1]) {
    limb(b, sx * 0.25, shY - 0.04, shZ, barY, barZ, 0.12, PAINT);
    b.box(sx * 0.27, barY - 0.04, barZ, 0.1, 0.08, 0.1, BLACK);
  }
  // Helmet with a neon visor.
  const hy = shY + (tucked ? 0.1 : 0.16);
  const hz = shZ + (tucked ? 0.16 : 0.08);
  b.box(0, hy, hz, 0.32, 0.3, 0.36, 0x101018, { top: [0.06, 0.04, 0.05] });
  b.box(0, hy + 0.02, hz + 0.16, 0.26, 0.1, 0.06, 0x30d8ff);
  return b.build();
}
