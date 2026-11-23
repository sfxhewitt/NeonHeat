import { WEAPON_ICONS } from './combat-hud';

/**
 * The shop panel: a full-screen, touch-first sheet for the arms shop, the
 * clinic (care and cyberware) and anything else that sells. The game pauses
 * behind it. Items sit in a scrolling grid of cards, each with an icon, a
 * name, one line of detail and a price button at least 48 px square. The
 * sim decides prices and states; the panel only shows them and reports taps.
 */

export interface ShopItemView {
  item: string;
  group: string;
  name: string;
  detail: string;
  price: number;
  /** buy, broke (cannot afford), owned, full, locked. */
  state: 'buy' | 'broke' | 'owned' | 'full' | 'locked';
  icon: string;
  /** Shown as a small "REBUY" tag: a weapon you have bought before, at a discount. */
  rebuy?: boolean;
}

export interface ShopView {
  title: string;
  tagline: string;
  colour: string;
  /** Glyph path (24×24) for the header badge. */
  glyph: string;
  credits: number;
  /** Tabs, in order. Groups with no items are left out. */
  groups: { id: string; label: string }[];
  items: ShopItemView[];
  /** A line under the header (e.g. what the clinic does). */
  note?: string;
}

export interface ShopHooks {
  /** A buy tap. Return the refreshed view and a message for the status line. */
  onBuy: (item: string) => { view: ShopView; ok: boolean; message: string };
  onClose: () => void;
}

