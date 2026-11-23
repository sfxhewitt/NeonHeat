import { z } from 'zod';
import type { MapContent, VehicleClass } from './content';
import { Rng } from './rng';
import { paintFor } from './roster';
import type { Interactable } from './player';
import { Cell, cityGrid } from './street';
import { forwardSpeed } from './vehicle';
import type { World } from './world';

/**
 * The economy: the places you spend in and what they do. Pure sim, no DOM.
 *
 * - Respray (`respray*` markers): drive in slowly. Costs credits, rolls a new
 *   paint, repairs the car and clears HEAT by the police rules. Refused when
 *   you cannot pay, when HEAT is too high, or while the police can see you.
 * - Arms shop (`armsshop*`) and clinic (`clinic*`): walk onto the pad and the
 *   app opens the shop panel; purchases go through {@link EconomySystem.buy}.
 * - Safehouses (`safehouse*`): buy at the door; an owned one heals you and
 *   asks the app to save when you walk in, and is a respawn point after
 *   FLATLINED when it is nearer than the nearest clinic.
 * - Cyberware (bought at a clinic): Reflex, Plating, Ghost.
 * - Export list (`chopshop*`): deliver a listed civilian car in decent
 *   condition for cash, priced by class and condition.
 *
 * Every price and number lives in `content/data/economy.json`.
 */

const Price = z.number().int().nonnegative();

export const SERVICE_KINDS = ['clinic', 'precinct', 'safehouse', 'respray', 'arms', 'chopshop'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];
export const CYBERWARE = ['reflex', 'plating', 'ghost'] as const;
export type CyberwareId = (typeof CYBERWARE)[number];

const Brand = z.object({ name: z.string().min(1), tagline: z.string() });

export const EconomyConfigSchema = z.object({
  /** On-foot pads (shop doors, safehouse doors), metres. */
  padRadius: z.number().positive().default(2.2),
  /** Drive-in pads (respray, chop shop). */
  carPad: z.object({ radius: z.number().positive(), maxSpeed: z.number().positive() }).default({ radius: 5, maxSpeed: 3 }),
  /** Shop names and taglines, shown on the signs and the shop panel. */
  brands: z.record(z.enum(SERVICE_KINDS), Brand).default({
    clinic: { name: 'CLINIC', tagline: '' },
    precinct: { name: 'PRECINCT', tagline: '' },
    safehouse: { name: 'SAFEHOUSE', tagline: '' },
    respray: { name: 'RESPRAY', tagline: '' },
    arms: { name: 'ARMS', tagline: '' },
    chopshop: { name: 'CHOP SHOP', tagline: '' },
  }),
  respray: z.object({ price: Price }).default({ price: 150 }),
  arms: z
    .object({
      /** Weapon id to price and the ammo it comes with. */
      weapons: z.record(z.string(), z.object({ price: Price, ammo: z.number().int().nonnegative() })),
      ammo: z.record(z.string(), z.object({ price: Price, rounds: z.number().int().positive() })),
      armour: z.object({ price: Price, amount: z.number().positive() }),
      /** A weapon you have bought before (or unlocked) costs this share of its price to buy again. */
      rebuyFraction: z.number().min(0).max(1),
    })
    .default({ weapons: {}, ammo: {}, armour: { price: 250, amount: 50 }, rebuyFraction: 0.5 }),
  clinic: z.object({ healPrice: Price }).default({ healPrice: 100 }),
  safehouses: z
    .object({
      /** Marker id to price. Safehouse markers missing here cost 5,000. */
      prices: z.record(z.string(), Price),
      /** Owned from a new game. */
      startOwned: z.array(z.string()),
      /** An owned safehouse nearer than the nearest clinic is where you wake after FLATLINED. */
      respawn: z.boolean(),
    })
    .default({ prices: {}, startOwned: [], respawn: true }),
  cyberware: z
    .object({
      reflex: z.object({
        name: z.string(),
        blurb: z.string(),
        price: Price,
        /** Simulated seconds of slow motion after a dodge. */
        slowSec: z.number().nonnegative(),
        /** Speed of time while it lasts (the app scales the fixed-step clock). */
        timeScale: z.number().positive().max(1),
        /** Damage immunity from the start of the dodge. */
        iframeSec: z.number().nonnegative(),
      }),
      plating: z.object({ name: z.string(), blurb: z.string(), price: Price, armourBonus: z.number().nonnegative() }),
      ghost: z.object({ name: z.string(), blurb: z.string(), price: Price, heatMul: z.number().positive().max(1) }),
    })
    .default({
      reflex: { name: 'Reflex', blurb: '', price: 5000, slowSec: 0.7, timeScale: 0.4, iframeSec: 0.6 },
      plating: { name: 'Plating', blurb: '', price: 4000, armourBonus: 50 },
      ghost: { name: 'Ghost', blurb: '', price: 7500, heatMul: 0.65 },
    }),
  exports: z
    .object({
      listSize: z.number().int().min(1).max(8),
      /** Health fraction below which a chop shop turns a car away. */
      minCondition: z.number().min(0).max(1),
      /** Share of the class price paid for a car at exactly minCondition (full price at full health). */
      conditionFloor: z.number().min(0).max(1),
      excludeClasses: z.array(z.string()),
      classPrice: z.record(z.string(), Price),
    })
    .default({ listSize: 4, minCondition: 0.5, conditionFloor: 0.6, excludeClasses: ['bus', 'emergency', 'police'], classPrice: {} }),
});
export type EconomyConfig = z.infer<typeof EconomyConfigSchema>;

