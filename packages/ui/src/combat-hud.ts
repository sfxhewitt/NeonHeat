/**
 * Combat HUD: body and armour bars, the weapon in hand with its ammo, the
 * street-score chain, the arrest meter, and the FLATLINED / BOOKED card.
 * Writes to the DOM only when a value changes.
 */

/** Original weapon silhouettes (24x24 viewBox), paired with a colour per weapon. */
const ICONS: Record<string, { path: string; colour: string }> = {
  fists: { path: 'M6 10h11a2 2 0 0 1 2 2v3a4 4 0 0 1-4 4H9a3 3 0 0 1-3-3zM6 10V7h3v3M9 10V6h3v4M12 10V6h3v4M15 10V7h3v4', colour: '#f2f2ff' },
  bat: { path: 'M4 20l2 0 12-13a2.5 2.5 0 0 0-3.5-3.5L2 16v2z', colour: '#ff2bd6' },
  pistol: { path: 'M3 8h15v4H11l-1 6H6l1-6H3z', colour: '#f2f2ff' },
  smg: { path: 'M2 8h18v3h-6v2h-3l-1 5H7l1-5H5v-2H2zM14 13h2v5h-2z', colour: '#21f0ff' },
  shotgun: { path: 'M1 9h17l3 1v2H10l-2 6H4l2-6H1z', colour: '#ff9a3c' },
  rifle: { path: 'M1 10h22v2H12l-2 5H6l2-5H1zM9 7h5v3H9z', colour: '#d7ff2b' },
  launcher: { path: 'M2 8h15a3 3 0 0 1 3 3v0a3 3 0 0 1-3 3h-5l-1 5H7l1-5H2z', colour: '#ff3355' },
  arc: { path: 'M3 9h10l2-3h4l-3 5h4l-7 8 2-6h-4l-1 2H3z', colour: '#b98cff' },
};

export interface CombatHudState {
  health: number;
  maxHealth: number;
  armour: number;
  maxArmour: number;
  weapon: string;
  weaponName: string;
  /** -1 when the weapon needs no ammo. */
  ammo: number;
  pending: number;
  multiplier: number;
  credits: number;
  /** 0..1 progress towards BOOKED. */
  arrest: number;
}

export class CombatHud {
  readonly root: HTMLElement;
  private readonly healthFill: HTMLElement;
  private readonly healthBar: HTMLElement;
  private readonly armourFill: HTMLElement;
  private readonly armourWrap: HTMLElement;
  private readonly weaponIcon: SVGPathElement;
  private readonly weaponName: HTMLElement;
  private readonly ammoEl: HTMLElement;
  private readonly scoreEl: HTMLElement;
  private readonly creditsEl: HTMLElement;
  private readonly arrestEl: HTMLElement;
  private readonly arrestFill: HTMLElement;
  private last = { health: -1, armour: -1, weapon: '', ammo: -2, pending: -1, mult: -1, credits: -1, arrest: -1 };

  constructor(hudRoot: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'nh-vitals';
    this.root.innerHTML = `
      <div class="nh-vitals__bars">
        <div class="nh-vital"><span class="nh-bar__label">BODY</span><div class="nh-bar nh-bar--body"><i></i></div></div>
        <div class="nh-vital nh-vital--armour"><span class="nh-bar__label">ARMOUR</span><div class="nh-bar nh-bar--armour"><i></i></div></div>
      </div>
      <div class="nh-weapon" role="status" aria-label="Weapon">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path /></svg>
        <span class="nh-weapon__name"></span><span class="nh-weapon__ammo"></span>
      </div>`;
    this.healthBar = this.root.querySelector('.nh-bar--body') as HTMLElement;
    this.healthFill = this.root.querySelector('.nh-bar--body > i') as HTMLElement;
    this.armourFill = this.root.querySelector('.nh-bar--armour > i') as HTMLElement;
    this.armourWrap = this.root.querySelector('.nh-vital--armour') as HTMLElement;
    this.weaponIcon = this.root.querySelector('.nh-weapon path') as SVGPathElement;
    this.weaponName = this.root.querySelector('.nh-weapon__name') as HTMLElement;
    this.ammoEl = this.root.querySelector('.nh-weapon__ammo') as HTMLElement;
    hudRoot.appendChild(this.root);

    // Score chain and arrest meter sit under the HEAT chevrons.
    const tr = hudRoot.querySelector('.nh-hud__tr') ?? hudRoot;
    this.scoreEl = document.createElement('div');
    this.scoreEl.className = 'nh-score';
    this.scoreEl.hidden = true;
    this.creditsEl = document.createElement('div');
    this.creditsEl.className = 'nh-credits';
    this.arrestEl = document.createElement('div');
    this.arrestEl.className = 'nh-arrest';
    this.arrestEl.hidden = true;
    this.arrestEl.innerHTML = '<span class="nh-bar__label">CUFFS</span><div class="nh-bar nh-bar--arrest"><i></i></div>';
    this.arrestFill = this.arrestEl.querySelector('i') as HTMLElement;
    // Credits themselves are the main HUD's counter; this shows only the street score chain.
    tr.append(this.arrestEl, this.scoreEl);
  }

