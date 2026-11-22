import RAPIER from '@dimforge/rapier3d-simd-compat';

export type Rapier = typeof RAPIER;

let ready: Promise<Rapier> | null = null;

/** Initialise Rapier's WebAssembly once. Works in browsers and in Node. */
export function initPhysics(): Promise<Rapier> {
  ready ??= RAPIER.init().then(() => RAPIER);
  return ready;
}

/** Collision group bits. Membership in the high 16 bits, filter in the low 16. */
export const Groups = {
  static: 0x0001,
  vehicle: 0x0002,
  ped: 0x0004,
  player: 0x0008,
  /** Downed peds and ghosts: collide with nothing dynamic. */
  ghost: 0x0010,
} as const;

export function interactionGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export function yawFromQuat(q: { y: number; w: number }): number {
  return 2 * Math.atan2(q.y, q.w);
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
