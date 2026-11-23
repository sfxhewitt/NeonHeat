import { appPoint, appSize } from './screen';
import type { DriveScheme } from '@neonheat/sim';
import type { ControlMode } from './input';

export interface TouchState {
  active: boolean;
  scheme: DriveScheme;
  moveX: number;
  moveY: number;
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
  fire: boolean;
  interact: boolean;
  dodge: boolean;
  nextWeapon: boolean;
  /** The side-activity button (taxi duty, race, end shift). */
  activity: boolean;
}

const LAYOUT_KEY = 'neonheat.touchLayout.v1';
const STICK_RADIUS = 64;

type ButtonId = 'handbrake' | 'fire' | 'dodge' | 'context' | 'left' | 'right' | 'gas' | 'brake' | 'weapon' | 'driveby' | 'activity';

interface ButtonDef {
  id: ButtonId;
  label: string;
  /** Default position as % of the viewport from the right/left and bottom. */
  side: 'left' | 'right';
  x: number;
  y: number;
  size: number;
  modes: ControlMode[];
  scheme?: DriveScheme;
  /** Edge-triggered rather than held. */
  tap?: boolean;
}

const BUTTONS: ButtonDef[] = [
  { id: 'handbrake', label: 'DRIFT', side: 'right', x: 4, y: 8, size: 84, modes: ['driving'] },
  { id: 'gas', label: 'GAS', side: 'right', x: 18, y: 6, size: 84, modes: ['driving'], scheme: 'classic' },
  { id: 'brake', label: 'BRAKE', side: 'right', x: 18, y: 28, size: 68, modes: ['driving'], scheme: 'classic' },
  { id: 'left', label: '◀', side: 'left', x: 4, y: 8, size: 84, modes: ['driving'], scheme: 'classic' },
  { id: 'right', label: '▶', side: 'left', x: 17, y: 8, size: 84, modes: ['driving'], scheme: 'classic' },
  { id: 'fire', label: 'FIRE', side: 'right', x: 4, y: 8, size: 92, modes: ['foot'] },
  { id: 'dodge', label: 'ROLL', side: 'right', x: 18, y: 6, size: 64, modes: ['foot'], tap: true },
  { id: 'context', label: '', side: 'right', x: 6, y: 40, size: 76, modes: ['driving', 'foot'], tap: true },
  { id: 'weapon', label: 'WPN', side: 'right', x: 4, y: 58, size: 56, modes: ['driving', 'foot'], tap: true },
  { id: 'driveby', label: 'SHOOT', side: 'right', x: 30, y: 8, size: 64, modes: ['driving'] },
  { id: 'activity', label: '', side: 'right', x: 17, y: 42, size: 60, modes: ['driving'], tap: true },
];

/**
 * Touch controls: a floating left stick plus buttons on the right. Buttons are
 * at least 48 dp and can be repositioned in layout edit mode.
 */
export class TouchControls {
  readonly root: HTMLElement;
  scheme: DriveScheme;
  private mode: ControlMode = 'driving';
  private context: string | null = null;
  private activity: string | null = null;
  /** Weapon in hand (short name) and whether it can be fired from a car. */
  private weaponLabel = '';
  private driveBy = false;
  private readonly stickZone: HTMLElement;
  private readonly stickBase: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stick = { x: 0, y: 0 };
  private readonly held = new Map<ButtonId, number>();
  private readonly taps = new Set<ButtonId>();
  private readonly els = new Map<ButtonId, HTMLElement>();
  private layout: Partial<Record<ButtonId, { x: number; y: number }>> = {};
  editing = false;