/** A shop or service front: a map marker, which way it faces and what stands behind it. */
export interface ServiceSite {
  id: string;
  kind: ServiceKind;
  /** The pad: where you walk or drive in. */
  x: number;
  z: number;
  /** Unit vector from the pad towards the nearest road (the way the front faces). */
  fx: number;
  fz: number;
  /** Distance from the pad back to the building face behind it, or -1 when nothing stands there. */
  back: number;
  /** Width of that building face (along the street), 0 when there is none. */
  faceWidth: number;
  /** Driven into (respray, chop shop) rather than walked into. */
  drive: boolean;
}

const PREFIXES: [string, ServiceKind][] = [
  ['clinic', 'clinic'],
  ['precinct', 'precinct'],
  ['safehouse', 'safehouse'],
  ['respray', 'respray'],
  ['armsshop', 'arms'],
  ['chopshop', 'chopshop'],
];

/** Which service a marker id names, if any (`armsshop_2` -> arms). */
export function serviceKindOf(id: string): ServiceKind | null {
  for (const [p, k] of PREFIXES) if (id.startsWith(p)) return k;
  return null;
}

const siteCache = new WeakMap<MapContent, ServiceSite[]>();

/** Every service site on the map, in marker order. Cached per map. */
export function serviceSites(map: MapContent): ServiceSite[] {
  const hit = siteCache.get(map);
  if (hit) return hit;
  const g = cityGrid(map);
  const out: ServiceSite[] = [];
  const dirs: [number, number][] = [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ];
  for (const [id, m] of Object.entries(map.markers)) {
    const kind = serviceKindOf(id);
    if (!kind) continue;
    const x = m.pos[0];
    const z = m.pos[2];
    let fx = 0;
    let fz = 1;
    let best = Infinity;
    for (const [dx, dz] of dirs) {
      for (let d = 0.5; d < Math.min(best, 90); d += 0.5) {
        const c = g.at(x + dx * d, z + dz * d);
        if (c & Cell.building) break;
        if (c & Cell.road && !(c & Cell.alley)) {
          best = d;
          fx = dx;
          fz = dz;
          break;
        }
      }
    }
    let back = -1;
    let faceWidth = 0;
    for (let d = 0.5; d <= 12; d += 0.25) {
      const bx = x - fx * d;
      const bz = z - fz * d;
      if (!(g.at(bx, bz) & Cell.building)) continue;
      back = d;
      for (const b of map.buildings) {
        if (Math.abs(bx - b.x) <= b.w / 2 + 0.3 && Math.abs(bz - b.z) <= b.d / 2 + 0.3) {
          faceWidth = fx !== 0 ? b.d : b.w;
          break;
        }
      }
      break;
    }
    out.push({ id, kind, x, z, fx, fz, back, faceWidth, drive: kind === 'respray' || kind === 'chopshop' });
  }
  siteCache.set(map, out);
  return out;
}

