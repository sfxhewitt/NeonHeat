/**
 * HUD overlay: HEAT chevrons (never stars) with level-change flashes, credits
 * with a rolling count-up, weapon/ammo and armour slots, hull/body bar, speed,
 * TRACE, mission objective and timer, dialogue, toasts, onboarding hints and
 * the district banner. Writes to the DOM only when a value changes.
 *
 * Public API for other systems:
 * - `setCredits(n)`: rolls the counter up (or down) to n and pops the difference.
 * - `setArmour(frac | null)`: armour bar above the hull/body bar; null hides it.
 * - `showHint(text, controlId?)`: onboarding hint; highlights a control (see {@link HintControl}).
 * - `clearHint()`.
 */
export type HintControl =
  | 'stick'
  | 'fire'
  | 'dodge'
  | 'context'
  | 'handbrake'
  | 'gas'
  | 'brake'
  | 'left'
  | 'right'
  | 'minimap'
  | 'menu'
  | 'heat'
  | 'credits';

export interface WeaponView {
  name: string;
  /** Rounds in the magazine, or null for melee / infinite. */
  clip: number | null;
  /** Rounds in reserve, or null. */
  reserve: number | null;
}

const HINT_TARGETS: Record<HintControl, string> = {
  stick: '.nh-touch__rest',
  fire: '.nh-btn--fire',
  dodge: '.nh-btn--dodge',
  context: '.nh-btn--context',
  handbrake: '.nh-btn--handbrake',
  gas: '.nh-btn--gas',
  brake: '.nh-btn--brake',
  left: '.nh-btn--left',
  right: '.nh-btn--right',
  minimap: '.nh-minimap',
  menu: '.nh-menu-btn',
  heat: '.nh-heat',
  credits: '.nh-credits',
};

/** Short label for the key or button, shown in the hint line. */
const HINT_GLYPH: Partial<Record<HintControl, string>> = {
  stick: 'STICK',
  fire: 'FIRE',
  dodge: 'ROLL',
  context: 'ACTION',
  handbrake: 'DRIFT',
  gas: 'GAS',
  brake: 'BRAKE',
  minimap: 'MAP',
  menu: 'MENU',
};

const CHEVRON = '<path class="chev" d="M3 14 L11 5 L19 14" />';

export class Hud {
  readonly root: HTMLElement;
  private readonly heatEl: HTMLElement;
  private readonly chevrons: SVGElement[] = [];
  private readonly speedEl: HTMLElement;
  private readonly healthBar: HTMLElement;
  private readonly healthFill: HTMLElement;
  private readonly healthWrap: HTMLElement;
  private readonly armourWrap: HTMLElement;
  private readonly armourFill: HTMLElement;
  private readonly traceEl: HTMLElement;
  private readonly missionEl: HTMLElement;
  private readonly objEl: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly dialogueEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly creditsEl: HTMLElement;
  private readonly creditsNum: HTMLElement;
  private readonly creditsDelta: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly heatFlashEl: HTMLElement;
  private readonly districtEl: HTMLElement;
  private last = {
    label: '',
    heat: -1,
    flash: false,
    speed: -1,
    health: -1,
    armour: -2,
    trace: -1,
    obj: '',
    timer: '',
    weapon: '',
  };
  private toastUntil = 0;
  private toastPriority = 0;
  private dialogueUntil = 0;
  private hintUntil = 0;
  private hintTarget: Element | null = null;
  private heatFlashUntil = 0;
  private districtUntil = 0;
  /** Credits: shown value rolls towards the target. */
  private creditsShown = 0;
  private creditsTarget = 0;
  private creditsKnown = false;
  private creditsDeltaUntil = 0;
  private lastTick = 0;