  constructor(parent: HTMLElement, scheme: DriveScheme) {
    this.scheme = scheme;
    this.root = document.createElement('div');
    this.root.className = 'nh-touch';
    this.stickZone = div('nh-touch__zone');
    this.stickBase = div('nh-touch__stick');
    this.stickKnob = div('nh-touch__knob');
    this.stickBase.appendChild(this.stickKnob);
    // A faint resting ring shows where the thumb goes before the first touch.
    const rest = div('nh-touch__rest');
    rest.appendChild(div('nh-touch__rest-knob'));
    this.root.append(this.stickZone, rest, this.stickBase);
    parent.appendChild(this.root);
    try {
      this.layout = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as typeof this.layout;
    } catch {
      this.layout = {};
    }

    for (const def of BUTTONS) {
      const el = div(`nh-btn nh-btn--${def.id}`);
      el.textContent = def.label;
      el.style.width = el.style.height = `${def.size}px`;
      this.place(el, def);
      this.root.appendChild(el);
      this.els.set(def.id, el);
      this.bindButton(el, def);
    }

    this.stickZone.addEventListener('pointerdown', (e) => {
      if (this.stickId !== null || this.editing) return;
      this.markTouch(e);
      this.stickId = e.pointerId;
      this.stickZone.setPointerCapture(e.pointerId);
      const p = appPoint(e.clientX, e.clientY);
      this.stickOrigin = { x: p.x, y: p.y };
      this.stickBase.style.left = `${p.x}px`;
      this.stickBase.style.top = `${p.y}px`;
      this.stickBase.classList.add('is-active');
      this.root.classList.add('is-sticking');
      this.moveStick(p.x, p.y);
    });
    this.stickZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickId) return;
      const p = appPoint(e.clientX, e.clientY);
      this.moveStick(p.x, p.y);
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.stick = { x: 0, y: 0 };
      this.stickKnob.style.transform = 'translate(-50%, -50%)';
      this.stickBase.classList.remove('is-active');
      this.root.classList.remove('is-sticking');
    };
    this.stickZone.addEventListener('pointerup', end);
    this.stickZone.addEventListener('pointercancel', end);
    this.refresh();
  }

  private markTouch(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') {
      this.root.classList.add('is-touch');
    }
  }

  private moveStick(x: number, y: number): void {
    let dx = x - this.stickOrigin.x;
    let dy = y - this.stickOrigin.y;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RADIUS) {
      // Floating stick: drag the origin along so it never feels stuck.
      const over = len - STICK_RADIUS;
      this.stickOrigin.x += (dx / len) * over;
      this.stickOrigin.y += (dy / len) * over;
      this.stickBase.style.left = `${this.stickOrigin.x}px`;
      this.stickBase.style.top = `${this.stickOrigin.y}px`;
      dx = x - this.stickOrigin.x;
      dy = y - this.stickOrigin.y;
    }
    this.stick = { x: dx / STICK_RADIUS, y: -dy / STICK_RADIUS };
    this.stickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  private bindButton(el: HTMLElement, def: ButtonDef): void {
    let drag: { id: number; sx: number; sy: number; ox: number; oy: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      if (this.editing) {
        const pos = this.layout[def.id] ?? { x: def.x, y: def.y };
        const p = appPoint(e.clientX, e.clientY);
        drag = { id: e.pointerId, sx: p.x, sy: p.y, ox: pos.x, oy: pos.y };
        return;
      }
      this.markTouch(e);
      this.held.set(def.id, e.pointerId);
      if (def.tap) this.taps.add(def.id);
      el.classList.add('is-down');
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const size = appSize();
      const w = size.width / 100;
      const h = size.height / 100;
      const p = appPoint(e.clientX, e.clientY);
      const dirX = def.side === 'right' ? -1 : 1;
      const x = clamp(drag.ox + ((p.x - drag.sx) / w) * dirX, 0, 90);
      const y = clamp(drag.oy - (p.y - drag.sy) / h, 0, 85);
      this.layout[def.id] = { x, y };
      this.place(el, def);
    });
    const up = (): void => {
      if (drag) {
        drag = null;
        try {
          localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.layout));
        } catch {
          /* storage unavailable */
        }
      }
      this.held.delete(def.id);
      el.classList.remove('is-down');
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  private place(el: HTMLElement, def: ButtonDef): void {
    const pos = this.layout[def.id] ?? { x: def.x, y: def.y };
    el.style.left = el.style.right = '';
    el.style[def.side] = `calc(${pos.x / 100} * var(--app-w) + var(--nh-safe-${def.side === 'left' ? 'l' : 'r'}))`;
    el.style.bottom = `calc(${pos.y / 100} * var(--app-h) + var(--nh-safe-b))`;
  }

  resetLayout(): void {
    this.layout = {};
    try {
      localStorage.removeItem(LAYOUT_KEY);
    } catch {
      /* ignore */
    }
    for (const def of BUTTONS) this.place(this.els.get(def.id)!, def);
  }

  setEditing(on: boolean): void {
    this.editing = on;
    this.root.classList.toggle('is-editing', on);
    this.refresh();
  }

  setScheme(scheme: DriveScheme): void {
    this.scheme = scheme;
    this.refresh();
  }

  setMode(mode: ControlMode, context: string | null): void {
    if (mode === this.mode && context === this.context) return;
    this.mode = mode;
    this.context = context;
    this.refresh();
  }

  /** The side-activity button's label (TAXI DUTY, RACE, END SHIFT), or null to hide it. */
  setActivity(label: string | null): void {
    if (label === this.activity) return;
    this.activity = label;
    this.refresh();
  }

  /** Show the weapon in hand on the switch button; the drive-by button only appears for drive-by weapons. */
  setWeapon(label: string, driveBy: boolean): void {
    if (label === this.weaponLabel && driveBy === this.driveBy) return;
    this.weaponLabel = label;
    this.driveBy = driveBy;
    this.refresh();
  }

  private refresh(): void {
    this.root.classList.toggle('is-menu', this.mode === 'menu');
    const classic = this.mode === 'driving' && this.scheme === 'classic';
    this.stickZone.style.display = classic ? 'none' : '';
    for (const def of BUTTONS) {
      const el = this.els.get(def.id)!;
      let visible = def.modes.includes(this.mode) && (!def.scheme || def.scheme === this.scheme);
      if (def.id === 'context') {
        visible = visible && (this.context !== null || this.editing);
        el.textContent = this.context ?? 'ACTION';
      } else if (def.id === 'activity') {
        visible = visible && (this.activity !== null || this.editing);
        el.textContent = this.activity ?? 'ACTIVITY';
      } else if (def.id === 'weapon') {
        el.textContent = this.weaponLabel || def.label;
      } else if (def.id === 'driveby') {
        visible = visible && (this.driveBy || this.editing);
      }
      el.style.display = visible ? '' : 'none';
    }
  }

  read(): TouchState {
    const h = (id: ButtonId): boolean => this.held.has(id);
    const tap = (id: ButtonId): boolean => this.taps.delete(id);
    const classic = this.mode === 'driving' && this.scheme === 'classic';
    return {
      // A thumb held still sends no events, so a held stick or button stays live however long it is held.
      active: this.stickId !== null || this.held.size > 0,
      scheme: this.scheme,
      moveX: classic ? 0 : this.stick.x,
      moveY: classic ? 0 : this.stick.y,
      steer: (h('right') ? 1 : 0) - (h('left') ? 1 : 0),
      throttle: h('gas') ? 1 : 0,
      brake: h('brake') ? 1 : 0,
      handbrake: h('handbrake'),
      fire: h('fire') || h('driveby'),
      interact: tap('context'),
      dodge: tap('dodge'),
      nextWeapon: tap('weapon'),
      activity: tap('activity'),
    };
  }
}

function div(cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
