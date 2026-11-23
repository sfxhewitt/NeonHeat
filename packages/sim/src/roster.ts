import type { VehicleClass, VehicleParams, VehiclesContent } from './content';
import type { Rng } from './rng';

/**
 * Roster queries over vehicles.json: which variants belong to a class, a
 * weighted civilian traffic pick with district hints, and per-instance paint.
 * Pure data helpers so traffic, police, missions and audio share one source.
 */

/** Variant ids of one class, in content order. */
export function variantsOfClass(vehicles: VehiclesContent, cls: VehicleClass): string[] {
  const out: string[] = [];
  for (const [id, p] of Object.entries(vehicles.variants)) if (p.class === cls) out.push(id);
  return out;
}

/** How much more likely a variant is in a district it names in its hints. */
export const DISTRICT_BOOST = 4;

/**
 * Weighted pick of a civilian traffic variant (weight = `traffic`, boosted in
 * hinted districts). Returns null when nothing has a traffic weight.
 */
export function pickTrafficVariant(vehicles: VehiclesContent, rng: Rng, district?: string): string | null {
  let total = 0;
  for (const p of Object.values(vehicles.variants)) total += trafficWeight(p, district);
  if (total <= 0) return null;
  let r = rng.next() * total;
  let last: string | null = null;
  for (const [id, p] of Object.entries(vehicles.variants)) {
    const w = trafficWeight(p, district);
    if (w <= 0) continue;
    last = id;
    r -= w;
    if (r < 0) return id;
  }
  return last;
}

export function trafficWeight(p: VehicleParams, district?: string): number {
  if (p.role !== 'civilian' || p.traffic <= 0) return 0;
  return district && p.districts.includes(district) ? p.traffic * DISTRICT_BOOST : p.traffic;
}

/** The paints an instance of a variant can roll: its own, else its class palette, else its colour. */
export function paintsFor(vehicles: VehiclesContent, variantId: string): readonly string[] {
  const p = vehicles.variants[variantId];
  if (!p) return [];
  if (p.paints.length) return p.paints;
  const cls = vehicles.paints[p.class];
  return cls && cls.length ? cls : [p.colour];
}

/** A stable paint for an instance from any integer seed (no RNG draw, so sim determinism is untouched). */
export function paintFor(vehicles: VehiclesContent, variantId: string, seed: number): string {
  const list = paintsFor(vehicles, variantId);
  if (!list.length) return '#ffffff';
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return list[(h >>> 0) % list.length]!;
}
