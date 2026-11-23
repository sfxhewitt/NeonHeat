/**
 * HUD overlay: HEAT chevrons (never stars), speed, vehicle health, TRACE,
 * mission objective and timer, dialogue and toasts. Writes to the DOM only
 * when a value changes.
 */
export class Hud {
  readonly root: HTMLElement;
  private readonly heatEl: HTMLElement;
  private readonly chevrons: SVGElement[] = [];
  private readonly speedEl: HTMLElement;
  private readonly healthBar: HTMLElement;
  private readonly healthFill: HTMLElement;
  private readonly healthWrap: HTMLElement;
  private readonly traceEl: HTMLElement;
  private readonly missionEl: HTMLElement;
  private readonly objEl: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly dialogueEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private last = { label: '', heat: -1, flash: false, speed: -1, health: -1, trace: -1, obj: '', timer: '', dialogue: '', toast: '' };
  private toastUntil = 0;
  private dialogueUntil = 0;

  constructor(parent: HTMLElement, maxChevrons = 5) {
    this.root = document.createElement('div');
    this.root.className = 'nh-hud';
    this.root.innerHTML = `
      <div class="nh-mission" hidden><div class="nh-mission__obj"></div><div class="nh-mission__timer"></div></div>
      <div class="nh-hud__tr">
        <div class="nh-heat" role="status" aria-label="HEAT level"><span class="nh-heat__label">HEAT</span></div>
        <div class="nh-trace" hidden></div>
      </div>
      <div class="nh-hud__bl">
        <div class="nh-health"><div class="nh-bar__label">HULL</div><div class="nh-bar"><i></i></div></div>
        <div class="nh-speed">0<small>km/h</small></div>
      </div>
      <div class="nh-dialogue" hidden></div>
      <div class="nh-toast" hidden></div>`;
    this.heatEl = this.root.querySelector('.nh-heat') as HTMLElement;
    for (let i = 0; i < maxChevrons; i++) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 22 18');
      svg.innerHTML = '<path class="chev" d="M3 14 L11 5 L19 14" />';
      this.heatEl.appendChild(svg);
      this.chevrons.push(svg.firstElementChild as SVGElement);
    }
    this.speedEl = this.root.querySelector('.nh-speed') as HTMLElement;
    this.healthWrap = this.root.querySelector('.nh-health') as HTMLElement;
    this.healthBar = this.root.querySelector('.nh-bar') as HTMLElement;
    this.healthFill = this.root.querySelector('.nh-bar > i') as HTMLElement;
    this.traceEl = this.root.querySelector('.nh-trace') as HTMLElement;
    this.missionEl = this.root.querySelector('.nh-mission') as HTMLElement;
    this.objEl = this.root.querySelector('.nh-mission__obj') as HTMLElement;
    this.timerEl = this.root.querySelector('.nh-mission__timer') as HTMLElement;
    this.dialogueEl = this.root.querySelector('.nh-dialogue') as HTMLElement;
    this.toastEl = this.root.querySelector('.nh-toast') as HTMLElement;
    parent.appendChild(this.root);
  }

  setHeat(level: number, flash: boolean): void {
    if (level === this.last.heat && flash === this.last.flash) return;
    this.last.heat = level;
    this.last.flash = flash;
    this.chevrons.forEach((c, i) => c.classList.toggle('on', i < level));
    this.heatEl.classList.toggle('is-flash', flash && level > 0);
    this.heatEl.setAttribute('aria-label', `HEAT level ${level}`);
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

  /** The hull bar only shows while driving (on foot the combat HUD shows body and armour). */
  showHealth(on: boolean): void {
    this.healthWrap.hidden = !on;
  }

  setTrace(percent: number): void {
    const v = Math.round(percent);
    if (v === this.last.trace) return;
    this.last.trace = v;
    this.traceEl.hidden = v <= 0;
    this.traceEl.textContent = `TRACE ${v}%`;
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

  toast(text: string, now: number, seconds = 2.5): void {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    this.toastUntil = now + seconds * 1000;
  }

  tick(now: number): void {
    if (!this.toastEl.hidden && now > this.toastUntil) this.toastEl.hidden = true;
    if (!this.dialogueEl.hidden && now > this.dialogueUntil) this.dialogueEl.hidden = true;
  }
}
