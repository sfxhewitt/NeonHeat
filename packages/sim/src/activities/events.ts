/** Events from the side activities, for the HUD, cards, sound and haptics. */

export interface JumpTakeoffEvent {
  type: 'jumpTakeoff';
  vehicleId: number;
  /** Ramp left from ('' off anything else). */
  rampId: string;
  /** Predicted seconds in the air: the renderer slows time for a big one. */
  air: number;
  speed: number;
  x: number;
  z: number;
}

export interface JumpLandedEvent {
  type: 'jumpLanded';
  vehicleId: number;
  rampId: string;
  distance: number;
  air: number;
  height: number;
  reward: number;
  /** First clearing of this ramp's target distance. */
  unique: boolean;
  /** A new best off this ramp (after the first). */
  best: boolean;
  /** Vertical speed into the ground (m/s). */
  impact: number;
  byPlayer: boolean;
  x: number;
  z: number;
}

export interface RampageEvent {
  type: 'rampage';
  id: string;
  phase: 'ready' | 'go' | 'progress' | 'passed' | 'failed' | 'cancelled';
  count: number;
  target: number;
  /** passed: credits paid; first: the first pass of this one. */
  reward: number;
  first: boolean;
  seconds: number;
}

export interface ShardEvent {
  type: 'shardFound';
  id: string;
  found: number;
  total: number;
  reward: number;
  /** Credits for reaching a milestone (every N found), else 0. */
  milestone: number;
  x: number;
  z: number;
}

export interface FareEvent {
  type: 'fare';
  job: string;
  phase: 'onDuty' | 'offDuty' | 'newFare' | 'pickedUp' | 'delivered' | 'lost';
  pay: number;
  tip: number;
  bonus: number;
  streak: number;
  /** lost / offDuty: why. */
  reason: string;
}

export interface RaceEvent {
  type: 'race';
  id: string;
  phase: 'countdown' | 'go' | 'checkpoint' | 'lap' | 'finished' | 'failed' | 'cancelled';
  /** Current or final place, from 1. */
  place: number;
  racers: number;
  lap: number;
  laps: number;
  seconds: number;
  reward: number;
  best: boolean;
  reason: string;
}

export type ActivityEvent = JumpTakeoffEvent | JumpLandedEvent | RampageEvent | ShardEvent | FareEvent | RaceEvent;
