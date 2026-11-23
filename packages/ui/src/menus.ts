import type { DriveScheme } from '@neonheat/sim';
import type { QualityTier, Settings } from './settings';

export interface SettingsMenuHooks {
  settings: Settings;
  onChange: (s: Settings) => void;
  onEditLayout: (on: boolean) => void;
  onResetLayout: () => void;
  onOpen?: () => void;
  onClose?: () => void;
  /** Extra buttons, e.g. "Restart mission". */
  extra?: () => { label: string; run: () => void }[];
  /** A live line about the device: tier, frame rate, resolution. */
  info?: () => string;
  /** Radio stations for the Sound section. */
  stations?: () => { name: string; frequency: string }[];
  /** Sound settings changed (volumes live while dragging, station, on/off). Falls back to onChange. */
  onSoundChange?: (s: Settings, final: boolean) => void;
  /** Any menu button pressed (for a UI blip). */
  onButton?: () => void;
}

/** The pause / settings menu behind the ☰ button. */
export class SettingsMenu {
  private readonly button: HTMLButtonElement;
  private modal: HTMLElement | null = null;
  private editing = false;
  private editDone: HTMLButtonElement | null = null;

  constructor(
    private readonly parent: HTMLElement,
    private readonly hooks: SettingsMenuHooks,
  ) {
    this.button = document.createElement('button');
    this.button.className = 'nh-menu-btn';
    this.button.type = 'button';
    this.button.setAttribute('aria-label', 'Menu');
    this.button.textContent = '☰';
    this.button.addEventListener('click', () => (this.modal ? this.close() : this.open()));
    parent.appendChild(this.button);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.modal) this.close();
        else this.open();
      }
    });
  }

  get isOpen(): boolean {
    return this.modal !== null;
  }

  open(): void {
    if (this.modal) return;
    this.hooks.onOpen?.();
    const s = this.hooks.settings;
    const m = document.createElement('div');
    m.className = 'nh-modal';
    m.innerHTML = `<div class="nh-modal__box"><h2>PAUSED</h2>
      <div class="nh-modal__row"><span>Touch steering</span><div class="nh-choice" data-k="scheme">
        <button data-v="direction">Direction</button><button data-v="classic">Classic</button></div></div>
      <div class="nh-modal__row"><span>Graphics</span><div class="nh-choice" data-k="quality">
        <button data-v="auto">Auto</button><button data-v="low">Low</button><button data-v="mid">Mid</button><button data-v="high">High</button><button data-v="ultra">Max</button></div></div>
      <div class="nh-modal__row"><span>Frame rate</span><div class="nh-choice" data-k="perf">
        <button data-v="true">Show</button><button data-v="false">Hide</button></div></div>
      <div class="nh-modal__info" data-info></div>
      <div class="nh-modal__row"><span>Vibration</span><div class="nh-choice" data-k="vibration">
        <button data-v="true">On</button><button data-v="false">Off</button></div></div>
      <div class="nh-modal__sub">SOUND</div>
      <div class="nh-modal__row"><span>Sound</span><div class="nh-choice" data-k="sound">
        <button data-v="true">On</button><button data-v="false">Off</button></div></div>
      <div class="nh-modal__row"><span>Master</span><input class="nh-slider" type="range" min="0" max="100" step="1" data-vol="masterVolume" aria-label="Master volume"></div>
      <div class="nh-modal__row"><span>Music</span><input class="nh-slider" type="range" min="0" max="100" step="1" data-vol="musicVolume" aria-label="Music volume"></div>
      <div class="nh-modal__row"><span>Effects</span><input class="nh-slider" type="range" min="0" max="100" step="1" data-vol="sfxVolume" aria-label="Effects volume"></div>
      <div class="nh-modal__row"><span>Radio</span><div class="nh-choice nh-choice--wrap" data-k="radioStation" data-stations></div></div>
      <button class="nh-wide" data-act="layout">Move touch buttons</button>
      <button class="nh-wide" data-act="reset">Reset touch layout</button>
      <div data-extra></div>
      <button class="nh-wide" data-act="resume">Resume</button></div>`;
    const stationsEl = m.querySelector('[data-stations]') as HTMLElement;
    const stations = this.hooks.stations?.() ?? [];
    if (stations.length === 0) stationsEl.closest('.nh-modal__row')?.remove();
    stations.forEach((st, i) => {
      const b = document.createElement('button');
      b.dataset.v = String(i);
      b.title = `${st.name} ${st.frequency}`;
      b.textContent = st.name.charAt(0) + st.name.slice(1).toLowerCase();
      stationsEl.appendChild(b);
    });
    const off = document.createElement('button');
    off.dataset.v = '-1';
    off.textContent = 'Off';
    stationsEl.appendChild(off);
    const sound = (final: boolean): void => {
      if (this.hooks.onSoundChange) this.hooks.onSoundChange(s, final);
      else if (final) this.hooks.onChange(s);
    };
    m.querySelectorAll<HTMLInputElement>('input[data-vol]').forEach((input) => {
      const k = input.dataset.vol as 'masterVolume' | 'musicVolume' | 'sfxVolume';
      input.value = String(Math.round((s[k] ?? 1) * 100));
      input.addEventListener('input', () => {
        s[k] = Number(input.value) / 100;
        sound(false);
      });
      input.addEventListener('change', () => {
        s[k] = Number(input.value) / 100;
        sound(true);
      });
    });
    m.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) this.hooks.onButton?.();
    });
    const sync = (): void => {
      m.querySelectorAll<HTMLElement>('.nh-choice').forEach((group) => {
        const k = group.dataset.k as keyof Settings;
        group.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('is-on', String(s[k]) === b.dataset.v));
      });
    };
    m.querySelectorAll<HTMLElement>('.nh-choice').forEach((group) => {
      group.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button');
        if (!b) return;
        const k = group.dataset.k as keyof Settings;
        const v = b.dataset.v!;
        if (k === 'scheme') s.scheme = v as DriveScheme;
        else if (k === 'quality') s.quality = v as QualityTier | 'auto';
        else if (k === 'vibration') s.vibration = v === 'true';
        else if (k === 'sound') s.sound = v === 'true';
        else if (k === 'radioStation') s.radioStation = Number(v);
        else if (k === 'perf') s.perf = v === 'true';
        sync();
        if (k === 'sound' || k === 'radioStation') sound(true);
        else this.hooks.onChange(s);
      });
    });
    const info = m.querySelector('[data-info]') as HTMLElement;
    const tickInfo = (): void => {
      if (!this.modal) return;
      info.textContent = this.hooks.info?.() ?? '';
      setTimeout(tickInfo, 500);
    };
    const extra = m.querySelector('[data-extra]') as HTMLElement;
    for (const x of this.hooks.extra?.() ?? []) {
      const b = document.createElement('button');
      b.className = 'nh-wide';
      b.textContent = x.label;
      b.addEventListener('click', () => {
        this.close();
        x.run();
      });
      extra.appendChild(b);
    }
    m.querySelector('[data-act="resume"]')!.addEventListener('click', () => this.close());
    m.querySelector('[data-act="reset"]')!.addEventListener('click', () => this.hooks.onResetLayout());
    m.querySelector('[data-act="layout"]')!.addEventListener('click', () => {
      this.close();
      this.setEditing(true);
    });
    sync();
    this.parent.appendChild(m);
    this.modal = m;
    tickInfo();
  }

  close(): void {
    if (!this.modal) return;
    this.modal.remove();
    this.modal = null;
    this.hooks.onClose?.();
  }

  private setEditing(on: boolean): void {
    this.editing = on;
    this.hooks.onEditLayout(on);
    if (on && !this.editDone) {
      const b = document.createElement('button');
      b.className = 'nh-menu-btn';
      b.style.right = 'auto';
      b.style.left = '50%';
      b.style.width = 'auto';
      b.style.padding = '0 16px';
      b.style.transform = 'translateX(-50%)';
      b.textContent = 'Done moving buttons';
      b.addEventListener('click', () => this.setEditing(false));
      this.parent.appendChild(b);
      this.editDone = b;
    } else if (!on && this.editDone) {
      this.editDone.remove();
      this.editDone = null;
    }
  }
}

/** Title screen. Resolves when the player taps start (a user gesture, needed for audio and fullscreen). */
export function showTitle(parent: HTMLElement, status: () => string): Promise<void> {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'nh-modal nh-title';
    m.innerHTML = `<h1>NEON <span>HEAT</span></h1>
      <p>PHASE 0 · FEEL PROTOTYPE</p>
      <p class="nh-title__status"></p>
      <button type="button">TAP TO START</button>
      <p>Keys: WASD / arrows · Space drift · E action · J or click fire · Shift roll · Esc menu</p>`;
    const statusEl = m.querySelector('.nh-title__status') as HTMLElement;
    const timer = setInterval(() => (statusEl.textContent = status()), 200);
    m.querySelector('button')!.addEventListener('click', () => {
      clearInterval(timer);
      m.remove();
      resolve();
    });
    parent.appendChild(m);
  });
}
