import type * as THREE from 'three';
import type { BuyResult, Offer, ServiceKind, SimEvent, World } from '@neonheat/sim';
import { ServicesView, type ServiceIcons } from '@neonheat/engine';
import { LANDMARK_STYLES, ShopPanel, type JobsView, type ShopView } from '@neonheat/ui';
import type { SaveData } from '@neonheat/save';
import type { Game } from './game';

const ICONS: ServiceIcons = {
  clinic: LANDMARK_STYLES.clinic.path,
  precinct: LANDMARK_STYLES.precinct.path,
  safehouse: LANDMARK_STYLES.safehouse.path,
  respray: LANDMARK_STYLES.respray.path,
  arms: LANDMARK_STYLES.arms.path,
  chopshop: LANDMARK_STYLES.chopshop.path,
};

const GROUPS: Record<string, string> = { weapons: 'Weapons', ammo: 'Ammo', armour: 'Armour', clinic: 'Clinic' };
/** The clinic is short enough for one page: care and cyberware together. */
const MERGE: Record<string, string> = { care: 'clinic', cyberware: 'clinic' };

const NOTES: Partial<Record<ServiceKind, string>> = {
  arms: 'Weapons go when you are flatlined or booked. Anything you have bought before comes back at a discount.',
  clinic: 'Cyberware stays with you for good, flatlined or not.',
};

const cr = (n: number): string => `${n.toLocaleString('en-GB')} cr`;

/**
 * The game-side half of the economy: the shop fronts in the world, the shop
 * panel, toasts for resprays, safehouses and exports, the save (what you
 * carry, cyberware, the export list) and Reflex slow motion. Kept out of
 * game.ts so the shared wiring stays small.
 */
export class EconomyLayer {
  readonly view: ServicesView;
  readonly panel: ShopPanel;
  private release: (() => void) | null = null;
  private unlockCount = -1;
  private labelsDone = false;

  constructor(
    private readonly game: Game,
    scene: THREE.Scene,
  ) {
    const w = this.world;
    const eco = w.content.economy;
    this.view = new ServicesView(scene, w.content.map, w.economy.sites, {
      brands: eco.brands,
      icons: ICONS,
      safehousePrices: Object.fromEntries(w.economy.sites.filter((s) => s.kind === 'safehouse').map((s) => [s.id, w.economy.safehousePrice(s.id)])),
      pitchDeg: game.content.camera.pitchDeg,
    });
    this.view.setOwned(this.ownedSafehouses());
    this.panel = new ShopPanel(game.overlay);
    // Sign text uses the bundled display font once it has loaded.
    void document.fonts?.load(`700 64px 'Chakra Petch'`).then(() => this.view.redraw(), () => undefined);
  }

  private get world(): World {
    return this.game.world;
  }

  /** Reflex slow motion: the app's fixed-step clock runs at this speed. */
  get timeScale(): number {
    return this.world.economy.timeScale;
  }

  // ------------------------------------------------------------------ save

  /** Load what the save says you own and carry into the world. */
  applySave(save: SaveData): void {
    const w = this.world;
    w.economy.restore({ unlocks: save.unlocks, cyberware: save.cyberware, exportList: save.exportList, exportsDelivered: save.stats.exportsDelivered });
    w.combat.resetLoadout(save.loadout ?? w.content.weapons.startLoadout);
    w.playerCtl.armour = Math.min(save.armour, w.playerCtl.maxArmour);
    w.score.credits = save.credits;
    this.unlockCount = save.unlocks.length;
    this.view.setOwned(this.ownedSafehouses());
  }

  /** Fold the live economy and loadout into the save just before it is written. */
  capture(s: SaveData): SaveData {
    const w = this.world;
    const eco = w.economy.state();
    const unlocks = [...s.unlocks];
    for (const u of eco.unlocks) if (!unlocks.includes(u)) unlocks.push(u);
    const loadout: Record<string, number> = {};
    w.content.weapons.order.forEach((id, i) => {
      if (w.combat.owned[i]) loadout[id] = w.combat.ammo[i]!;
    });
    return {
      ...s,
      credits: Math.max(0, Math.floor(w.score.credits)),
      unlocks,
      cyberware: [...eco.cyberware],
      exportList: [...eco.exportList],
      loadout,
      armour: Math.round(w.playerCtl.armour),
      stats: { ...s.stats, exportsDelivered: eco.exportsDelivered },
    };
  }

