import { emptyIntents, type DriveScheme, type Intents } from '@neonheat/sim';
import { TouchControls } from './touch-controls';

export type ControlMode = 'driving' | 'foot' | 'menu';

/**
 * The intent layer's device side. Keyboard, touch and gamepad all write into
 * the same Intents structure; the simulation only reads intents.
 */
export class InputManager {
  readonly touch: TouchControls;
  /** Override used by automated tests and the demo bot. */
  override: Intents | null = null;
  private readonly keys = new Set<string>();
  private interactLatch = false;
  private dodgeLatch = false;
  private weaponLatch = false;
  private activityLatch = false;
  private padActivityWas = false;
  private padWeaponWas = false;
  private mouseFire = false;
  private mouseClick = false;
  private padInteractWas = false;
  private padDodgeWas = false;
  private mode: ControlMode = 'driving';

  constructor(root: HTMLElement, touchScheme: DriveScheme) {
    this.touch = new TouchControls(root, touchScheme);
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      this.keys.add(e.code);
      if (e.code === 'KeyE' || e.code === 'KeyF' || e.code === 'Enter') this.interactLatch = true;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.dodgeLatch = true;
      if (e.code === 'KeyQ' || e.code === 'Tab') this.weaponLatch = true;
      if (e.code === 'KeyT') this.activityLatch = true;
      if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    const canvas = document.getElementById('game');
    canvas?.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseFire = this.mouseClick = true;
    });
    window.addEventListener('mouseup', () => (this.mouseFire = false));
  }

  setMode(mode: ControlMode, context: string | null): void {
    this.mode = mode;
    this.touch.setMode(mode, context);
  }

  get touchScheme(): DriveScheme {
    return this.touch.scheme;
  }

  /** Fill `out` with this step's intents. Edge-triggered actions are consumed. */
  sample(out: Intents): Intents {
    if (this.override) {
      Object.assign(out, this.override);
      // Edge actions in an override fire once.
      this.override.interact = false;
      this.override.dodge = false;
      this.override.nextWeapon = false;
      this.override.activity = false;
      return out;
    }
    const e = emptyIntents();
    const k = this.keys;
    const right = k.has('KeyD') || k.has('ArrowRight');
    const left = k.has('KeyA') || k.has('ArrowLeft');
    const up = k.has('KeyW') || k.has('ArrowUp');
    const down = k.has('KeyS') || k.has('ArrowDown');
    e.moveX = (right ? 1 : 0) - (left ? 1 : 0);
    e.moveY = (up ? 1 : 0) - (down ? 1 : 0);
    e.steer = e.moveX;
    e.throttle = up ? 1 : 0;
    e.brake = down ? 1 : 0;
    e.handbrake = k.has('Space');
    // A click shorter than one sim step still fires once.
    e.fire = k.has('KeyJ') || k.has('ControlLeft') || this.mouseFire || this.mouseClick;
    this.mouseClick = false;
    e.scheme = 'classic';
    let interact = this.interactLatch;
    let dodge = this.dodgeLatch;
    let nextWeapon = this.weaponLatch;
    let activity = this.activityLatch;
    this.activityLatch = false;
    this.interactLatch = false;
    this.dodgeLatch = false;
    this.weaponLatch = false;

    // Gamepad.
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      const ax = dead(pad.axes[0] ?? 0);
      const ay = dead(pad.axes[1] ?? 0);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      const a = pad.buttons[0]?.pressed ?? false;
      const rb = pad.buttons[5]?.pressed ?? false;
      if (a && !this.padInteractWas) interact = true;
      if (rb && !this.padDodgeWas) dodge = true;
      // Left shoulder cycles weapons.
      const lb = pad.buttons[4]?.pressed ?? false;
      if (lb && !this.padWeaponWas) nextWeapon = true;
      this.padWeaponWas = lb;
      // Y / triangle: the side-activity button.
      const y = pad.buttons[3]?.pressed ?? false;
      if (y && !this.padActivityWas) activity = true;
      this.padActivityWas = y;
      this.padInteractWas = a;
      this.padDodgeWas = rb;
      if (ax !== 0 || ay !== 0 || rt > 0.05 || lt > 0.05) {
        e.moveX = ax;
        e.moveY = -ay;
        if (rt > 0.05 || lt > 0.05) {
          e.scheme = 'classic';
          e.steer = ax;
          e.throttle = rt;
          e.brake = lt;
        } else {
          e.scheme = 'direction';
        }
      }
      if (pad.buttons[1]?.pressed) e.handbrake = true;
      if (pad.buttons[2]?.pressed) e.fire = true;
      break;
    }

    // Touch overrides when active.
    const t = this.touch.read();
    if (t.active) {
      e.scheme = t.scheme;
      e.moveX = t.moveX;
      e.moveY = t.moveY;
      if (t.scheme === 'classic' && this.mode === 'driving') {
        e.steer = t.steer;
        e.throttle = t.throttle;
        e.brake = t.brake;
      }
    }
    if (t.handbrake) e.handbrake = true;
    if (t.fire) e.fire = true;
    if (t.interact) interact = true;
    if (t.dodge) dodge = true;
    if (t.nextWeapon) nextWeapon = true;
    if (t.activity) activity = true;
    e.interact = interact;
    e.dodge = dodge;
    e.nextWeapon = nextWeapon;
    e.activity = activity;
    return Object.assign(out, e);
  }
}

function dead(v: number): number {
  return Math.abs(v) < 0.18 ? 0 : v;
}