export type BuyRefusal = 'broke' | 'owned' | 'full' | 'needWeapon' | 'unknown' | 'away' | 'job';

export interface BuyResult {
  ok: boolean;
  item: string;
  price: number;
  reason?: BuyRefusal;
}

/** One line in a shop panel. */
export interface Offer {
  /** `weapon:<id>`, `ammo:<id>`, `armour`, `heal`, `cyber:<id>`, `safehouse:<marker>`. */
  item: string;
  group: 'weapons' | 'ammo' | 'armour' | 'cyberware' | 'care' | 'property';
  name: string;
  detail: string;
  price: number;
  /** buy: can buy now; broke: cannot afford; owned: already have it; full: nothing to add; locked: needs something first. */
  state: 'buy' | 'broke' | 'owned' | 'full' | 'locked';
  /** Weapon id or cyberware id, for icons. */
  icon: string;
  /** A bought-before weapon at the rebuy price. */
  rebuy?: boolean;
}

export type ExportRefusal = 'notListed' | 'tooDamaged' | 'hot';

/** Events from the economy. */
export type EconomyEvent =
  | { type: 'shopOpen'; siteId: string; kind: ServiceKind }
  | { type: 'shopPad'; siteId: string; kind: ServiceKind; entered: boolean }
  | { type: 'purchase'; item: string; price: number }
  | { type: 'safehouseEntered'; siteId: string; healed: boolean }
  | { type: 'safehouseForSale'; siteId: string; price: number }
  | { type: 'exportDelivered'; variant: string; price: number; condition: number }
  | { type: 'exportRefused'; variant: string; reason: ExportRefusal }
  | { type: 'reflex'; seconds: number };

/** What the save keeps of the economy. */
export interface EconomyState {
  unlocks: readonly string[];
  cyberware: readonly string[];
  exportList: readonly string[];
  exportsDelivered: number;
}

export class EconomySystem {
  readonly sites: ServiceSite[];
  /** `safehouse:<marker>`, `weapon:<id>` and any other unlocks from the save or missions. */
  readonly unlocks = new Set<string>();
  readonly cyberware = new Set<CyberwareId>();
  /** Variant ids the chop shops want now. */
  exportList: string[] = [];
  exportsDelivered = 0;
  /** Set by the mission director while a job runs: resprays go on the crew's tab and the chop shops stop buying. */
  jobActive = false;
  /** The site whose pad the player stands on (on foot), or null. */
  atSite: ServiceSite | null = null;
  /** Simulated seconds of Reflex slow motion left. */
  reflexTimer = 0;
  /** world.time until which the player cannot be hurt (Reflex). */
  iframeUntil = -1;
  private readonly inside: boolean[];
  private lastX = NaN;
  private lastZ = NaN;
  private readonly interactIds: string[];
  private readonly interactable: Interactable = { id: '', x: 0, z: 0, radius: 0, label: '' };

  constructor(
    private readonly world: World,
    public config: EconomyConfig,
  ) {
    this.sites = serviceSites(world.content.map);
    this.inside = this.sites.map(() => false);
    this.interactIds = this.sites.map((s) => `shop:${s.id}`);
    for (const id of config.safehouses.startOwned) this.unlocks.add(`safehouse:${id}`);
    this.exportList = this.rollExports();
  }