  constructor(parent: HTMLElement, maxChevrons = 5) {
    this.root = document.createElement('div');
    this.root.className = 'nh-hud';
    this.root.innerHTML = `
      <div class="nh-mission" hidden><div class="nh-mission__obj"></div><div class="nh-mission__timer"></div></div>
      <div class="nh-hud__tr">
        <div class="nh-heat" role="status" aria-label="HEAT level"><span class="nh-heat__label">HEAT</span></div>
        <div class="nh-credits" aria-label="Credits"><span class="nh-credits__cr">CR</span><span class="nh-credits__num">0</span><span class="nh-credits__delta"></span></div>
        <div class="nh-trace" hidden></div>
      </div>
      <div class="nh-hud__bl">
        <div class="nh-bars">
          <div class="nh-armour" hidden><div class="nh-bar__label">ARMOUR</div><div class="nh-bar nh-bar--armour"><i></i></div></div>
          <div class="nh-health"><div class="nh-bar__label">HULL</div><div class="nh-bar"><i></i></div></div>
        </div>
        <div class="nh-speed">0<small>km/h</small></div>
      </div>
      <div class="nh-hint" hidden><span class="nh-hint__key"></span><span class="nh-hint__text"></span></div>
      <div class="nh-heatflash" hidden></div>
      <div class="nh-district" hidden><small>ENTERING</small><span></span></div>
      <div class="nh-dialogue" hidden></div>
      <div class="nh-toast" hidden></div>
      <div class="nh-hint" role="note" hidden></div>`;
    this.heatEl = this.root.querySelector('.nh-heat') as HTMLElement;
    for (let i = 0; i < maxChevrons; i++) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 22 18');
      svg.innerHTML = CHEVRON;
      this.heatEl.appendChild(svg);
      this.chevrons.push(svg.firstElementChild as SVGElement);
    }
    const q = (s: string): HTMLElement => this.root.querySelector(s) as HTMLElement;
    this.speedEl = q('.nh-speed');
    this.healthWrap = q('.nh-health');
    this.healthBar = q('.nh-health .nh-bar');
    this.healthFill = q('.nh-health .nh-bar > i');
    this.armourWrap = q('.nh-armour');
    this.armourFill = q('.nh-armour .nh-bar > i');
    this.traceEl = q('.nh-trace');
    this.missionEl = q('.nh-mission');
    this.objEl = q('.nh-mission__obj');
    this.timerEl = q('.nh-mission__timer');
    this.dialogueEl = q('.nh-dialogue');
    this.toastEl = q('.nh-toast');
    this.creditsEl = q('.nh-credits');
    this.creditsNum = q('.nh-credits__num');
    this.creditsDelta = q('.nh-credits__delta');
    this.hintEl = q('.nh-hint');
    this.heatFlashEl = q('.nh-heatflash');
    this.districtEl = q('.nh-district');
    parent.appendChild(this.root);
  }

  setHeat(level: number, flash: boolean): void {
    if (level === this.last.heat && flash === this.last.flash) return;
    const prev = this.last.heat;
    this.last.heat = level;
    this.last.flash = flash;
    this.chevrons.forEach((c, i) => c.classList.toggle('on', i < level));
    this.heatEl.classList.toggle('is-flash', flash && level > 0);
    this.heatEl.classList.toggle('is-hot', level > 0);
    this.heatEl.setAttribute('aria-label', `HEAT level ${level}`);
    if (prev >= 0 && level !== prev) this.heatChanged(level, prev);
  }

  /** The level-change flash: a chevron banner on the way up, a cool "HEAT LOST" when it clears. */
  heatChanged(level: number, prev: number, now = performance.now()): void {
    const el = this.heatFlashEl;
    const up = level > prev;
    el.className = `nh-heatflash ${up ? 'is-up' : level === 0 ? 'is-lost' : 'is-down'}`;
    if (level === 0) el.innerHTML = '<b>HEAT LOST</b><small>You slipped them</small>';
    else {
      let chev = '';
      for (let i = 0; i < this.chevrons.length; i++) chev += `<svg viewBox="0 0 22 18" class="${i < level ? 'on' : ''}">${CHEVRON}</svg>`;
      el.innerHTML = `<div class="nh-heatflash__chev">${chev}</div><b>HEAT ${level}</b><small>${up ? HEAT_LINES[level] ?? '' : 'Cooling off'}</small>`;
    }
    el.hidden = false;
    // Restart the animation.
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    this.heatEl.classList.remove('is-bump');
    void this.heatEl.offsetWidth;
    if (up) this.heatEl.classList.add('is-bump');
    this.heatFlashUntil = now + (up ? 1900 : 1500);
  }

  setSpeed(kmh: number | null): void {
    const v = kmh === null ? -2 : Math.round(kmh);
    if (v === this.last.speed) return;
    this.last.speed = v;
    this.speedEl.hidden = kmh === null;
    this.speedEl.firstChild!.textContent = String(Math.max(0, v));
  }

  /** Health fraction 0..1, with a label (HULL for vehicles, BODY on foot). */
  setHealth(frac: number, label = 'HULL'): void {
    const v = Math.round(frac * 100);
    if (v === this.last.health && label === this.last.label) return;
    this.last.health = v;
    this.last.label = label;
    this.healthFill.style.width = `${v}%`;
    this.healthBar.classList.toggle('is-low', v < 35);
    (this.healthWrap.firstElementChild as HTMLElement).textContent = label;
  }

  /** Armour fraction 0..1, or null to hide the bar (no armour system, or none worn). */
  setArmour(frac: number | null): void {
    const v = frac === null ? -1 : Math.round(Math.max(0, Math.min(1, frac)) * 100);
    if (v === this.last.armour) return;
    this.last.armour = v;
    this.armourWrap.hidden = v < 0;
    if (v >= 0) this.armourFill.style.width = `${v}%`;
  }

  /** Credits: the counter rolls to the new value and pops the difference. The first call sets it instantly. */
  setCredits(n: number, now = performance.now()): void {
    if (!this.creditsKnown) {
      this.creditsKnown = true;
      this.creditsShown = this.creditsTarget = n;
      this.creditsNum.textContent = formatCredits(n);
      return;
    }
    if (n === this.creditsTarget) return;
    const diff = n - this.creditsTarget;
    this.creditsTarget = n;
    this.creditsDelta.textContent = `${diff > 0 ? '+' : '−'}${formatCredits(Math.abs(diff))}`;
    this.creditsEl.classList.toggle('is-loss', diff < 0);
    this.creditsEl.classList.remove('is-gain');
    void this.creditsEl.offsetWidth;
    this.creditsEl.classList.add('is-gain');
    this.creditsDeltaUntil = now + 2600;
  }

  /** The hull bar only shows while driving (on foot the combat HUD shows body and armour). */
  showHealth(on: boolean): void {
    if (this.healthWrap.hidden === !on) return;
    this.healthWrap.hidden = !on;
  }

  setTrace(percent: number): void {
    const v = Math.round(percent);
    if (v === this.last.trace) return;
    this.last.trace = v;
    this.traceEl.hidden = v <= 0;
    this.traceEl.innerHTML = `<span>TRACE</span><i style="--t:${v}%"></i><b>${v}%</b>`;
  }

  setObjective(text: string | null, timer: string | null): void {
    const o = text ?? '';
    const t = timer ?? '';
    if (o !== this.last.obj) {
      this.last.obj = o;
      this.objEl.textContent = o;
      this.missionEl.hidden = o === '';
    }
    if (t !== this.last.timer) {
      this.last.timer = t;
      this.timerEl.textContent = t;
      this.timerEl.hidden = t === '';
      const secs = parseTimer(t);
      this.timerEl.classList.toggle('is-urgent', secs !== null && secs <= 15);
    }
  }

  showDialogue(speaker: string, line: string, now: number, seconds = 5): void {
    this.dialogueEl.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = speaker;
    this.dialogueEl.append(b, document.createTextNode(line));
    this.dialogueEl.hidden = false;
    this.dialogueUntil = now + seconds * 1000;
  }

  /**
   * Show a banner. A higher `priority` banner (JOB DONE, for one) is not replaced by a
   * lesser one while it is still up.
   */
  toast(text: string, now: number, seconds = 2.5, priority = 0): void {
    if (now < this.toastUntil && priority < this.toastPriority) return;
    this.toastPriority = priority;
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    this.toastEl.style.animation = 'none';
    void this.toastEl.offsetWidth;
    this.toastEl.style.animation = '';
    this.toastUntil = now + seconds * 1000;
  }

  /**
   * Onboarding hint: a short instruction line, with the matching touch control
   * (or HUD element) pulsing. Stays until `seconds` pass, `clearHint()`, or the next hint.
   */
  showHint(text: string, controlId?: HintControl | string, seconds = 8, now = performance.now()): void {
    this.clearHint();
    const id = controlId as HintControl | undefined;
    const key = this.hintEl.firstElementChild as HTMLElement;
    key.textContent = id ? (HINT_GLYPH[id] ?? id.toUpperCase()) : '';
    key.hidden = !id;
    (this.hintEl.lastElementChild as HTMLElement).textContent = text;
    this.hintEl.hidden = false;
    this.hintEl.style.animation = 'none';
    void this.hintEl.offsetWidth;
    this.hintEl.style.animation = '';
    this.hintUntil = now + seconds * 1000;
    const sel = id ? HINT_TARGETS[id] : undefined;
    const scope = this.root.parentElement ?? document;
    const target = sel ? (scope.querySelector(sel) ?? document.querySelector(sel)) : null;
    if (target) {
      target.classList.add('nh-hinted');
      this.hintTarget = target;
    }
  }

  clearHint(): void {
    this.hintEl.hidden = true;
    this.hintTarget?.classList.remove('nh-hinted');
    this.hintTarget = null;
  }

  /** "Entering <district>" banner, in the district's colour. */
  showDistrict(name: string, colour: string, now = performance.now()): void {
    const el = this.districtEl;
    (el.lastElementChild as HTMLElement).textContent = name;
    el.style.setProperty('--dc', colour);
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    this.districtUntil = now + 2600;
  }

  tick(now: number): void {
    const dt = this.lastTick ? Math.min(0.1, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    if (!this.toastEl.hidden && now > this.toastUntil) this.toastEl.hidden = true;
    if (!this.dialogueEl.hidden && now > this.dialogueUntil) this.dialogueEl.hidden = true;
    if (!this.hintEl.hidden && now > this.hintUntil) this.clearHint();
    if (!this.heatFlashEl.hidden && now > this.heatFlashUntil) this.heatFlashEl.hidden = true;
    if (!this.districtEl.hidden && now > this.districtUntil) this.districtEl.hidden = true;
    if (this.creditsShown !== this.creditsTarget) {
      // Ease towards the target (most of a change lands within a second), at least 1 cr per frame.
      const diff = this.creditsTarget - this.creditsShown;
      const step = Math.max(1, Math.ceil(Math.abs(diff) * Math.min(1, dt * 4)));
      this.creditsShown = Math.abs(diff) <= step ? this.creditsTarget : this.creditsShown + Math.sign(diff) * step;
      this.creditsNum.textContent = formatCredits(this.creditsShown);
    }
    if (this.creditsDeltaUntil && now > this.creditsDeltaUntil) {
      this.creditsDeltaUntil = 0;
      this.creditsEl.classList.remove('is-gain');
    }
  }
}

const HEAT_LINES: Record<number, string> = {
  1: 'Patrols are looking',
  2: 'Units converging',
  3: 'Roadblocks going up',
  4: 'Enforcers deployed',
  5: 'Maximum response',
};

export function formatCredits(n: number): string {
  return Math.round(n).toLocaleString('en-GB');
}

function parseTimer(t: string): number | null {
  const m = /^(\d+):(\d\d)$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
