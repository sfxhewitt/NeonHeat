/**
 * Dev-only debug panel: live stats plus tuning sliders. Values are edited in
 * place on the objects passed in, so the simulation sees them on the next step.
 */
export interface SliderSpec {
  key: string;
  min: number;
  max: number;
  step?: number;
  label?: string;
}

export class DebugPanel {
  readonly root: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly stats: { el: HTMLElement; read: () => string }[] = [];
  private lastStatUpdate = 0;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'nh-debug';
    this.root.innerHTML = `
      <div class="nh-debug__head"><strong>DEBUG</strong><button type="button" data-act="toggle">–</button></div>
      <div class="nh-debug__stats"></div>
      <div class="nh-debug__body"></div>`;
    this.statsEl = this.root.querySelector('.nh-debug__stats') as HTMLElement;
    this.body = this.root.querySelector('.nh-debug__body') as HTMLElement;
    const toggle = this.root.querySelector('[data-act="toggle"]') as HTMLButtonElement;
    toggle.addEventListener('click', () => {
      const hidden = this.body.classList.toggle('is-hidden');
      toggle.textContent = hidden ? '+' : '–';
    });
    // Keep pointer events inside the panel from reaching the game.
    for (const ev of ['pointerdown', 'touchstart', 'keydown'] as const) {
      this.root.addEventListener(ev, (e) => e.stopPropagation());
    }
    parent.appendChild(this.root);
    window.addEventListener('keydown', (e) => {
      if (e.key === '`') this.root.classList.toggle('is-hidden');
    });
  }

  addStat(label: string, read: () => string): void {
    const el = document.createElement('div');
    el.className = 'nh-debug__stat';
    this.statsEl.appendChild(el);
    this.stats.push({ el, read: () => `${label}: ${read()}` });
  }

  /** Refresh stat readouts, throttled to ~4 Hz. */
  update(now: number): void {
    if (now - this.lastStatUpdate < 250) return;
    this.lastStatUpdate = now;
    for (const s of this.stats) s.el.textContent = s.read();
  }

  addGroup(title: string, collapsed = true): HTMLElement {
    const details = document.createElement('details');
    details.className = 'nh-debug__group';
    details.open = !collapsed;
    const summary = document.createElement('summary');
    summary.textContent = title;
    details.appendChild(summary);
    this.body.appendChild(details);
    return details;
  }

  addSlider<T extends object>(group: HTMLElement, target: T, spec: SliderSpec, onChange?: () => void): void {
    const rec = target as Record<string, unknown>;
    const row = document.createElement('label');
    row.className = 'nh-debug__row';
    const name = document.createElement('span');
    name.textContent = spec.label ?? spec.key;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step ?? (spec.max - spec.min) / 100);
    input.value = String(rec[spec.key]);
    const value = document.createElement('output');
    value.textContent = fmt(Number(rec[spec.key]));
    input.addEventListener('input', () => {
      rec[spec.key] = Number(input.value);
      value.textContent = fmt(Number(input.value));
      onChange?.();
    });
    row.append(name, input, value);
    group.appendChild(row);
  }

  addButton(group: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    group.appendChild(btn);
    return btn;
  }

  addSelect(group: HTMLElement, label: string, options: string[], value: string, onChange: (v: string) => void): void {
    const row = document.createElement('label');
    row.className = 'nh-debug__row';
    const name = document.createElement('span');
    name.textContent = label;
    const sel = document.createElement('select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      sel.appendChild(opt);
    }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    row.append(name, sel);
    group.appendChild(row);
  }
}

function fmt(n: number): string {
  return Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);
}
