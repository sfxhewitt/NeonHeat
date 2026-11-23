import { buildSettingsPanel, showPanel, type SettingsPanelHooks } from './menus';

/**
 * Title screen: an animated NEON HEAT logotype (original letterforms drawn as
 * SVG paths: neon-tube NEON over a solid, chevron-crowned HEAT), tap to start
 * (the first user gesture: unlocks audio and full screen), then Continue /
 * New game / Settings / Credits. The first-boot benchmark keeps running behind it.
 */
export interface TitleOptions {
  /** Live status line (graphics calibration). */
  status: () => string;
  /** Whether there is a save to continue, and a one-line summary of it. */
  save: { exists: boolean; summary: string };
  /** Called once on the first tap: unlock audio here. */
  onFirstGesture?: () => void;
  settings: SettingsPanelHooks;
  version?: string;
}

export type TitleChoice = 'continue' | 'new';

/** NEON as a neon tube: open strokes on a 40×60 grid per letter. */
const NEON_PATHS = [
  'M0 60V0L40 60V0', // N
  'M40 0H0V60H40M0 30H28', // E
  'M10 0H30L40 10V50L30 60H10L0 50V10Z', // O (chamfered)
  'M0 60V0L40 60V0', // N
];
/** HEAT as solid blocks, 100 high. The A is a double chevron: the game's HEAT mark. */
const HEAT_PATHS: [string, number][] = [
  ['M0 0H19V40H43V0H62V100H43V59H19V100H0Z', 62], // H
  ['M12 0H58V19H19V40H50V59H19V81H58V100H0V12Z', 58], // E
  ['M0 100L31 0H45L76 100H56L38 40L20 100ZM25 100L38 60L51 100H43L38 84L33 100Z', 76], // A
  ['M0 0H62V19H40.5V100H21.5V19H0Z', 62], // T
];

function logoSvg(): string {
  let neon = '';
  NEON_PATHS.forEach((d, i) => (neon += `<path d="${d}" transform="translate(${i * 56} 0)"/>`));
  let heat = '';
  let x = 0;
  HEAT_PATHS.forEach(([d, w], i) => {
    heat += `<path d="${d}" transform="translate(${x} 0)"/>`;
    // Optical kerning: the A's feet leave room, so the T tucks in.
    x += w + (i === 2 ? 4 : 12);
  });
  return `<svg class="nh-logo" viewBox="-14 -8 330 196" role="img" aria-label="NEON HEAT">
    <defs>
      <linearGradient id="nhHeatGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ff2bd6"/><stop offset="0.45" stop-color="#ff3b6b"/><stop offset="0.8" stop-color="#ff9a3c"/><stop offset="1" stop-color="#d7ff2b"/>
        <animateTransform attributeName="gradientTransform" type="translate" values="-0.25 0; 0.25 0; -0.25 0" dur="7s" repeatCount="indefinite"/>
      </linearGradient>
      <linearGradient id="nhTube" x1="0" x2="1"><stop offset="0" stop-color="#7ff8ff"/><stop offset="1" stop-color="#21f0ff"/></linearGradient>
      <filter id="nhGlow" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <filter id="nhSoft" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <clipPath id="nhSliceA"><rect x="-20" y="0" width="360" height="34"/></clipPath>
      <clipPath id="nhSliceB"><rect x="-20" y="58" width="360" height="16"/></clipPath>
    </defs>
    <g class="nh-logo__neon" transform="translate(70 4) scale(0.78)" filter="url(#nhGlow)">
      <g class="nh-logo__tube" fill="none" stroke="url(#nhTube)" stroke-width="7" stroke-linejoin="miter" stroke-linecap="square">${neon}</g>
      <g fill="none" stroke="#e8feff" stroke-width="2.2" stroke-linejoin="miter" stroke-linecap="square">${neon}</g>
    </g>
    <g class="nh-logo__rule" filter="url(#nhGlow)"><path d="M0 66H58M258 66H302" stroke="#ff2bd6" stroke-width="2.5"/><path d="M-6 66l4-4 4 4-4 4z M308 66l-4-4-4 4 4 4z" fill="#ff2bd6"/></g>
    <g class="nh-logo__heat" transform="translate(10 78) skewX(-10)">
      <g fill="#05060e" transform="translate(5 5)" opacity="0.9">${heat}</g>
      <g fill="url(#nhHeatGrad)" filter="url(#nhSoft)">${heat}</g>
      <g class="nh-logo__slice nh-logo__slice--a" clip-path="url(#nhSliceA)" fill="#21f0ff" opacity="0.85">${heat}</g>
      <g class="nh-logo__slice nh-logo__slice--b" clip-path="url(#nhSliceB)" fill="#ffffff" opacity="0.9">${heat}</g>
    </g>
  </svg>`;
}

