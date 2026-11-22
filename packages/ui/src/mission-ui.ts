/**
 * Mission overlays: the hack minigame panel, the off-screen objective arrow
 * and the "JOB FAILED" screen. DOM only; the logic lives in @neonheat/missions.
 */

/** Minimal view of a hack session, so the UI does not depend on the missions package. */
export interface HackView {
  phase: 'show' | 'input' | 'success' | 'fail';
  litNode: number;
  inputIndex: number;
  sequence: readonly number[];
  timeLeft: number;
  inputTime: number;
}

/** Each node pairs a colour with a distinct shape, so colour is never the only cue. */
const GLYPHS: { name: string; colour: string; path: string }[] = [
  { name: 'triangle', colour: '#ff2bd6', path: 'M20 6 L35 33 L5 33 Z' },
  { name: 'square', colour: '#2bf0ff', path: 'M8 8 H32 V32 H8 Z' },
  { name: 'circle', colour: '#e6ff2b', path: 'M20 6 A14 14 0 1 1 19.99 6 Z' },
  { name: 'diamond', colour: '#ff8a2b', path: 'M20 4 L36 20 L20 36 L4 20 Z' },
  { name: 'cross', colour: '#8a7bff', path: 'M15 5 H25 V15 H35 V25 H25 V35 H15 V25 H5 V15 H15 Z' },
  { name: 'hexagon', colour: '#3bff8a', path: 'M12 6 H28 L36 20 L28 34 H12 L4 20 Z' },
];

export class HackOverlay {
  readonly root: HTMLElement;
  private readonly nodes: HTMLButtonElement[] = [];
  private readonly status: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly progress: HTMLElement;
  private onTap: ((node: number) => void) | null = null;
  private lastLit = -2;
  private lastPhase = '';
  private lastIndex = -1;

  constructor(parent: HTMLElement, nodeCount = 6) {
    this.root = document.createElement('div');
    this.root.className = 'nh-hack';
    this.root.hidden = true;
    this.root.innerHTML = `<div class="nh-hack__box"><h2>BREACHING LOCK</h2><p class="nh-hack__status"></p>
      <div class="nh-hack__grid"></div><div class="nh-hack__progress"></div><div class="nh-hack__bar"><i></i></div></div>`;
    this.status = this.root.querySelector('.nh-hack__status') as HTMLElement;
    this.bar = this.root.querySelector('.nh-hack__bar > i') as HTMLElement;
    this.progress = this.root.querySelector('.nh-hack__progress') as HTMLElement;
    const grid = this.root.querySelector('.nh-hack__grid') as HTMLElement;
    for (let i = 0; i < nodeCount; i++) {
      const g = GLYPHS[i % GLYPHS.length]!;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nh-hack__node';
      b.style.setProperty('--c', g.colour);
      b.setAttribute('aria-label', `${g.name} node (key ${i + 1})`);
      b.innerHTML = `<svg viewBox="0 0 40 40"><path d="${g.path}"/></svg><small>${i + 1}</small>`;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.press(i);
      });
      grid.appendChild(b);
      this.nodes.push(b);
    }
    window.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      const n = Number(e.key) - 1;
      if (Number.isInteger(n) && n >= 0 && n < this.nodes.length) this.press(n);
    });
    parent.appendChild(this.root);
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  private press(i: number): void {
    const b = this.nodes[i]!;
    b.classList.remove('is-tap');
    void b.offsetWidth;
    b.classList.add('is-tap');
    this.onTap?.(i);
  }

  show(onTap: (node: number) => void): void {
    this.onTap = onTap;
    this.root.hidden = false;
    this.lastLit = -2;
    this.lastPhase = '';
    this.lastIndex = -1;
  }

  hide(): void {
    this.root.hidden = true;
    this.onTap = null;
  }

  update(h: HackView): void {
    if (h.litNode !== this.lastLit) {
      this.lastLit = h.litNode;
      this.nodes.forEach((n, i) => n.classList.toggle('is-lit', i === h.litNode));
    }
    if (h.phase !== this.lastPhase) {
      this.lastPhase = h.phase;
      this.status.textContent =
        h.phase === 'show' ? 'Watch the sequence…' : h.phase === 'input' ? 'Repeat it' : h.phase === 'success' ? 'Lock open' : 'Breach failed';
      this.root.dataset.phase = h.phase;
    }
    if (h.inputIndex !== this.lastIndex) {
      this.lastIndex = h.inputIndex;
      this.progress.textContent = h.sequence.map((_, i) => (i < h.inputIndex ? '◆' : '◇')).join(' ');
    }
    this.bar.style.width = `${Math.round((h.timeLeft / h.inputTime) * 100)}%`;
  }
}

/** Arrow at the screen edge pointing at an off-screen objective. */
export class EdgeArrow {
  private readonly el: HTMLElement;
  private visible = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'nh-arrow';
    this.el.hidden = true;
    this.el.innerHTML = '<svg viewBox="0 0 30 30"><path d="M4 6 L28 15 L4 24 L10 15 Z"/></svg>';
    parent.appendChild(this.el);
  }

  /** Cyan for a job payphone, acid yellow for the current objective. */
  setTone(job: boolean): void {
    this.el.classList.toggle('is-job', job);
  }

  /** ndcX/ndcY in -1..1 (may be outside); hides when the target is on screen or null. */
  set(ndcX: number | null, ndcY = 0, behind = false): void {
    if (ndcX === null) {
      if (this.visible) this.el.hidden = true;
      this.visible = false;
      return;
    }
    let x = ndcX;
    let y = ndcY;
    if (behind) {
      x = -x;
      y = -y;
    }
    const onScreen = !behind && Math.abs(x) < 0.92 && Math.abs(y) < 0.88;
    if (onScreen) {
      if (this.visible) this.el.hidden = true;
      this.visible = false;
      return;
    }
    const m = Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.82, 1e-6);
    const ex = x / m;
    const ey = y / m;
    const angle = Math.atan2(-y, x);
    this.el.style.transform = `translate(${((ex + 1) / 2) * 100}vw, ${((1 - ey) / 2) * 100}vh) translate(-50%, -50%) rotate(${angle}rad)`;
    if (!this.visible) this.el.hidden = false;
    this.visible = true;
  }
}

export interface FailChoice {
  label: string;
  run: () => void;
}

/** "JOB FAILED" with the reason and retry options. */
export function showFailScreen(parent: HTMLElement, reason: string, choices: FailChoice[]): () => void {
  const m = document.createElement('div');
  m.className = 'nh-modal nh-fail';
  m.innerHTML = `<div class="nh-modal__box"><h2>JOB FAILED</h2><p class="nh-fail__reason"></p><div data-choices></div></div>`;
  (m.querySelector('.nh-fail__reason') as HTMLElement).textContent = reason;
  const box = m.querySelector('[data-choices]') as HTMLElement;
  const close = (): void => m.remove();
  for (const c of choices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nh-wide';
    b.textContent = c.label;
    b.addEventListener('click', () => {
      close();
      c.run();
    });
    box.appendChild(b);
  }
  parent.appendChild(m);
  return close;
}
