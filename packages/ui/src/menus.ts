import type { DriveScheme } from '@neonheat/sim';
import { escapeHtml } from './cards';
import { CREWS, crewById, crewSvg } from './icons';
import type { QualityTier, Settings } from './settings';

/** Everything the Settings panel needs; shared by the pause menu and the title screen. */
export interface SettingsPanelHooks {
  settings: Settings;
  onChange: (s: Settings) => void;
  /** Start moving touch buttons (the menu closes first). Omit to hide the button (title screen). */
  onEditLayout?: (on: boolean) => void;
  onResetLayout: () => void;
  /** A live line about the device: tier, frame rate, resolution. */
  info?: () => string;
  /** Play a short test sound (the audio engine hooks this up). */
  onTestSound?: () => void;
  /** Radio stations for the Sound section. */
  stations?: () => { name: string; frequency: string }[];
  /** Sound settings changed (volumes live while dragging, station, on/off). Falls back to onChange. */
  onSoundChange?: (s: Settings, final: boolean) => void;
  /** Any menu button pressed (for a UI blip). */
  onButton?: () => void;
}

type ChoiceKey = 'scheme' | 'quality' | 'perf' | 'vibration' | 'sound' | 'minimapRotate';
type VolumeKey = 'masterVolume' | 'musicVolume' | 'sfxVolume';

