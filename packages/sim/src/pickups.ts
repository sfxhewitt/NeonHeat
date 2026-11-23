import { z } from 'zod';
import type { World } from './world';

export const PICKUP_SHAPES = ['cross', 'shield', 'bat', 'pistol', 'smg', 'shotgun', 'rifle', 'launcher', 'arc'] as const;
export type PickupShape = (typeof PICKUP_SHAPES)[number];

const PickupKindSchema = z.object({
  /** Icon shape: paired with the colour so kinds read without colour vision. */
  shape: z.enum(PICKUP_SHAPES),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  health: z.number().nonnegative().default(0),
  armour: z.number().nonnegative().default(0),
  weapon: z.string().optional(),
  ammo: z.number().int().nonnegative().default(0),
});
export type PickupKind = z.infer<typeof PickupKindSchema>;

export const PickupsConfigSchema = z.object({
  radius: z.number().positive(),
  respawnSec: z.number().positive(),
  pool: z.number().int().positive(),
  kinds: z.record(z.string(), PickupKindSchema),
  /** When the map has no `pickup_*` markers, these kinds are spread over street corners. */
  auto: z.object({ kinds: z.array(z.string()), minSpacing: z.number().nonnegative(), kerbOffset: z.number().positive() }),
});
export type PickupsConfig = z.infer<typeof PickupsConfigSchema>;

export interface Pickup {
  id: number;
  /** Placed in the world (pool slot in use). */
  active: boolean;
  /** Can be collected now (false while waiting to respawn). */
  available: boolean;
  kind: string;
  shape: PickupShape;
  colour: string;
  x: number;
  z: number;
  /** Comes back after being collected. */
  respawns: boolean;
  timer: number;
}

/**
 * Pooled health, armour and weapon pickups. Placed from map markers named
 * `pickup_<kind>[_n]`, by `place(kind, x, z)` (city generator, missions), or
 * spread over street corners when the map has none. Collected by walking or
 * driving over them; most come back after `respawnSec`.
 */
export class PickupSystem {
  readonly pickups: Pickup[] = [];

  constructor(
    private readonly world: World,
    public config: PickupsConfig,
  ) {
    for (let i = 0; i < config.pool; i++) {
      this.pickups.push({ id: i, active: false, available: false, kind: '', shape: 'cross', colour: '#ffffff', x: 0, z: 0, respawns: true, timer: 0 });
    }
    this.placeFromMap();
  }

  /** Kind named by a marker id such as `pickup_health`, `pickup_smg_2` or `pickup_armour_north`. */
  kindFromMarker(id: string): string | null {
    if (!id.startsWith('pickup_')) return null;
    const rest = id.slice('pickup_'.length);
    let best: string | null = null;
    for (const k of Object.keys(this.config.kinds)) {
      if ((rest === k || rest.startsWith(`${k}_`)) && (!best || k.length > best.length)) best = k;
    }
    return best;
  }

  private placeFromMap(): void {
    let placed = 0;
    for (const [id, m] of Object.entries(this.world.content.map.markers)) {
      const kind = this.kindFromMarker(id);
      if (kind && this.place(kind, m.pos[0], m.pos[2])) placed++;
    }
    if (placed === 0) this.autoPlace();
  }

  /** Spread the auto kinds over street corners (deterministic: no RNG). */
  private autoPlace(): void {
    const w = this.world;
    const nodes = w.roads.nodes;
    const kinds = this.config.auto.kinds;
    if (nodes.length === 0 || kinds.length === 0) return;
    const off = this.config.auto.kerbOffset;
    const corners: [number, number][] = [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    let k = 0;
    for (let i = 0; i < nodes.length * 4 && k < kinds.length; i++) {
      const n = nodes[(i * 7919) % nodes.length]!;
      const [cx, cz] = corners[(i * 3 + Math.floor(i / nodes.length)) % 4]!;
      const x = n.x + cx * off;
      const z = n.z + cz * off;
      if (w.insideBuilding(x, z, 0.8) || w.roads.onRoad(x, z)) continue;
      if (this.pickups.some((p) => p.active && Math.hypot(p.x - x, p.z - z) < this.config.auto.minSpacing)) continue;
      if (this.place(kinds[k]!, x, z)) k++;
    }
  }

  /** Put a pickup in the world. Returns null if the kind is unknown or the pool is full. */
  place(kind: string, x: number, z: number, respawns = true): Pickup | null {
    const def = this.config.kinds[kind];
    if (!def) return null;
    const p = this.pickups.find((q) => !q.active);
    if (!p) return null;
    p.active = true;
    p.available = true;
    p.kind = kind;
    p.shape = def.shape;
    p.colour = def.colour;
    p.x = x;
    p.z = z;
    p.respawns = respawns;
    p.timer = 0;
    return p;
  }

  remove(p: Pickup): void {
    p.active = false;
    p.available = false;
  }

  /** Apply a kind's effect to the player. False if it would be wasted (full health, full ammo). */
  private apply(def: PickupKind): boolean {
    const w = this.world;
    const pc = w.playerCtl;
    let used = false;
    if (def.health > 0 && pc.hp < pc.maxHp) {
      pc.hp = Math.min(pc.maxHp, pc.hp + def.health);
      used = true;
    }
    if (def.armour > 0 && pc.armour < pc.maxArmour) {
      pc.armour = Math.min(pc.maxArmour, pc.armour + def.armour);
      used = true;
    }
    if (def.weapon && w.combat.give(def.weapon, def.ammo)) used = true;
    return used;
  }

  step(dt: number): void {
    const w = this.world;
    const pc = w.playerCtl;
    const canCollect = !pc.dead && !pc.busted;
    const r = this.config.radius + (w.player.vehicle ? 1.2 : 0);
    for (const p of this.pickups) {
      if (!p.active) continue;
      if (!p.available) {
        p.timer -= dt;
        if (p.timer <= 0) p.available = true;
        continue;
      }
      if (!canCollect || Math.abs(p.x - w.player.x) > r || Math.abs(p.z - w.player.z) > r) continue;
      if (Math.hypot(p.x - w.player.x, p.z - w.player.z) > r) continue;
      if (!this.apply(this.config.kinds[p.kind]!)) continue;
      w.events.push({ type: 'pickup', kind: p.kind, x: p.x, z: p.z });
      if (p.respawns) {
        p.available = false;
        p.timer = this.config.respawnSec;
      } else this.remove(p);
    }
  }
}