/** Original item glyphs that are not weapons (24×24). */
export const SHOP_ICONS: Record<string, { path: string; colour: string }> = {
  armour: { path: 'M8 2h8l1.2 3L21 7v14.5H3V7l3.8-2zM9 8v9h6V8z', colour: '#3d9bff' },
  heal: { path: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z', colour: '#3dff8a' },
  ammo: { path: 'M5 10h3v11H5zM10.5 10h3v11h-3zM16 10h3v11h-3zM5 10l1.5-6L8 10zM10.5 10L12 4l1.5 6zM16 10l1.5-6L19 10z', colour: '#d7ff2b' },
  reflex: { path: 'M2 5h4l7 7-7 7H2l7-7zM11 5h4l7 7-7 7h-4l7-7z', colour: '#21f0ff' },
  plating: { path: 'M12 1.5l9 4v6.2c0 5.4-3.8 9.6-9 10.8-5.2-1.2-9-5.4-9-10.8V5.5zM12 5L6.5 7.4v4.3c0 3.4 2.3 6 5.5 7z', colour: '#ff9a3c' },
  ghost: { path: 'M12 4C6.5 4 2 12 2 12s4.5 8 10 8 10-8 10-8-4.5-8-10-8zm0 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM3 21L21 3l1 1L4 22z', colour: '#b98cff' },
  safehouse: { path: 'M12 2.5l9.5 8.5H18v10h-4.5v-6h-3v6H6V11H2.5z', colour: '#d7ff2b' },
};

function iconFor(item: ShopItemView): { path: string; colour: string } {
  if (item.group === 'ammo') return { path: SHOP_ICONS.ammo!.path, colour: WEAPON_ICONS[item.icon]?.colour ?? SHOP_ICONS.ammo!.colour };
  return WEAPON_ICONS[item.icon] ?? SHOP_ICONS[item.icon] ?? SHOP_ICONS.ammo!;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cr = (n: number): string => `${n.toLocaleString('en-GB')} cr`;

export class ShopPanel {
  private root: HTMLElement | null = null;
  private view: ShopView | null = null;
  private hooks: ShopHooks | null = null;
  private tab = '';
  private status = '';
  private statusTone: 'ok' | 'bad' | '' = '';
  private statusTimer = 0;
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  };

  constructor(private readonly parent: HTMLElement) {}

  get isOpen(): boolean {
    return this.root !== null;
  }

  open(view: ShopView, hooks: ShopHooks): void {
    this.close(false);
    this.view = view;
    this.hooks = hooks;
    this.tab = view.groups.find((g) => view.items.some((i) => i.group === g.id))?.id ?? '';
    this.status = view.note ?? '';
    this.statusTone = '';
    const el = document.createElement('div');
    el.className = 'nh-shop';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', view.title);
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => this.onClick(e));
    this.root = el;
    this.parent.appendChild(el);
    window.addEventListener('keydown', this.onKey);
    this.render();
    requestAnimationFrame(() => el.classList.add('is-in'));
  }

  /** Close the panel (`notify`: tell the game, which resumes). */
  close(notify = true): void {
    if (!this.root) return;
    this.root.remove();
    this.root = null;
    window.removeEventListener('keydown', this.onKey);
    window.clearTimeout(this.statusTimer);
    const h = this.hooks;
    this.hooks = null;
    this.view = null;
    if (notify) h?.onClose();
  }

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!t || !this.view || !this.hooks) return;
    const act = t.dataset.act;
    if (act === 'close') this.close();
    else if (act === 'tab') {
      this.tab = t.dataset.id ?? this.tab;
      this.render();
    } else if (act === 'buy') {
      const item = t.dataset.item ?? '';
      const r = this.hooks.onBuy(item);
      this.view = r.view;
      this.status = r.message;
      this.statusTone = r.ok ? 'ok' : 'bad';
      this.render(r.ok ? item : null);
      window.clearTimeout(this.statusTimer);
      this.statusTimer = window.setTimeout(() => {
        this.status = this.view?.note ?? '';
        this.statusTone = '';
        const s = this.root?.querySelector('.nh-shop__status');
        if (s) {
          s.textContent = this.status;
          s.className = 'nh-shop__status';
        }
      }, 2600);
    }
  }

  private render(flash: string | null = null): void {
    const v = this.view;
    const el = this.root;
    if (!v || !el) return;
    const groups = v.groups.filter((g) => v.items.some((i) => i.group === g.id));
    const items = v.items.filter((i) => i.group === this.tab);
    const scroll = el.querySelector('.nh-shop__grid')?.scrollTop ?? 0;
    el.style.setProperty('--sc', v.colour);
    el.innerHTML = `
      <div class="nh-shop__sheet">
        <header class="nh-shop__head">
          <div class="nh-shop__badge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${v.glyph}"/></svg></div>
          <div class="nh-shop__title"><h2>${esc(v.title)}</h2><small>${esc(v.tagline)}</small></div>
          <div class="nh-shop__credits" aria-label="Credits"><b>${v.credits.toLocaleString('en-GB')}</b><span>CR</span></div>
          <button type="button" class="nh-shop__close" data-act="close" aria-label="Close the shop"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.6L12 10.6 19 3.6 20.4 5 13.4 12l7 7-1.4 1.4-7-7-7 7L3.6 19l7-7-7-7z"/></svg></button>
        </header>
        <div class="nh-shop__body">
          ${
            groups.length > 1
              ? `<nav class="nh-shop__tabs" role="tablist">${groups
                  .map((g) => `<button type="button" role="tab" aria-selected="${g.id === this.tab}" class="${g.id === this.tab ? 'is-on' : ''}" data-act="tab" data-id="${esc(g.id)}">${esc(g.label)}</button>`)
                  .join('')}</nav>`
              : ''
          }
          <div class="nh-shop__grid">${items.map((i) => this.card(i, i.item === flash)).join('')}</div>
        </div>
        <footer class="nh-shop__status ${this.statusTone ? `is-${this.statusTone}` : ''}" aria-live="polite">${esc(this.status)}</footer>
      </div>`;
    const grid = el.querySelector('.nh-shop__grid');
    if (grid) grid.scrollTop = scroll;
  }

  private card(i: ShopItemView, flash: boolean): string {
    const ic = iconFor(i);
    const label =
      i.state === 'owned' ? 'OWNED' : i.state === 'full' ? 'FULL' : i.state === 'locked' ? cr(i.price) : `${i.price === 0 ? 'FREE' : cr(i.price)}`;
    const disabled = i.state === 'owned' || i.state === 'full' || i.state === 'locked';
    return `<div class="nh-shop__card is-${i.state}${flash ? ' is-flash' : ''}" style="--ic:${ic.colour}">
      <div class="nh-shop__icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ic.path}"/></svg></div>
      <div class="nh-shop__info"><b>${esc(i.name)}${i.rebuy && i.state !== 'owned' ? '<em>REBUY</em>' : ''}</b><small>${esc(i.detail)}</small></div>
      <button type="button" class="nh-shop__buy" data-act="buy" data-item="${esc(i.item)}" ${disabled ? 'disabled' : ''} aria-label="${esc(`${i.name}: ${label}`)}">${esc(label)}</button>
    </div>`;
  }
}
