import { ACTIVITY_STYLES, activitySvg, type ActivityIconKind } from './icons';
import { formatCredits } from './hud';

/**
 * Side-activity HUD: the running activity's panel (rampage count and clock;
 * race place, lap, checkpoint and time; fare pick-up or drop-off with its
 * clock and streak), a 3-2-1-GO countdown, result cards, the stunt-jump
 * readout and the data-shard counter. DOM only, written when a value changes.
 */
export type ActivityPanelKind = 'rampage' | 'race' | 'fare' | 'parcel';

export interface ActivityResult {
  tone: 'pass' | 'fail' | 'neutral';
  kind: ActivityIconKind;
  /** Small line above the title (RAMPAGE, STREET RACE...). */
  kicker: string;
  title: string;
  lines: { label: string; value: string }[];
  /** Credits paid, shown big; 0 hides it. */
  reward: number;
}

export interface JumpReadout {
  distance: number;
  air: number;
  height: number;
  reward: number;
  unique: boolean;
  best: boolean;
  /** The ramp's unique-jump distance. */
  target: number;
}

export function clock(sec: number, tenths = false): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const whole = Math.floor(r);
  const base = `${m}:${String(whole).padStart(2, '0')}`;
  return tenths ? `${base}.${Math.floor((r - whole) * 10)}` : base;
}

export function ordinal(n: number): string {
  const k = n % 100;
  if (k >= 11 && k <= 13) return `${n}TH`;
  return `${n}${['TH', 'ST', 'ND', 'RD'][n % 10 > 3 ? 0 : n % 10]}`;
}

export class ActivityHud {
  private readonly panel: HTMLElement;
  private readonly icon: HTMLElement;
  private readonly kicker: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly airEl: HTMLElement;
  private readonly shardEl: HTMLElement;
  private readonly overlay: HTMLElement;
  private kind: ActivityPanelKind | null = null;
  private lastBody = '';
  private lastTimer = '';
  private lastBar = -1;
  private lastUrgent = false;
  private lastAir = '';
  private resultEl: HTMLElement | null = null;
  private resultTimer = 0;
  private jumpEl: HTMLElement | null = null;
  private jumpTimer = 0;
  private shardTimer = 0;
  private countTimer = 0;

  constructor(hudRoot: HTMLElement, overlay: HTMLElement) {
    this.overlay = overlay;
    this.panel = document.createElement('div');
    this.panel.className = 'nh-act';
    this.panel.hidden = true;
    this.panel.setAttribute('role', 'status');
    this.panel.innerHTML = `
      <div class="nh-act__head"><span class="nh-act__icon"></span><small></small><b></b></div>
      <div class="nh-act__row"><div class="nh-act__body"></div><div class="nh-act__timer"></div></div>
      <div class="nh-act__bar"><i></i></div>`;
    this.icon = this.panel.querySelector('.nh-act__icon') as HTMLElement;
    this.kicker = this.panel.querySelector('.nh-act__head small') as HTMLElement;
    this.title = this.panel.querySelector('.nh-act__head b') as HTMLElement;
    this.body = this.panel.querySelector('.nh-act__body') as HTMLElement;
    this.timer = this.panel.querySelector('.nh-act__timer') as HTMLElement;
    this.bar = this.panel.querySelector('.nh-act__bar > i') as HTMLElement;
    hudRoot.appendChild(this.panel);

    this.countEl = document.createElement('div');
    this.countEl.className = 'nh-count';
    this.countEl.hidden = true;
    hudRoot.appendChild(this.countEl);

    this.airEl = document.createElement('div');
    this.airEl.className = 'nh-air';
    this.airEl.hidden = true;
    hudRoot.appendChild(this.airEl);

    this.shardEl = document.createElement('div');
    this.shardEl.className = 'nh-shardpop';
    this.shardEl.hidden = true;
    hudRoot.appendChild(this.shardEl);
  }

  get open(): ActivityPanelKind | null {
    return this.kind;
  }

  /** Open the panel for an activity. */
  show(kind: ActivityPanelKind, kicker: string, title: string, colour?: string): void {
    const icon: ActivityIconKind = kind === 'race' ? 'race' : kind;
    this.kind = kind;
    this.panel.hidden = false;
    this.panel.dataset.kind = kind;
    this.panel.style.setProperty('--ac', colour ?? ACTIVITY_STYLES[icon].colour);
    this.icon.innerHTML = activitySvg(icon, 20);
    this.kicker.textContent = kicker;
    this.title.textContent = title;
    this.lastBody = this.lastTimer = '';
    this.lastBar = -1;
  }

  /** Change the panel's title line (a fare's stage, say). */
  setTitle(title: string): void {
    if (this.title.textContent !== title) this.title.textContent = title;
  }

  hide(): void {
    if (!this.kind) return;
    this.kind = null;
    this.panel.hidden = true;
  }

  private set(body: string, timer: string, bar: number, urgent: boolean): void {
    if (body !== this.lastBody) {
      this.lastBody = body;
      this.body.innerHTML = body;
    }
    if (timer !== this.lastTimer) {
      this.lastTimer = timer;
      this.timer.textContent = timer;
      this.timer.hidden = timer === '';
    }
    const b = Math.round(Math.max(0, Math.min(1, bar)) * 200) / 200;
    if (b !== this.lastBar) {
      this.lastBar = b;
      this.bar.style.width = `${b * 100}%`;
      this.bar.parentElement!.hidden = bar < 0;
    }
    if (urgent !== this.lastUrgent) {
      this.lastUrgent = urgent;
      this.timer.classList.toggle('is-urgent', urgent);
    }
  }

