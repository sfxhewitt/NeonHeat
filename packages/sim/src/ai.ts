import { clamp, wrapAngle } from './physics';
import { forwardSpeed, type ArcadeState, type DriveControls } from './vehicle';

/** hold: parked while its officers are out; roadblock: parked across the road. */
export type AiMode = 'idle' | 'drive' | 'reverse' | 'stunned' | 'leave' | 'hold' | 'roadblock';

/** Per-vehicle AI scratch state, preallocated with the vehicle. */
export interface AiState {
  mode: AiMode;
  /** Seconds left in a timed mode (reverse, stunned). */
  timer: number;
  stuckTime: number;
  targetX: number;
  targetZ: number;
  targetSpeed: number;
  /** Aggressive driving: no slowing for corners (pursuit, ramming). */
  aggressive: boolean;
  /** Traffic: which lane loop and arc position. */
  loop: number;
  s: number;
  /** Pursuit: does this unit currently see the player? */
  sees: boolean;
  /** Pursuit: wander target node while searching. */
  searchNode: number;
  /** Steering held while reversing out of a jam. */
  revSteer: number;
  /** Road-graph node currently driven towards, or -1. */
  waypoint: number;
  /** Pursuit role among the units on the case (0 chase/PIT, 1 flank, 2 cut-off). */
  slot: number;
  /** Seconds before this unit may put officers on the street again. */
  cooldown: number;
}

export function makeAiState(): AiState {
  return {
    mode: 'idle',
    timer: 0,
    stuckTime: 0,
    targetX: 0,
    targetZ: 0,
    targetSpeed: 0,
    aggressive: false,
    loop: 0,
    s: 0,
    sees: false,
    searchNode: -1,
    revSteer: 0,
    waypoint: -1,
    slot: 0,
    cooldown: 0,
  };
}

export function resetAiState(a: AiState): void {
  Object.assign(a, makeAiState());
}

/** Steer and pedal towards a point at a target speed. Shared by traffic, police and the bot. */
export function driveTowards(
  v: ArcadeState & { x: number; z: number },
  tx: number,
  tz: number,
  targetSpeed: number,
  c: DriveControls,
  aggressive = false,
): void {
  const desiredYaw = Math.atan2(tx - v.x, tz - v.z);
  const diff = wrapAngle(desiredYaw - v.yaw);
  const vf = forwardSpeed(v);
  c.steer = -clamp(diff * 2.6, -1, 1);
  c.handbrake = false;
  const turnSlow = aggressive ? 0.35 : 0.65;
  const speed = targetSpeed * (1 - turnSlow * clamp(Math.abs(diff) / 1.2, 0, 1));
  if (vf < speed - 0.3) {
    c.throttle = clamp((speed - vf) / 4, 0.25, 1);
    c.brake = 0;
  } else if (vf > speed + 1.5) {
    c.throttle = 0;
    c.brake = clamp((vf - speed) / 8, 0.1, 1);
  } else {
    c.throttle = 0.15;
    c.brake = 0;
  }
  // Sharp turn at speed: a dab of handbrake helps aggressive drivers rotate.
  if (aggressive && Math.abs(diff) > 1.1 && vf > 14) c.handbrake = true;
  if (targetSpeed <= 0.01) {
    c.throttle = 0;
    c.brake = vf > 0.3 ? 1 : 0;
  }
}

/**
 * Track stuck time and switch into a short reverse when a vehicle that wants
 * to move has not moved. Returns true while reversing (controls written).
 */
export function handleStuck(
  v: ArcadeState & { ai: AiState; controls: DriveControls },
  dt: number,
  stuckSec: number,
  reverseSec: number,
): boolean {
  const a = v.ai;
  const c = v.controls;
  if (a.mode === 'reverse') {
    a.timer -= dt;
    c.throttle = 0;
    c.brake = 1;
    c.steer = a.revSteer;
    c.handbrake = false;
    if (a.timer <= 0) {
      a.mode = 'drive';
      a.stuckTime = 0;
    }
    return true;
  }
  const vf = Math.abs(forwardSpeed(v));
  if (a.targetSpeed > 2 && vf < 1.2) a.stuckTime += dt;
  else a.stuckTime = Math.max(0, a.stuckTime - dt * 2);
  if (a.stuckTime > stuckSec) {
    a.mode = 'reverse';
    a.timer = reverseSec;
    a.revSteer = c.steer === 0 ? 1 : -Math.sign(c.steer);
    a.stuckTime = 0;
  }
  return false;
}
