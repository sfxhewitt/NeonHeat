import type { VehicleParams } from './content';
import { clamp, wrapAngle } from './physics';

/**
 * Custom arcade vehicle model in the XZ plane.
 *
 * Conventions: yaw 0 faces +Z. Forward is (sin yaw, cos yaw). Positive yaw rate
 * turns the car to its left. Positive steer means "turn right".
 */
export interface DriveControls {
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
}

export function emptyControls(): DriveControls {
  return { steer: 0, throttle: 0, brake: 0, handbrake: false };
}

export interface ArcadeState {
  yaw: number;
  vx: number;
  vz: number;
  yawRate: number;
  drifting: boolean;
}

/**
 * Advance velocities (not positions) of one vehicle by dt. Positions are
 * integrated by the physics step so that collisions can respond.
 */
export function stepArcade(s: ArcadeState, p: VehicleParams, c: DriveControls, dt: number): void {
  const fx = Math.sin(s.yaw);
  const fz = Math.cos(s.yaw);
  // Local +X (the car's left).
  const lx = Math.cos(s.yaw);
  const lz = -Math.sin(s.yaw);
  let vf = s.vx * fx + s.vz * fz;
  let vl = s.vx * lx + s.vz * lz;

  const throttle = clamp(c.throttle, 0, 1);
  const brake = clamp(c.brake, 0, 1);

  // Longitudinal.
  if (throttle > 0 && vf >= -0.5) {
    if (vf < p.topSpeed) {
      const t = Math.max(0, vf) / p.topSpeed;
      vf = Math.min(p.topSpeed, vf + p.acceleration * throttle * (1 - 0.55 * t * t) * dt);
    }
  } else if (throttle > 0) {
    // Throttle while rolling backwards brakes first.
    vf = Math.min(0, vf + p.brakeDecel * throttle * dt);
  }
  if (brake > 0) {
    if (vf > 0.5) vf = Math.max(0, vf - p.brakeDecel * brake * dt);
    else vf = Math.max(-p.reverseTopSpeed, vf - p.acceleration * 0.6 * brake * dt);
  }
  if (throttle === 0 && brake === 0) {
    const drag = (p.rollingDrag + Math.abs(vf) * p.airDrag * Math.abs(vf)) * dt;
    vf = Math.abs(vf) <= drag ? 0 : vf - Math.sign(vf) * drag;
  }
  if (c.handbrake) {
    const d = p.handbrakeDecel * dt;
    vf = Math.abs(vf) <= d ? 0 : vf - Math.sign(vf) * d;
  }
  // Speed cap also covers boosts from collisions.
  if (vf > p.topSpeed * 1.15) vf = p.topSpeed * 1.15;

  // Lateral grip and drift state.
  const slip = Math.abs(vl);
  if (c.handbrake && Math.abs(vf) > 3) s.drifting = true;
  else if (s.drifting && (slip < p.driftExitSlip || (p.twoWheel && !c.handbrake))) s.drifting = false;
  // A two-wheeler leans instead of sliding: only the rear brake (handbrake) breaks it loose.
  else if (!s.drifting && slip > p.driftEnterSlip && !p.twoWheel) s.drifting = true;
  const grip = c.handbrake ? p.grip * p.handbrakeGripMul : s.drifting ? p.driftGrip : p.grip;
  // Tyres can only pull the car sideways so hard: a fast, sharp turn slides
  // (and past driftEnterSlip becomes a drift) instead of snapping round on rails.
  const wanted = vl - vl * Math.exp(-grip * dt);
  const cap = p.latGripMax * (s.drifting ? 0.6 : 1) * dt;
  vl -= clamp(wanted, -cap, cap);
  // Sliding scrubs speed: the more sideways, the more it bleeds.
  if (slip > 1) vf -= Math.sign(vf) * Math.min(Math.abs(vf), slip * 0.35 * dt);

  // Steering: rate scales down with speed and fades in from standstill.
  const speed = Math.abs(vf);
  const speedT = clamp(speed / p.topSpeed, 0, 1);
  const rate = p.steerRateLow + (p.steerRateHigh - p.steerRateLow) * speedT;
  const fadeIn = clamp(speed / p.steerSpeedMin, 0, 1);
  const dir = vf >= 0 ? 1 : -1;
  const steer = clamp(c.steer, -1, 1);
  let target = -steer * rate * fadeIn * dir;
  if (c.handbrake) target *= p.handbrakeSteerBoost;
  if (s.drifting) target *= p.driftSteerMul;
  // With the tyres gripping, the nose can only swing as fast as grip can bend the car's path
  // (plus a little slip). The handbrake or a drift lifts the limit.
  if (!c.handbrake && !s.drifting && speed > 4) {
    const maxYaw = (p.latGripMax * 1.5) / speed;
    target = clamp(target, -maxYaw, maxYaw);
  }
  if (Math.abs(steer) < 0.05 && !s.drifting) {
    // Auto-straighten: kill residual yaw quickly when not steering.
    s.yawRate *= Math.exp(-p.autoStraighten * dt);
  } else {
    s.yawRate += (target - s.yawRate) * Math.min(1, p.steerResponse * dt);
  }

  s.vx = fx * vf + lx * vl;
  s.vz = fz * vf + lz * vl;
}

/** Forward speed of a state along its heading. */
export function forwardSpeed(s: ArcadeState): number {
  return s.vx * Math.sin(s.yaw) + s.vz * Math.cos(s.yaw);
}

/**
 * Direction steering: the stick says which way to go in world space (stick up
 * is north, -Z). Converts that into classic controls for the arcade model.
 */
export function directionToControls(
  s: ArcadeState,
  moveX: number,
  moveY: number,
  out: DriveControls,
  deadzone = 0.15,
  releaseBrake = 0.45,
): DriveControls {
  const mag = Math.min(1, Math.hypot(moveX, moveY));
  out.handbrake = false;
  if (mag < deadzone) {
    // Let go and the car pulls up (gently, never into reverse): no pedals to learn.
    const vf0 = forwardSpeed(s);
    out.steer = 0;
    out.throttle = 0;
    out.brake = vf0 > 1 ? releaseBrake : 0;
    return out;
  }
  const desiredYaw = Math.atan2(moveX, -moveY);
  const diff = wrapAngle(desiredYaw - s.yaw);
  const vf = forwardSpeed(s);
  const gain = 2.2;
  if (Math.abs(diff) > 2.3 && vf < 5) {
    // Target is behind us and we are slow: reverse while swinging the nose round.
    out.throttle = 0;
    out.brake = mag;
    out.steer = clamp(diff * gain, -1, 1);
  } else {
    const ad = Math.abs(diff);
    out.steer = -clamp(diff * gain, -1, 1);
    out.throttle = mag * (1 - 0.45 * clamp(ad / Math.PI, 0, 1));
    out.brake = 0;
    // Touch assists: lift and brake into a sharp change of direction at speed,
    // and flick the handbrake for a hairpin so the car drifts round instead of ploughing on.
    if (ad > 1.0 && vf > 14) {
      out.throttle = 0;
      out.brake = clamp((ad - 1.0) * 0.8, 0, 0.7) * mag;
    }
    if (ad > 1.9 && vf > 12) out.handbrake = true;
  }
  return out;
}