  rampage(count: number, target: number, timeLeft: number, noun: string): void {
    this.set(`<span class="nh-act__big">${count}<small>/${target}</small></span><span class="nh-act__unit">${noun}</span>`, clock(Math.ceil(timeLeft)), count / target, timeLeft < 10);
  }

  race(place: number, racers: number, lap: number, laps: number, cp: number, cps: number, seconds: number): void {
    const lapCell = laps > 1 ? `<span class="nh-act__cell"><small>LAP</small><b>${lap}<i>/${laps}</i></b></span>` : '';
    this.set(
      `<span class="nh-act__cell nh-act__pos"><small>POS</small><b>${place}<i>/${racers}</i></b></span>${lapCell}<span class="nh-act__cell"><small>CP</small><b>${cp}<i>/${cps}</i></b></span>`,
      clock(seconds, true),
      cp / cps,
      false,
    );
  }

  fare(phase: string, timeLeft: number, timeTotal: number, streak: number, done: number, earned: number): void {
    const streakCell = streak > 0 ? `<span class="nh-act__cell nh-act__streak"><small>STREAK</small><b>×${streak}</b></span>` : '';
    this.set(
      `<span class="nh-act__phase">${phase}</span>${streakCell}<span class="nh-act__cell"><small>FARES</small><b>${done}</b></span><span class="nh-act__cell"><small>SHIFT</small><b>${formatCredits(earned)}<i> cr</i></b></span>`,
      clock(Math.ceil(timeLeft)),
      timeLeft / timeTotal,
      timeLeft < 10,
    );
  }

  /** Big centre countdown: a number, or GO. */
  countdown(text: string, go = false): void {
    clearTimeout(this.countTimer);
    const el = this.countEl;
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle('is-go', go);
    // Restart the pop animation.
    el.classList.remove('is-pop');
    void el.offsetWidth;
    el.classList.add('is-pop');
    this.countTimer = window.setTimeout(() => (el.hidden = true), go ? 900 : 1100);
  }

  /** Live airtime while a jump is in the air; null hides it. */
  air(seconds: number | null, height = 0): void {
    const t = seconds === null ? '' : `<small>AIR</small>${seconds.toFixed(2)}<i>s</i><small>HEIGHT</small>${height.toFixed(1)}<i>m</i>`;
    if (t === this.lastAir) return;
    this.lastAir = t;
    this.airEl.hidden = t === '';
    if (t) this.airEl.innerHTML = t;
  }

  /** The landing card for a jump. */
  jump(j: JumpReadout): void {
    this.jumpEl?.remove();
    clearTimeout(this.jumpTimer);
    const el = document.createElement('div');
    el.className = 'nh-jump' + (j.unique ? ' is-unique' : '');
    const tag = j.unique ? 'UNIQUE JUMP' : j.best ? 'NEW BEST' : 'STUNT JUMP';
    const short = !j.unique && j.distance < j.target ? `<em>${(j.target - j.distance).toFixed(1)} m short of the unique jump</em>` : '';
    el.innerHTML = `<small>${tag}</small>
      <div class="nh-jump__dist">${j.distance.toFixed(1)}<i>m</i></div>
      <div class="nh-jump__stats"><span>AIR <b>${j.air.toFixed(2)} s</b></span><span>HEIGHT <b>${j.height.toFixed(1)} m</b></span>${j.reward > 0 ? `<span class="nh-jump__cr">+${formatCredits(j.reward)} cr</span>` : ''}</div>${short}`;
    this.overlay.appendChild(el);
    this.jumpEl = el;
    this.jumpTimer = window.setTimeout(() => {
      el.classList.add('is-out');
      window.setTimeout(() => el.remove(), 400);
      if (this.jumpEl === el) this.jumpEl = null;
    }, j.unique ? 3600 : 2600);
  }

  /** A data shard was picked up. */
  shard(found: number, total: number, milestone: number): void {
    clearTimeout(this.shardTimer);
    const el = this.shardEl;
    el.hidden = false;
    el.classList.toggle('is-milestone', milestone > 0);
    el.innerHTML = `${activitySvg('shard', 22)}<div><small>${milestone > 0 ? 'CACHE DECRYPTED' : 'DATA SHARD'}</small><b>${found}<i>/${total}</i></b>${milestone > 0 ? `<span>+${formatCredits(milestone)} cr</span>` : ''}</div>`;
    el.classList.remove('is-pop');
    void el.offsetWidth;
    el.classList.add('is-pop');
    this.shardTimer = window.setTimeout(() => (el.hidden = true), milestone > 0 ? 4000 : 2600);
  }

  /** Pass / fail card in the middle of the screen; never blocks play. */
  result(r: ActivityResult, seconds = 3.6): void {
    this.resultEl?.remove();
    clearTimeout(this.resultTimer);
    const el = document.createElement('div');
    el.className = `nh-actres is-${r.tone}`;
    el.style.setProperty('--ac', ACTIVITY_STYLES[r.kind].colour);
    const lines = r.lines.map((l) => `<div><span>${l.label}</span><b>${l.value}</b></div>`).join('');
    el.innerHTML = `<div class="nh-actres__icon">${activitySvg(r.kind, 34)}</div>
      <small></small><h2></h2>
      ${lines ? `<div class="nh-actres__lines">${lines}</div>` : ''}
      ${r.reward > 0 ? `<div class="nh-actres__cr">+${formatCredits(r.reward)}<i>cr</i></div>` : ''}`;
    (el.querySelector('small') as HTMLElement).textContent = r.kicker;
    (el.querySelector('h2') as HTMLElement).textContent = r.title;
    this.overlay.appendChild(el);
    this.resultEl = el;
    this.resultTimer = window.setTimeout(() => {
      el.classList.add('is-out');
      window.setTimeout(() => el.remove(), 400);
      if (this.resultEl === el) this.resultEl = null;
    }, seconds * 1000);
  }
}
