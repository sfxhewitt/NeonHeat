/**
 * The input intent layer. Keyboard, touch and gamepad all write into this one
 * shape; the simulation only ever reads intents, never devices.
 *
 * Screen/stick space: x is right, y is up. The camera has a fixed yaw with
 * north (-Z) at the top of the screen, so stick up means "go north".
 */
export type DriveScheme = 'direction' | 'classic';

export interface Intents {
  /** Movement stick, each axis in [-1, 1]. Used on foot, and when driving with the direction scheme. */
  moveX: number;
  moveY: number;
  /** Classic driving: steer in [-1, 1] (positive = right), throttle and brake in [0, 1]. */
  steer: number;
  throttle: number;
  brake: number;
  /** Which driving scheme the current input source uses. */
  scheme: DriveScheme;
  handbrake: boolean;
  /** Held fire. */
  fire: boolean;
  /** Edge-triggered: true for exactly one step per press. */
  interact: boolean;
  dodge: boolean;
  /** Edge-triggered: cycle to the next owned weapon. */
  nextWeapon: boolean;
}

export function emptyIntents(): Intents {
  return {
    moveX: 0,
    moveY: 0,
    steer: 0,
    throttle: 0,
    brake: 0,
    scheme: 'classic',
    handbrake: false,
    fire: false,
    interact: false,
    dodge: false,
    nextWeapon: false,
  };
}

export function copyIntents(src: Intents, dst: Intents): Intents {
  dst.moveX = src.moveX;
  dst.moveY = src.moveY;
  dst.steer = src.steer;
  dst.throttle = src.throttle;
  dst.brake = src.brake;
  dst.scheme = src.scheme;
  dst.handbrake = src.handbrake;
  dst.fire = src.fire;
  dst.interact = src.interact;
  dst.dodge = src.dodge;
  dst.nextWeapon = src.nextWeapon;
  return dst;
}