  // ------------------------------------------------------------- state

  /** Restore from the save (unlocks, cyberware, export list). Start-owned safehouses are always owned. */
  restore(s: Partial<EconomyState>): void {
    this.unlocks.clear();
    for (const id of this.config.safehouses.startOwned) this.unlocks.add(`safehouse:${id}`);
    for (const u of s.unlocks ?? []) this.unlocks.add(u);
    this.cyberware.clear();
    for (const c of s.cyberware ?? []) if ((CYBERWARE as readonly string[]).includes(c)) this.cyberware.add(c as CyberwareId);
    this.exportsDelivered = s.exportsDelivered ?? 0;
    const pool = this.exportPool();
    const list = (s.exportList ?? []).filter((v) => pool.includes(v));
    this.exportList = list.length ? list.slice(0, this.config.exports.listSize) : this.rollExports();
    while (this.exportList.length < Math.min(this.config.exports.listSize, pool.length)) this.exportList.push(this.pickExport(this.exportList.length));
    this.applyCyberware();
  }

  /** Add unlocks granted elsewhere (mission rewards). */
  grant(unlocks: readonly string[]): void {
    for (const u of unlocks) this.unlocks.add(u);
  }

  state(): EconomyState {
    return { unlocks: [...this.unlocks], cyberware: [...this.cyberware], exportList: [...this.exportList], exportsDelivered: this.exportsDelivered };
  }

  owns(siteId: string): boolean {
    return this.unlocks.has(`safehouse:${siteId}`);
  }

  safehousePrice(siteId: string): number {
    return this.config.safehouses.prices[siteId] ?? 5000;
  }

  /** Extra armour capacity from Plating. */
  get armourBonus(): number {
    return this.cyberware.has('plating') ? this.config.cyberware.plating.armourBonus : 0;
  }

  /** Speed of time for the app's fixed-step clock (Reflex slow motion), 1 normally. */
  get timeScale(): number {
    return this.reflexTimer > 0 ? this.config.cyberware.reflex.timeScale : 1;
  }

  private applyCyberware(): void {
    this.world.heat.gainMul = this.cyberware.has('ghost') ? this.config.cyberware.ghost.heatMul : 1;
    const pc = this.world.playerCtl;
    if (pc.armour > pc.maxArmour) pc.armour = pc.maxArmour;
  }

  private get credits(): number {
    return this.world.score.credits;
  }

  private pay(price: number): boolean {
    if (this.world.score.credits < price) return false;
    this.world.score.credits -= price;
    return true;
  }

  // ------------------------------------------------------------- hooks from the player

  /** The player dodged: Reflex slows time and gives a moment of immunity. */
  onDodge(): void {
    if (!this.cyberware.has('reflex')) return;
    const r = this.config.cyberware.reflex;
    this.iframeUntil = this.world.time + r.iframeSec;
    this.reflexTimer = r.slowSec;
    this.world.events.push({ type: 'reflex', seconds: r.slowSec });
  }

  /** True while Reflex makes the player untouchable. */
  get invulnerable(): boolean {
    return this.world.time < this.iframeUntil;
  }