  private ownedSafehouses(): string[] {
    return this.world.economy.sites.filter((s) => s.kind === 'safehouse' && this.world.economy.owns(s.id)).map((s) => s.id);
  }

  private vibrate(ms: number): void {
    if (this.game.settings.vibration && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
  }

  private save(why: string): void {
    this.game.autosave(why);
  }

  // ------------------------------------------------------------------ events

  private toast(text: string, seconds = 2.2): void {
    this.game.hud.toast(text, performance.now(), seconds);
  }

  /** Returns true when the event was handled here. */
  onEvent(e: SimEvent): boolean {
    const w = this.world;
    const eco = w.content.economy;
    switch (e.type) {
      case 'shopOpen':
        this.openShop(e.kind);
        return true;
      case 'shopPad':
        return true;
      case 'purchase':
        this.game.saves.current.stats.creditsSpent += e.price;
        if (e.item.startsWith('safehouse:')) {
          this.toast(`HIDEOUT BOUGHT · −${cr(e.price)}`, 2.6);
          this.view.setOwned(this.ownedSafehouses());
          this.relabel();
        }
        return true;
      case 'safehouseEntered':
        this.toast(e.healed ? 'SAFE · PATCHED UP · GAME SAVED' : 'SAFE · GAME SAVED', 2.2);
        this.save('safehouse');
        return true;
      case 'safehouseForSale':
        this.toast(`HIDEOUT FOR SALE · ${cr(e.price)} · TAP BUY`, 3);
        return true;
      case 'exportDelivered':
        this.toast(`EXPORT DELIVERED · +${cr(e.price)}`, 3);
        this.vibrate(30);
        this.save('export');
        return true;
      case 'exportRefused': {
        const name = w.content.vehicles.variants[e.variant]?.name ?? 'That car';
        if (e.reason === 'notListed') this.toast(`${eco.brands.chopshop.name}: NOT ON THE LIST`, 2.4);
        else if (e.reason === 'tooDamaged') this.toast(`${name.toUpperCase()} IS TOO BATTERED`, 2.4);
        else this.toast('LOSE THE HEAT FIRST', 2.4);
        return true;
      }
      case 'respray': {
        const price = e.price ?? eco.respray.price;
        if (e.result === 'seen') this.toast('NOT WITH THEM WATCHING');
        else if (e.result === 'tooHot') this.toast('TOO HOT TO RESPRAY');
        else if (e.result === 'broke') this.toast(`RESPRAY ${cr(price)} · NOT ENOUGH CREDITS`, 2.6);
        else {
          const paid = price > 0 ? ` · −${cr(price)}` : " · ON THE CREW'S TAB";
          this.toast(e.result === 'cleared' ? `RESPRAYED · HEAT CLEARED${paid}` : `FRESH PAINT${paid}`, 2.6);
          this.vibrate(20);
        }
        return true;
      }
      case 'heat':
        // The respray toast already says the HEAT cleared.
        return e.reason === 'respray';
      case 'reflex':
        this.vibrate(12);
        return true;
      case 'playerRespawned':
        // A safehouse respawn reads differently from a clinic one; game.ts still snaps the camera.
        return false;
      default:
        return false;
    }
  }

  // ------------------------------------------------------------------ shop panel

  private openShop(kind: ServiceKind): void {
    const g = this.game;
    if (g.bot || this.panel.isOpen || g.flow.blocking) return;
    this.release = g.flow.hold();
    this.panel.open(this.shopView(kind), {
      onBuy: (item) => {
        const r = this.world.economy.buy(item, kind);
        if (r.ok) g.sound.audio.ui('pickup');
        if (r.ok) this.save('purchase');
        return { view: this.shopView(kind), ok: r.ok, message: this.message(r, kind) };
      },
      onClose: () => {
        const rel = this.release;
        this.release = null;
        rel?.();
      },
    });
  }

  private shopView(kind: ServiceKind): ShopView {
    const w = this.world;
    const b = w.content.economy.brands[kind];
    const offers: Offer[] = w.economy.offers(kind);
    const groupOf = (g: string): string => MERGE[g] ?? g;
    const groups = [...new Set(offers.map((o) => groupOf(o.group)))].map((id) => ({ id, label: GROUPS[id] ?? id }));
    return {
      title: b.name,
      tagline: b.tagline,
      colour: b.colour,
      glyph: ICONS[kind],
      credits: Math.floor(w.score.credits),
      groups,
      items: offers.map((o) => ({ item: o.item, group: groupOf(o.group), name: o.name, detail: o.detail, price: o.price, state: o.state, icon: o.icon, rebuy: o.rebuy })),
      note: NOTES[kind],
    };
  }

  private message(r: BuyResult, kind: ServiceKind): string {
    const name = this.world.economy.offers(kind).find((o) => o.item === r.item)?.name ?? 'It';
    if (r.ok) return `${name} · −${cr(r.price)}`;
    switch (r.reason) {
      case 'broke':
        return `Not enough credits: ${name} costs ${cr(r.price)}.`;
      case 'owned':
        return `You already have the ${name.toLowerCase()}.`;
      case 'full':
        return 'Already full.';
      case 'needWeapon':
        return 'Buy the weapon first.';
      case 'away':
        return 'Step back onto the shop pad.';
      default:
        return 'Not for sale.';
    }
  }

  // ------------------------------------------------------------------ per frame

  update(): void {
    const w = this.world;
    this.view.update(w.time);
    // Unlocks granted by a finished job (applyMissionResult writes them to the save).
    const save = this.game.saves.current;
    if (save.unlocks.length !== this.unlockCount) {
      this.unlockCount = save.unlocks.length;
      w.economy.grant(save.unlocks);
      this.view.setOwned(this.ownedSafehouses());
      this.relabel();
    }
    if (!this.labelsDone) this.labelMap();
  }

  /** Name the shops on the maps (and say which hideouts are yours). */
  private labelMap(): void {
    const geom = this.game.flow.mapGeometry;
    if (!geom) return;
    const w = this.world;
    const brands = w.content.economy.brands;
    const kindOf: Record<string, ServiceKind> = { clinic: 'clinic', precinct: 'precinct', safehouse: 'safehouse', respray: 'respray', arms: 'arms', chopshop: 'chopshop' };
    for (const l of geom.landmarks) {
      const k = kindOf[l.kind];
      if (!k) continue;
      const pretty = brands[k].name.charAt(0) + brands[k].name.slice(1).toLowerCase();
      if (k === 'safehouse') l.label = w.economy.owns(l.id) ? 'Your hideout' : `Hideout · ${cr(w.economy.safehousePrice(l.id))}`;
      else l.label = pretty.replace(/\b\w/g, (c) => c.toUpperCase());
    }
    this.labelsDone = true;
  }

  /** Mark the map labels stale (after buying a hideout). */
  relabel(): void {
    this.labelsDone = false;
  }

  /** The export list for the pause menu's Jobs tab. */
  exportsView(): Pick<JobsView, 'exports' | 'exportNote'> {
    const w = this.world;
    const eco = w.economy;
    const ex = w.content.economy.exports;
    return {
      exports: eco.exportList.map((id) => {
        const p = w.content.vehicles.variants[id]!;
        return { name: p.name, detail: p.class.charAt(0).toUpperCase() + p.class.slice(1), price: eco.exportPrice(id, 1) };
      }),
      exportNote: `Deliver one to a ${w.content.economy.brands.chopshop.name} yard (wrench on the map) with at least ${Math.round(ex.minCondition * 100)}% condition and no HEAT. Less damage, more cash.`,
    };
  }
}