  update(s: CombatHudState): void {
    const l = this.last;
    const h = Math.round((s.health / s.maxHealth) * 100);
    if (h !== l.health) {
      l.health = h;
      this.healthFill.style.width = `${h}%`;
      this.healthBar.classList.toggle('is-low', h < 30);
    }
    const a = Math.round((s.armour / s.maxArmour) * 100);
    if (a !== l.armour) {
      l.armour = a;
      this.armourFill.style.width = `${a}%`;
      this.armourWrap.classList.toggle('is-empty', a <= 0);
    }
    if (s.weapon !== l.weapon) {
      l.weapon = s.weapon;
      const icon = ICONS[s.weapon] ?? ICONS.pistol!;
      this.weaponIcon.setAttribute('d', icon.path);
      this.weaponIcon.setAttribute('fill', icon.colour);
      this.weaponName.textContent = s.weaponName.toUpperCase();
      this.root.style.setProperty('--nh-weapon', icon.colour);
    }
    if (s.ammo !== l.ammo) {
      l.ammo = s.ammo;
      this.ammoEl.textContent = s.ammo < 0 ? '' : String(s.ammo);
      this.ammoEl.classList.toggle('is-empty', s.ammo === 0);
    }
    const pending = Math.round(s.pending);
    if (pending !== l.pending || s.multiplier !== l.mult) {
      l.pending = pending;
      l.mult = s.multiplier;
      this.scoreEl.hidden = pending <= 0;
      this.scoreEl.textContent = s.multiplier > 1 ? `+${pending.toLocaleString('en-GB')} cr ×${s.multiplier.toFixed(1)}` : `+${pending.toLocaleString('en-GB')} cr`;
    }
    const credits = Math.round(s.credits);
    if (credits !== l.credits) {
      l.credits = credits;
      this.creditsEl.textContent = `${credits.toLocaleString('en-GB')} cr`;
    }
    const arrest = Math.round(s.arrest * 50) / 50;
    if (arrest !== l.arrest) {
      l.arrest = arrest;
      this.arrestEl.hidden = arrest <= 0;
      this.arrestFill.style.width = `${arrest * 100}%`;
    }
  }
}

/**
 * The big card for FLATLINED (health gone) and BOOKED (cuffed), with what it
 * cost. It fades out on its own when the player respawns.
 */
export class FateCard {
  private readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly sub: HTMLElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'nh-fate';
    this.el.hidden = true;
    this.el.setAttribute('role', 'alert');
    this.el.innerHTML = '<div class="nh-fate__title"></div><div class="nh-fate__sub"></div>';
    this.title = this.el.querySelector('.nh-fate__title') as HTMLElement;
    this.sub = this.el.querySelector('.nh-fate__sub') as HTMLElement;
    parent.appendChild(this.el);
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  show(kind: 'flatlined' | 'booked', creditsLost: number, weaponsLost: boolean): void {
    this.el.hidden = false;
    this.el.classList.remove('is-out');
    this.el.classList.toggle('is-booked', kind === 'booked');
    this.title.textContent = kind === 'flatlined' ? 'FLATLINED' : 'BOOKED';
    const cost = creditsLost > 0 ? `${kind === 'flatlined' ? 'Clinic bill' : 'Bail'} ${creditsLost.toLocaleString('en-GB')} cr` : kind === 'flatlined' ? 'Patched up on the house' : 'Released without charge';
    const kit = weaponsLost ? (kind === 'flatlined' ? 'Weapons lost' : 'Weapons confiscated') : '';
    this.sub.textContent = kit ? `${cost} · ${kit}` : cost;
  }

  hide(): void {
    if (this.el.hidden) return;
    this.el.classList.add('is-out');
    setTimeout(() => {
      if (this.el.classList.contains('is-out')) this.el.hidden = true;
    }, 400);
  }
}
