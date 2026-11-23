/** The car radio button (shown while driving) and the station name that flashes up on a change. */
export class RadioButton {
  readonly button: HTMLButtonElement;
  private readonly label: HTMLElement;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement, onTap: () => void) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'nh-radio-btn';
    this.button.setAttribute('aria-label', 'Change radio station');
    this.button.innerHTML = '<span>FM</span>';
    this.button.hidden = true;
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      onTap();
    });
    parent.appendChild(this.button);
    this.label = document.createElement('div');
    this.label.className = 'nh-radio-label';
    this.label.hidden = true;
    parent.appendChild(this.label);
  }

  setVisible(on: boolean): void {
    if (this.button.hidden === !on) return;
    this.button.hidden = !on;
    if (!on) this.label.hidden = true;
  }

  /** Flash the station name (null = radio off). */
  show(name: string | null, frequency = '', colour = '#9fe8f0'): void {
    this.label.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = name ?? 'RADIO OFF';
    this.label.appendChild(b);
    if (name && frequency) {
      const s = document.createElement('small');
      s.textContent = `${frequency} FM`;
      this.label.appendChild(s);
    }
    this.label.style.setProperty('--nh-station', colour);
    this.button.style.setProperty('--nh-station', name ? colour : '#6b6aa0');
    this.label.hidden = false;
    this.label.classList.remove('is-in');
    void this.label.offsetWidth;
    this.label.classList.add('is-in');
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => (this.label.hidden = true), 2600);
  }
}