const CREDITS = `
  <div class="nh-credits-roll">
    <p class="nh-credits-roll__lead">NEON HEAT is a work in progress: a top-down open-world crime game built for phones first.</p>
    <dl>
      <dt>Design, code and city</dt><dd>The NEON HEAT team</dd>
      <dt>Type</dt><dd>Chakra Petch by Cadson Demak, SIL Open Font Licence 1.1</dd>
      <dt>Built with</dt><dd>Three.js, Rapier physics, Vite, TypeScript, Zod</dd>
      <dt>Everything else</dt><dd>Procedural geometry, shaders and sound made in code</dd>
    </dl>
    <p class="nh-credits-roll__note">No loot boxes. No energy timers. No adverts while you play.</p>
  </div>`;

export function showTitle(parent: HTMLElement, opts: TitleOptions): Promise<TitleChoice> {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'nh-title';
    m.innerHTML = `
      <div class="nh-title__bg" aria-hidden="true"><i class="nh-title__rain"></i><i class="nh-title__sweep"></i><i class="nh-title__scan"></i></div>
      <div class="nh-title__stage">
        <div class="nh-title__brand"><h1 class="nh-title__h1">${logoSvg()}</h1><p class="nh-title__tag">Every street has a price</p></div>
        <button type="button" class="nh-title__press">TAP TO START</button>
        <div class="nh-title__menu" role="menu" aria-label="Main menu">
          ${opts.save.exists ? `<button type="button" class="nh-title__item is-primary" data-act="continue" role="menuitem"><span>Continue</span><small></small></button>` : ''}
          <button type="button" class="nh-title__item ${opts.save.exists ? '' : 'is-primary'}" data-act="new" role="menuitem"><span>New game</span><small>${opts.save.exists ? 'Start over from nothing' : 'Five crews, one city, no rules'}</small></button>
          <button type="button" class="nh-title__item" data-act="settings" role="menuitem"><span>Settings</span><small>Controls, graphics, sound</small></button>
          <button type="button" class="nh-title__item" data-act="credits" role="menuitem"><span>Credits</span><small>Who made this</small></button>
        </div>
      </div>
      <footer class="nh-title__foot"><span class="nh-title__status"></span><span class="nh-title__keys">Keys: WASD / arrows · Space drift · E action · J or click fire · Shift roll · M map · Esc pause</span><span class="nh-title__ver"></span></footer>`;
    const cont = m.querySelector('[data-act="continue"] small');
    if (cont) cont.textContent = opts.save.summary;
    (m.querySelector('.nh-title__ver') as HTMLElement).textContent = opts.version ?? '';
    const statusEl = m.querySelector('.nh-title__status') as HTMLElement;
    const timer = window.setInterval(() => {
      const s = opts.status();
      if (statusEl.textContent !== s) statusEl.textContent = s;
    }, 200);
    statusEl.textContent = opts.status();
    let gestured = false;
    const press = m.querySelector('.nh-title__press') as HTMLButtonElement;
    const toMenu = (): void => {
      if (!gestured) {
        gestured = true;
        try {
          opts.onFirstGesture?.();
        } catch (err) {
          console.warn('onFirstGesture failed', err);
        }
      }
      m.classList.add('is-menu');
      window.setTimeout(() => (m.querySelector('.nh-title__item') as HTMLElement | null)?.focus({ preventScroll: true }), 60);
    };
    press.addEventListener('click', toMenu);
    // A tap anywhere on the first screen counts as the start tap.
    m.addEventListener('click', (e) => {
      if (!m.classList.contains('is-menu') && e.target !== press) toMenu();
    });
    const finish = (choice: TitleChoice): void => {
      window.clearInterval(timer);
      m.classList.add('is-out');
      window.setTimeout(() => m.remove(), 420);
      resolve(choice);
    };
    let confirmNew = false;
    m.querySelector('.nh-title__menu')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'continue') finish('continue');
      else if (act === 'new') {
        if (opts.save.exists && !confirmNew) {
          confirmNew = true;
          b.classList.add('is-confirm');
          (b.querySelector('span') as HTMLElement).textContent = 'Wipe save?';
          (b.querySelector('small') as HTMLElement).textContent = 'Tap again to start over';
          return;
        }
        finish('new');
      } else if (act === 'settings') {
        const p = buildSettingsPanel(opts.settings);
        showPanel(parent, 'Settings', p.el, p.stop);
      } else if (act === 'credits') {
        const div = document.createElement('div');
        div.innerHTML = CREDITS;
        showPanel(parent, 'Credits', div);
      }
    });
    parent.appendChild(m);
  });
}