  /**
   * Where to wake after FLATLINED: the nearest owned safehouse if it is nearer
   * than the nearest clinic, else null (the clinic).
   */
  respawnPoint(x: number, z: number, clinicPrefix: string): { x: number; z: number } | null {
    if (!this.config.safehouses.respawn) return null;
    const clinic = this.world.survival.nearestMarker(clinicPrefix, x, z);
    const dClinic = Math.hypot(clinic.x - x, clinic.z - z);
    let best: ServiceSite | null = null;
    let bd = dClinic;
    for (const s of this.sites) {
      if (s.kind !== 'safehouse' || !this.owns(s.id)) continue;
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best ? { x: best.x, z: best.z } : null;
  }

  // ------------------------------------------------------------- shops

  /** Lines for a shop panel at this kind of site. */
  offers(kind: ServiceKind): Offer[] {
    const w = this.world;
    const c = this.config;
    const out: Offer[] = [];
    const cr = this.credits;
    const st = (price: number, other?: Offer['state']): Offer['state'] => other ?? (cr >= price ? 'buy' : 'broke');
    if (kind === 'arms') {
      for (const id of w.content.weapons.order) {
        const def = c.arms.weapons[id];
        const wd = w.content.weapons.weapons[id];
        if (!def || !wd) continue;
        const rebuy = this.unlocks.has(`weapon:${id}`);
        const price = this.weaponPrice(id);
        out.push({
          item: `weapon:${id}`,
          group: 'weapons',
          name: wd.name,
          detail: wd.ammoMax > 0 ? `${wd.kind === 'melee' ? 'Melee' : `${def.ammo} rounds included`}` : 'Melee',
          price,
          state: st(price, w.combat.has(id) ? 'owned' : undefined),
          icon: id,
          rebuy,
        });
      }
      for (const id of w.content.weapons.order) {
        const a = c.arms.ammo[id];
        const wd = w.content.weapons.weapons[id];
        if (!a || !wd || wd.ammoMax <= 0) continue;
        const has = w.combat.has(id);
        const full = has && w.combat.ammoOf(id) >= wd.ammoMax;
        out.push({
          item: `ammo:${id}`,
          group: 'ammo',
          name: `${wd.short} ammo`,
          detail: has ? `+${a.rounds} · ${w.combat.ammoOf(id)}/${wd.ammoMax}` : `+${a.rounds} · buy the ${wd.name.toLowerCase()} first`,
          price: a.price,
          state: st(a.price, !has ? 'locked' : full ? 'full' : undefined),
          icon: id,
        });
      }
      const pc = w.playerCtl;
      out.push({
        item: 'armour',
        group: 'armour',
        name: 'Armour vest',
        detail: `+${c.arms.armour.amount} · ${Math.round(pc.armour)}/${pc.maxArmour}`,
        price: c.arms.armour.price,
        state: st(c.arms.armour.price, pc.armour >= pc.maxArmour ? 'full' : undefined),
        icon: 'armour',
      });
    } else if (kind === 'clinic') {
      const pc = w.playerCtl;
      out.push({
        item: 'heal',
        group: 'care',
        name: 'Patch up',
        detail: `Full health · ${Math.round(pc.hp)}/${pc.maxHp}`,
        price: c.clinic.healPrice,
        state: st(c.clinic.healPrice, pc.hp >= pc.maxHp ? 'full' : undefined),
        icon: 'heal',
      });
      for (const id of CYBERWARE) {
        const cw = c.cyberware[id];
        out.push({ item: `cyber:${id}`, group: 'cyberware', name: cw.name, detail: cw.blurb, price: cw.price, state: st(cw.price, this.cyberware.has(id) ? 'owned' : undefined), icon: id });
      }
    } else if (kind === 'safehouse') {
      for (const s of this.sites) {
        if (s.kind !== 'safehouse') continue;
        const price = this.safehousePrice(s.id);
        out.push({ item: `safehouse:${s.id}`, group: 'property', name: s.id, detail: '', price, state: st(price, this.owns(s.id) ? 'owned' : undefined), icon: 'safehouse' });
      }
    }
    return out;
  }

  /** What a weapon costs now: full price, or the rebuy price once unlocked. */
  weaponPrice(id: string): number {
    const def = this.config.arms.weapons[id];
    if (!def) return 0;
    return this.unlocks.has(`weapon:${id}`) ? Math.round((def.price * this.config.arms.rebuyFraction) / 10) * 10 : def.price;
  }

  /**
   * Buy something. Shop items need the player on the matching pad (`at` to
   * override, for tests and the panel's own checks). Pure sim: the app saves.
   */
  buy(item: string, at: ServiceKind | null = this.atSite?.kind ?? null): BuyResult {
    const w = this.world;
    const c = this.config;
    const [kind, id = ''] = item.split(':') as [string, string | undefined];
    const refuse = (reason: BuyRefusal, price = 0): BuyResult => ({ ok: false, item, price, reason });
    const done = (price: number): BuyResult => {
      w.events.push({ type: 'purchase', item, price });
      return { ok: true, item, price };
    };
    const need = (k: ServiceKind): boolean => at === k;
    switch (kind) {
      case 'weapon': {
        const def = c.arms.weapons[id];
        if (!def || !w.content.weapons.weapons[id]) return refuse('unknown');
        if (!need('arms')) return refuse('away');
        if (w.combat.has(id)) return refuse('owned');
        const price = this.weaponPrice(id);
        if (!this.pay(price)) return refuse('broke', price);
        w.combat.give(id, def.ammo);
        this.unlocks.add(`weapon:${id}`);
        return done(price);
      }
      case 'ammo': {
        const a = c.arms.ammo[id];
        const wd = w.content.weapons.weapons[id];
        if (!a || !wd) return refuse('unknown');
        if (!need('arms')) return refuse('away');
        if (!w.combat.has(id)) return refuse('needWeapon', a.price);
        if (w.combat.ammoOf(id) >= wd.ammoMax) return refuse('full', a.price);
        if (!this.pay(a.price)) return refuse('broke', a.price);
        w.combat.give(id, a.rounds);
        return done(a.price);
      }
      case 'armour': {
        if (!need('arms')) return refuse('away');
        const pc = w.playerCtl;
        const a = c.arms.armour;
        if (pc.armour >= pc.maxArmour) return refuse('full', a.price);
        if (!this.pay(a.price)) return refuse('broke', a.price);
        pc.armour = Math.min(pc.maxArmour, pc.armour + a.amount);
        return done(a.price);
      }
      case 'heal': {
        if (!need('clinic')) return refuse('away');
        const pc = w.playerCtl;
        const price = c.clinic.healPrice;
        if (pc.hp >= pc.maxHp) return refuse('full', price);
        if (!this.pay(price)) return refuse('broke', price);
        pc.hp = pc.maxHp;
        return done(price);
      }
      case 'cyber': {
        if (!(CYBERWARE as readonly string[]).includes(id)) return refuse('unknown');
        if (!need('clinic')) return refuse('away');
        const cid = id as CyberwareId;
        const price = c.cyberware[cid].price;
        if (this.cyberware.has(cid)) return refuse('owned', price);
        if (!this.pay(price)) return refuse('broke', price);
        this.cyberware.add(cid);
        this.applyCyberware();
        return done(price);
      }
      case 'safehouse': {
        const site = this.sites.find((s) => s.kind === 'safehouse' && s.id === id);
        if (!site) return refuse('unknown');
        if (this.atSite !== site && at !== 'safehouse') return refuse('away');
        const price = this.safehousePrice(id);
        if (this.owns(id)) return refuse('owned', price);
        if (!this.pay(price)) return refuse('broke', price);
        this.unlocks.add(`safehouse:${id}`);
        const r = done(price);
        this.enterSafehouse(site);
        return r;
      }
      default:
        return refuse('unknown');
    }
  }

  private enterSafehouse(site: ServiceSite): void {
    const pc = this.world.playerCtl;
    const healed = pc.hp < pc.maxHp;
    pc.hp = pc.maxHp;
    this.world.events.push({ type: 'safehouseEntered', siteId: site.id, healed });
  }

  // ------------------------------------------------------------- respray

  /** Respray the player's car now: charge, repaint, repair, clear HEAT. The 'respray' event says how it went. */
  respray(): void {
    const w = this.world;
    const pv = w.player.vehicle;
    if (!pv) return;
    const heat = w.heat;
    const rules = w.content.heat.respray;
    const price = this.jobActive ? 0 : this.config.respray.price;
    const push = (result: 'cleared' | 'clean' | 'seen' | 'tooHot' | 'broke', paid: number): void => {
      w.events.push({ type: 'respray', result, price: paid });
    };
    if (heat.level > rules.maxLevel) return push('tooHot', 0);
    if (heat.level > 0 && w.police.sinceSeen < rules.unseenSec) return push('seen', 0);
    if (!this.pay(price)) return push('broke', price);
    // A new colour: the first paint seed past the current one that rolls a different paint.
    const before = paintIndex(w, pv.variantId, pv.paintSeed);
    let seed = pv.paintSeed;
    for (let k = 1; k <= 24; k++) {
      seed = (pv.paintSeed + k * 7919) | 0;
      if (paintIndex(w, pv.variantId, seed) !== before) break;
    }
    pv.paintSeed = seed;
    pv.hp = pv.params.maxHealth;
    const result = w.police.respray();
    push(result === 'cleared' ? 'cleared' : 'clean', price);
  }

  // ------------------------------------------------------------- exports

  /** Civilian variants a chop shop can ask for. */
  exportPool(): string[] {
    const ex = this.config.exports;
    const out: string[] = [];
    for (const [id, p] of Object.entries(this.world.content.vehicles.variants)) {
      if (p.role !== 'civilian' || ex.excludeClasses.includes(p.class)) continue;
      if (!(p.class in ex.classPrice)) continue;
      out.push(id);
    }
    return out;
  }

  /** What a variant fetches at a health fraction (0 below the minimum condition). */
  exportPrice(variantId: string, condition: number): number {
    const ex = this.config.exports;
    const p = this.world.content.vehicles.variants[variantId];
    if (!p) return 0;
    const base = ex.classPrice[p.class as VehicleClass] ?? 0;
    if (condition < ex.minCondition) return 0;
    const t = ex.minCondition >= 1 ? 1 : (condition - ex.minCondition) / (1 - ex.minCondition);
    return Math.round((base * (ex.conditionFloor + (1 - ex.conditionFloor) * Math.min(1, t))) / 10) * 10;
  }

  private rollExports(): string[] {
    const list: string[] = [];
    const n = Math.min(this.config.exports.listSize, this.exportPool().length);
    for (let i = 0; i < n; i++) list.push(this.pickExport(i, list));
    return list;
  }

  /** A seeded pick that is not already on the list (own RNG: the world's sequence is untouched). */
  private pickExport(slot: number, list: readonly string[] = this.exportList): string {
    const pool = this.exportPool().filter((v) => !list.includes(v));
    if (!pool.length) return this.exportPool()[0] ?? '';
    const rng = new Rng((this.world.seed * 7919) ^ (this.exportsDelivered * 104729 + slot * 31 + 17));
    return rng.pick(pool);
  }

  private deliver(): void {
    const w = this.world;
    const v = w.player.vehicle;
    if (!v || v.destroyed) return;
    const idx = this.exportList.indexOf(v.variantId);
    if (idx < 0) {
      w.events.push({ type: 'exportRefused', variant: v.variantId, reason: 'notListed' });
      return;
    }
    if (w.heat.level > 0) {
      w.events.push({ type: 'exportRefused', variant: v.variantId, reason: 'hot' });
      return;
    }
    const condition = w.vehicleHealth(v);
    const price = this.exportPrice(v.variantId, condition);
    if (price <= 0) {
      w.events.push({ type: 'exportRefused', variant: v.variantId, reason: 'tooDamaged' });
      return;
    }
    w.score.credits += price;
    w.playerCtl.exit();
    w.despawnVehicle(v);
    this.exportsDelivered++;
    const rest = this.exportList.filter((_, i) => i !== idx);
    this.exportList.splice(idx, 1, this.pickExport(idx, rest));
    w.events.push({ type: 'exportDelivered', variant: v.variantId, price, condition });
  }

  // ------------------------------------------------------------- step

  step(dt: number): void {
    const w = this.world;
    if (this.reflexTimer > 0) this.reflexTimer = Math.max(0, this.reflexTimer - dt);
    const pc = w.playerCtl;
    const pv = w.player.vehicle;
    const alive = w.survival.alive && !pc.incapacitated;
    const px = w.player.x;
    const pz = w.player.z;
    // A teleport (respawn, checkpoint) onto a pad never counts as walking in.
    const jumped = !(Math.hypot(px - this.lastX, pz - this.lastZ) < 3);
    this.lastX = px;
    this.lastZ = pz;
    const c = this.config;
    // Button presses on a pad (the context button) arrive as interact events.
    for (let i = 0; i < w.events.length; i++) {
      const e = w.events[i]!;
      if (e.type !== 'interact' || !e.id.startsWith('shop:')) continue;
      const site = this.sites.find((s) => `shop:${s.id}` === e.id);
      if (site && alive) this.use(site);
    }
    this.atSite = null;
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i]!;
      let now = false;
      if (alive) {
        if (s.drive) now = !!pv && Math.abs(forwardSpeed(pv)) <= c.carPad.maxSpeed && Math.hypot(pv.x - s.x, pv.z - s.z) < c.carPad.radius;
        else now = !pv && Math.hypot(pc.x - s.x, pc.z - s.z) <= c.padRadius;
      }
      if (now && !s.drive) this.atSite = s;
      const was = this.inside[i]!;
      this.inside[i] = now;
      if (now === was || jumped) continue;
      if (!s.drive && s.kind !== 'precinct') w.events.push({ type: 'shopPad', siteId: s.id, kind: s.kind, entered: now });
      if (now) this.arrive(s);
    }
    this.syncInteractables();
  }

  /** Walked or drove onto a pad. */
  private arrive(s: ServiceSite): void {
    const w = this.world;
    switch (s.kind) {
      case 'respray':
        this.respray();
        break;
      case 'chopshop':
        if (!this.jobActive) this.deliver();
        break;
      case 'arms':
      case 'clinic':
        w.events.push({ type: 'shopOpen', siteId: s.id, kind: s.kind });
        break;
      case 'safehouse':
        if (this.owns(s.id)) this.enterSafehouse(s);
        else w.events.push({ type: 'safehouseForSale', siteId: s.id, price: this.safehousePrice(s.id) });
        break;
      default:
        break;
    }
  }

  /** The context button on a pad. */
  private use(s: ServiceSite): void {
    if (s.kind === 'arms' || s.kind === 'clinic') this.world.events.push({ type: 'shopOpen', siteId: s.id, kind: s.kind });
    else if (s.kind === 'safehouse') {
      if (this.owns(s.id)) this.enterSafehouse(s);
      else this.buy(`safehouse:${s.id}`, 'safehouse');
    }
  }

  /** Keep one context-button entry for the pad the player stands on (reused: no allocation per step). */
  private syncInteractables(): void {
    const list = this.world.interactables;
    const s = this.atSite && this.atSite.kind !== 'precinct' ? this.atSite : null;
    const it = this.interactable;
    const i = list.indexOf(it);
    if (!s) {
      if (i >= 0) list.splice(i, 1);
      return;
    }
    it.id = this.interactIds[this.sites.indexOf(s)]!;
    it.x = s.x;
    it.z = s.z;
    it.radius = this.config.padRadius + 0.3;
    it.label = s.kind === 'safehouse' ? (this.owns(s.id) ? 'REST' : 'BUY') : s.kind === 'clinic' ? 'CLINIC' : 'SHOP';
    if (i < 0) list.push(it);
  }
}

function paintIndex(w: World, variantId: string, seed: number): string {
  return paintFor(w.content.vehicles, variantId, seed);
}
