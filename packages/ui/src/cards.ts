import { crewById, crewSvg } from './icons';
import { formatCredits } from './hud';

/**
 * Full-screen and banner cards: job start, job complete, FLATLINED / BOOKED
 * and any other big moment. DOM only; the app decides when to show them.
 */
export interface MissionStartCard {
  crew: string;
  title: string;
  /** Optional first objective or tagline. */
  subtitle?: string;
}

export interface MissionCompleteCard {
  title: string;
  crew?: string;
  /** Seconds the job took. */
  seconds: number;
  /** Vehicle or body damage taken, 0..1, or null if not tracked. */
  damage: number | null;
  pay: number;
  respect: { crew: string; delta: number }[];
}

/** FLATLINED, BOOKED and friends: the payload the sim events carry. */
export interface BigCard {
  title: string;
  subtitle?: string;
  lines?: string[];
}

export type BigCardTone = 'flatlined' | 'booked' | 'neutral';

const ECG =
  '<svg class="nh-big__ecg" viewBox="0 0 400 60" preserveAspectRatio="none" aria-hidden="true"><path d="M0 30 H120 L132 30 L140 12 L150 50 L160 4 L170 56 L180 30 H220 L228 22 L236 30 H400"/></svg>';
const BARS = '<div class="nh-big__bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';

export class Cards {
  private startEl: HTMLElement | null = null;
  private startTimer = 0;

  constructor(private readonly parent: HTMLElement) {}

  /** Banner that slides in for a few seconds when a job starts. Does not block play. */
  missionStart(c: MissionStartCard, seconds = 3.2): void {
    this.startEl?.remove();
    clearTimeout(this.startTimer);
    const crew = crewById(c.crew);
    const el = document.createElement('div');
    el.className = 'nh-jobcard';
    el.style.setProperty('--cc', crew.colour);
    el.innerHTML = `<div class="nh-jobcard__icon">${crewSvg(crew, 40)}</div>
      <div class="nh-jobcard__text"><small></small><h3></h3><p></p></div>`;
    (el.querySelector('small') as HTMLElement).textContent = `${crew.name} · Job`;
    (el.querySelector('h3') as HTMLElement).textContent = c.title;
    const p = el.querySelector('p') as HTMLElement;
    p.textContent = c.subtitle ?? '';
    p.hidden = !c.subtitle;
    this.parent.appendChild(el);
    this.startEl = el;
    this.startTimer = window.setTimeout(() => {
      el.classList.add('is-out');
      window.setTimeout(() => el.remove(), 400);
    }, seconds * 1000);
  }

  /** "JOB DONE" summary with a Continue button. Resolves when the player continues. */
  missionComplete(c: MissionCompleteCard): Promise<void> {
    const crew = crewById(c.crew);
    const m = document.createElement('div');
    m.className = 'nh-modal nh-done';
    m.style.setProperty('--cc', crew.colour);
    const mins = Math.floor(c.seconds / 60);
    const secs = String(Math.floor(c.seconds % 60)).padStart(2, '0');
    const respect = c.respect
      .map((r) => {
        const rc = crewById(r.crew);
        const w = Math.min(100, Math.abs(r.delta) * 4);
        return `<div class="nh-done__rep ${r.delta < 0 ? 'is-neg' : ''}" style="--rc:${rc.colour}">${crewSvg(rc, 16)}<span>${escapeHtml(rc.name)}</span><i><b style="width:${w}%"></b></i><em>${r.delta > 0 ? '+' : '−'}${Math.abs(r.delta)}</em></div>`;
      })
      .join('');
    m.innerHTML = `<div class="nh-done__box">
      <div class="nh-done__head"><span class="nh-done__icon">${crewSvg(crew, 34)}</span><div><small>JOB DONE</small><h2></h2></div></div>
      <div class="nh-done__grid">
        <div class="nh-done__stat"><small>TIME</small><b>${mins}:${secs}</b></div>
        <div class="nh-done__stat"><small>DAMAGE</small><b>${c.damage === null ? '—' : `${Math.round(c.damage * 100)}%`}</b></div>
        <div class="nh-done__stat nh-done__pay"><small>PAY</small><b data-pay>+0</b><span>cr</span></div>
      </div>
      ${respect ? `<div class="nh-done__reps"><small>RESPECT</small>${respect}</div>` : ''}
      <button type="button" class="nh-cta" data-act="continue">Continue</button></div>`;
    (m.querySelector('h2') as HTMLElement).textContent = c.title;
    this.parent.appendChild(m);
    // Roll the pay up.
    const pay = m.querySelector('[data-pay]') as HTMLElement;
    const t0 = performance.now();
    const roll = (): void => {
      if (!m.isConnected) return;
      const t = Math.min(1, (performance.now() - t0 - 350) / 900);
      const e = t <= 0 ? 0 : 1 - Math.pow(1 - t, 3);
      pay.textContent = `+${formatCredits(c.pay * e)}`;
      if (t < 1) requestAnimationFrame(roll);
    };
    requestAnimationFrame(roll);
    const btn = m.querySelector('[data-act="continue"]') as HTMLButtonElement;
    return new Promise((resolve) => {
      btn.addEventListener('click', () => {
        m.classList.add('is-out');
        window.setTimeout(() => m.remove(), 220);
        resolve();
      });
      window.setTimeout(() => btn.focus({ preventScroll: true }), 50);
    });
  }

  /**
   * FLATLINED / BOOKED style card. Fills the screen; dismissed by a tap after a
   * short beat, or on its own after `seconds`. Resolves when it goes.
   */
  big(c: BigCard, tone: BigCardTone = 'neutral', seconds = 4.5): Promise<void> {
    const m = document.createElement('div');
    m.className = `nh-big nh-big--${tone}`;
    m.setAttribute('role', 'alertdialog');
    m.innerHTML = `<div class="nh-big__fx">${tone === 'flatlined' ? ECG : tone === 'booked' ? BARS : ''}</div>
      <div class="nh-big__body"><h1 data-text=""></h1><p class="nh-big__sub"></p><ul class="nh-big__lines"></ul><p class="nh-big__tap">Tap to continue</p></div>`;
    const h = m.querySelector('h1') as HTMLElement;
    h.textContent = c.title;
    h.dataset.text = c.title;
    const sub = m.querySelector('.nh-big__sub') as HTMLElement;
    sub.textContent = c.subtitle ?? '';
    sub.hidden = !c.subtitle;
    const ul = m.querySelector('ul') as HTMLElement;
    for (const line of c.lines ?? []) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }
    this.parent.appendChild(m);
    return new Promise((resolve) => {
      let done = false;
      const close = (): void => {
        if (done) return;
        done = true;
        m.classList.add('is-out');
        window.setTimeout(() => m.remove(), 350);
        resolve();
      };
      const shown = performance.now();
      m.addEventListener('click', () => {
        if (performance.now() - shown > 700) close();
      });
      window.setTimeout(close, seconds * 1000);
    });
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