function choice(k: ChoiceKey, label: string, opts: [string, string][], note = ''): string {
  return `<div class="nh-set__row"><div class="nh-set__label">${label}${note ? `<small>${note}</small>` : ''}</div><div class="nh-choice" data-k="${k}">${opts
    .map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`)
    .join('')}</div></div>`;
}

function slider(k: VolumeKey, label: string): string {
  return `<div class="nh-set__row"><div class="nh-set__label">${label}</div><div class="nh-slider"><input type="range" min="0" max="100" step="5" data-vol="${k}" aria-label="${label}"><output></output></div></div>`;
}

/**
 * The settings panel: controls scheme, touch layout, graphics, frame rate,
 * vibration, minimap and a Sound section. Returns the element plus a stop
 * function for its live info line.
 */
export function buildSettingsPanel(hooks: SettingsPanelHooks, onLayout?: () => void): { el: HTMLElement; stop: () => void } {
  const s = hooks.settings;
  const el = document.createElement('div');
  el.className = 'nh-set';
  el.innerHTML = `
    <section><h3>Controls</h3>
      ${choice('scheme', 'Touch steering', [['direction', 'Direction'], ['classic', 'Classic']], 'Direction: push where you want to go')}
      <div class="nh-set__row nh-set__btns">
        ${hooks.onEditLayout ? '<button type="button" class="nh-btn2" data-act="layout">Move touch buttons</button>' : ''}
        <button type="button" class="nh-btn2" data-act="reset">Reset touch layout</button>
      </div>
      ${choice('vibration', 'Vibration', [['true', 'On'], ['false', 'Off']])}
    </section>
    <section><h3>Display</h3>
      ${choice('quality', 'Graphics', [['auto', 'Auto'], ['low', 'Low'], ['mid', 'Mid'], ['high', 'High'], ['ultra', 'Max']])}
      ${choice('perf', 'Frame rate', [['true', 'Show'], ['false', 'Hide']])}
      ${choice('minimapRotate', 'Minimap', [['false', 'North up'], ['true', 'Turns with you']])}
      <div class="nh-set__info" data-info></div>
    </section>
    <section><h3>Sound</h3>
      ${choice('sound', 'Sound', [['true', 'On'], ['false', 'Off']])}
      ${slider('masterVolume', 'Master')}
      ${slider('musicVolume', 'Radio and music')}
      ${slider('sfxVolume', 'Effects')}
      <div class="nh-set__row" data-radio-row><div class="nh-set__label">Car radio</div><div class="nh-choice nh-choice--wrap" data-k="radioStation" data-stations></div></div>
      ${hooks.onTestSound ? '<div class="nh-set__row nh-set__btns"><button type="button" class="nh-btn2" data-act="test">Test sound</button></div>' : ''}
    </section>`;
  const stationsEl = el.querySelector('[data-stations]') as HTMLElement;
  const stations = hooks.stations?.() ?? [];
  if (stations.length === 0) el.querySelector('[data-radio-row]')?.remove();
  else {
    stations.forEach((st, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = String(i);
      b.title = `${st.name} ${st.frequency}`;
      b.textContent = st.name.charAt(0) + st.name.slice(1).toLowerCase();
      stationsEl.appendChild(b);
    });
    const off = document.createElement('button');
    off.type = 'button';
    off.dataset.v = '-1';
    off.textContent = 'Off';
    stationsEl.appendChild(off);
  }
  const sound = (final: boolean): void => {
    if (hooks.onSoundChange) hooks.onSoundChange(s, final);
    else if (final) hooks.onChange(s);
  };
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) hooks.onButton?.();
  });
  const sync = (): void => {
    el.querySelectorAll<HTMLElement>('.nh-choice').forEach((group) => {
      const k = group.dataset.k as ChoiceKey | 'radioStation';
      group.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        const on = String(s[k]) === b.dataset.v;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', String(on));
      });
    });
    el.querySelectorAll<HTMLInputElement>('input[data-vol]').forEach((inp) => {
      const k = inp.dataset.vol as VolumeKey;
      inp.value = String(Math.round(s[k] * 100));
      inp.style.setProperty('--v', `${inp.value}%`);
      (inp.nextElementSibling as HTMLElement).textContent = inp.value;
      inp.disabled = !s.sound;
    });
  };
  el.querySelectorAll<HTMLElement>('.nh-choice').forEach((group) => {
    group.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const k = group.dataset.k as ChoiceKey | 'radioStation';
      const v = b.dataset.v!;
      if (k === 'scheme') s.scheme = v as DriveScheme;
      else if (k === 'quality') s.quality = v as QualityTier | 'auto';
      else if (k === 'radioStation') s.radioStation = Number(v);
      else s[k] = v === 'true';
      sync();
      if (k === 'sound' || k === 'radioStation') sound(true);
      else hooks.onChange(s);
    });
  });
  el.querySelectorAll<HTMLInputElement>('input[data-vol]').forEach((inp) => {
    inp.addEventListener('input', () => {
      s[inp.dataset.vol as VolumeKey] = Number(inp.value) / 100;
      sync();
      sound(false);
    });
    inp.addEventListener('change', () => sound(true));
  });
  el.querySelector('[data-act="reset"]')?.addEventListener('click', () => hooks.onResetLayout());
  el.querySelector('[data-act="test"]')?.addEventListener('click', () => hooks.onTestSound?.());
  el.querySelector('[data-act="layout"]')?.addEventListener('click', () => onLayout?.());
  sync();
  const info = el.querySelector('[data-info]') as HTMLElement;
  let live = true;
  const tickInfo = (): void => {
    if (!live) return;
    info.textContent = hooks.info?.() ?? '';
    window.setTimeout(tickInfo, 500);
  };
  tickInfo();
  return { el, stop: () => (live = false) };
}

/** What the Jobs tab shows. */
export interface JobsView {
  active: { title: string; crew: string; objective: string; timer: string | null } | null;
  /** Respect per crew id; any range, shown on a −100..100 bar. */
  respect: Record<string, number>;
  /** Jobs waiting at payphones. */
  available: { title: string; crew: string; done: boolean }[];
}

export interface PauseMenuHooks {
  settings: SettingsPanelHooks;
  onOpen?: () => void;
  onClose?: () => void;
  /** Builds the map into the Map tab; returns a cleanup. */
  mountMap: (host: HTMLElement) => () => void;
  jobs: () => JobsView;
  /** Stats rows: label and formatted value. */
  stats: () => { label: string; value: string }[];
  credits: () => number;
  /** In a job: restart and walk away. */
  onRestartJob?: () => void;
  onWalkAway?: () => void;
}

export type PauseTab = 'map' | 'jobs' | 'stats' | 'settings';

const TAB_ICONS: Record<PauseTab, string> = {
  map: '<svg viewBox="0 0 24 24"><path d="M3 5.5l5.5-2 7 2.5 5.5-2v15l-5.5 2-7-2.5-5.5 2zM8.5 5.6v12.6M15.5 6.2v12.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  jobs: '<svg viewBox="0 0 24 24"><path d="M6.5 2l4 1 1 5-2.6 1.6a11 11 0 0 0 5.5 5.5L16 12.5l5 1 1 4-2.2 3.3C10.5 20.8 3.2 13.5 3.2 4.2z" fill="currentColor"/></svg>',
  stats: '<svg viewBox="0 0 24 24"><path d="M4 20V11h3.5v9zM10.25 20V4h3.5v16zM16.5 20v-6H20v6z" fill="currentColor"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="15" cy="6" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="12" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17" cy="18" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};
const TAB_NAMES: Record<PauseTab, string> = { map: 'Map', jobs: 'Jobs', stats: 'Stats', settings: 'Settings' };

/**
 * The pause menu behind the menu button (and Esc): a tab rail with Map, Jobs,
 * Stats and Settings, Resume, and Restart job / Walk away while in a job.
 */
export class PauseMenu {
  private readonly button: HTMLButtonElement;
  private modal: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;
  private editDone: HTMLButtonElement | null = null;
  private tab: PauseTab = 'map';
  /** Set by the app: whether a job is running (decides the default tab and the job buttons). */
  inJob = () => false;

  constructor(
    private readonly parent: HTMLElement,
    private readonly hooks: PauseMenuHooks,
  ) {
    this.button = document.createElement('button');
    this.button.className = 'nh-menu-btn';
    this.button.type = 'button';
    this.button.setAttribute('aria-label', 'Pause menu');
    this.button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
    this.button.addEventListener('click', () => (this.modal ? this.close() : this.open()));
    parent.appendChild(this.button);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.modal) this.close();
        else if (!this.parent.querySelector('.nh-modal')) this.open();
      } else if ((e.key === 'm' || e.key === 'M') && !this.modal && !this.parent.querySelector('.nh-modal')) this.open('map');
    });
  }

  get isOpen(): boolean {
    return this.modal !== null;
  }

  get currentTab(): PauseTab {
    return this.tab;
  }

  open(tab?: PauseTab): void {
    if (this.modal) {
      if (tab) this.show(tab);
      return;
    }
    this.hooks.onOpen?.();
    const m = document.createElement('div');
    m.className = 'nh-modal nh-pause';
    const inJob = this.inJob();
    m.innerHTML = `
      <nav class="nh-pause__rail">
        <h2>PAUSED</h2>
        <div class="nh-pause__tabs" role="tablist">
          ${(Object.keys(TAB_NAMES) as PauseTab[])
            .map((t) => `<button type="button" role="tab" class="nh-tab" data-tab="${t}">${TAB_ICONS[t]}<span>${TAB_NAMES[t]}</span></button>`)
            .join('')}
        </div>
        <div class="nh-pause__foot">
          <button type="button" class="nh-cta" data-act="resume">Resume</button>
        </div>
      </nav>
      <section class="nh-pause__main">
        <header class="nh-pause__head"><h3></h3><div class="nh-pause__cr"><small>CR</small><b></b></div></header>
        <div class="nh-pause__body"></div>
      </section>`;
    m.querySelector('.nh-pause__tabs')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (b) this.show(b.dataset.tab as PauseTab);
    });
    m.querySelector('[data-act="resume"]')!.addEventListener('click', () => this.close());
    (m.querySelector('.nh-pause__cr b') as HTMLElement).textContent = this.hooks.credits().toLocaleString('en-GB');
    this.parent.appendChild(m);
    this.modal = m;
    this.show(tab ?? (inJob ? 'jobs' : 'map'));
  }

  private show(tab: PauseTab): void {
    const m = this.modal;
    if (!m) return;
    this.cleanup?.();
    this.cleanup = null;
    this.tab = tab;
    m.dataset.tab = tab;
    m.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.tab === tab);
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    });
    (m.querySelector('.nh-pause__head h3') as HTMLElement).textContent = TAB_NAMES[tab];
    const body = m.querySelector('.nh-pause__body') as HTMLElement;
    body.innerHTML = '';
    body.scrollTop = 0;
    if (tab === 'map') this.cleanup = this.hooks.mountMap(body);
    else if (tab === 'jobs') body.appendChild(this.jobsPanel());
    else if (tab === 'stats') body.appendChild(this.statsPanel());
    else {
      const p = buildSettingsPanel(this.hooks.settings, () => {
        this.close();
        this.setEditing(true);
      });
      body.appendChild(p.el);
      this.cleanup = p.stop;
    }
  }

  private jobsPanel(): HTMLElement {
    const v = this.hooks.jobs();
    const el = document.createElement('div');
    el.className = 'nh-jobs';
    let html = '';
    if (v.active) {
      const c = crewById(v.active.crew);
      html += `<div class="nh-jobs__active" style="--cc:${c.colour}">
        <div class="nh-jobs__icon">${crewSvg(c, 34)}</div>
        <div class="nh-jobs__info"><small>ACTIVE JOB · ${escapeHtml(c.name.toUpperCase())}</small><h4>${escapeHtml(v.active.title)}</h4>
        <p>${escapeHtml(v.active.objective)}${v.active.timer ? ` · <b>${escapeHtml(v.active.timer)}</b>` : ''}</p></div>
        <div class="nh-jobs__acts"><button type="button" class="nh-btn2" data-act="restart">Restart job</button><button type="button" class="nh-btn2 is-warn" data-act="walk">Walk away</button></div>
      </div>`;
    } else {
      html += `<div class="nh-jobs__none"><p>No job running. Answer a crew payphone to take one: they are marked on the map with the crew's sign.</p></div>`;
    }
    html += '<h3>Crew respect</h3><div class="nh-jobs__crews">';
    for (const c of CREWS) {
      const r = v.respect[c.id] ?? 0;
      const pct = Math.max(-100, Math.min(100, r));
      const standing = pct >= 60 ? 'Trusted' : pct >= 20 ? 'Friendly' : pct > -20 ? 'Neutral' : pct > -60 ? 'Wary' : 'Hostile';
      html += `<div class="nh-crew" style="--cc:${c.colour}">
        <div class="nh-crew__icon">${crewSvg(c, 22)}</div>
        <div class="nh-crew__name"><b>${c.name}</b><small>${standing}</small></div>
        <div class="nh-crew__bar" role="meter" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${c.name} respect">
          <i class="${pct < 0 ? 'is-neg' : ''}" style="${pct < 0 ? `right:50%;width:${-pct / 2}%` : `left:50%;width:${pct / 2}%`}"></i></div>
        <div class="nh-crew__val">${r > 0 ? '+' : ''}${Math.round(r)}</div></div>`;
    }
    html += '</div>';
    if (v.available.length) {
      html += '<h3>Payphones</h3><div class="nh-jobs__list">';
      for (const j of v.available) {
        const c = crewById(j.crew);
        html += `<div class="nh-jobs__item ${j.done ? 'is-done' : ''}">${crewSvg(c, 16)}<span>${escapeHtml(j.title)}</span><small>${j.done ? 'Done' : c.name}</small></div>`;
      }
      html += '</div>';
    }
    el.innerHTML = html;
    el.querySelector('[data-act="restart"]')?.addEventListener('click', () => {
      this.close();
      this.hooks.onRestartJob?.();
    });
    el.querySelector('[data-act="walk"]')?.addEventListener('click', () => {
      this.close();
      this.hooks.onWalkAway?.();
    });
    return el;
  }

  private statsPanel(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'nh-stats';
    el.innerHTML = this.hooks
      .stats()
      .map((s) => `<div class="nh-stat"><small>${escapeHtml(s.label)}</small><b>${escapeHtml(s.value)}</b></div>`)
      .join('');
    return el;
  }

  close(): void {
    if (!this.modal) return;
    this.cleanup?.();
    this.cleanup = null;
    this.modal.remove();
    this.modal = null;
    this.hooks.onClose?.();
  }

  private setEditing(on: boolean): void {
    this.hooks.settings.onEditLayout?.(on);
    if (on && !this.editDone) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nh-edit-done';
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

/** A simple modal with a title, a body element and a Back button (title screen Settings, Credits). */
export function showPanel(parent: HTMLElement, title: string, body: HTMLElement, onClose?: () => void): () => void {
  const m = document.createElement('div');
  m.className = 'nh-modal nh-panel';
  m.innerHTML = `<div class="nh-panel__box"><header><h2></h2><button type="button" class="nh-iconbtn" data-act="back" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15.5 4L7.5 12l8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></header><div class="nh-panel__body"></div></div>`;
  (m.querySelector('h2') as HTMLElement).textContent = title;
  m.querySelector('.nh-panel__body')!.appendChild(body);
  const close = (): void => {
    m.remove();
    onClose?.();
  };
  m.querySelector('[data-act="back"]')!.addEventListener('click', close);
  m.addEventListener('click', (e) => {
    if (e.target === m) close();
  });
  parent.appendChild(m);
  return close;
}
