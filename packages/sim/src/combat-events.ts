import type { CrimeKind } from './heat';

/** Events from the wanted, combat and survival layer. */

/** HEAT changed level. */
export interface HeatEvent {
  type: 'heat';
  level: number;
  previous: number;
  /** up: crimes; escape: lost them; swap: changed car unseen; respray; clear: flatlined, booked or a mission. */
  reason: 'up' | 'escape' | 'swap' | 'respray' | 'clear';
}

/** A crime reached the police: seen by a unit, or phoned in by a witness. */
export interface CrimeReportedEvent {
  type: 'crimeReported';
  kind: CrimeKind;
  x: number;
  z: number;
  by: 'police' | 'witness';
}

export interface MeleeEvent {
  type: 'melee';
  x: number;
  z: number;
  /** Where the blow landed (or would have). */
  hx: number;
  hz: number;
  hit: boolean;
  /** Position in the combo, from 0. */
  combo: number;
}

export interface ExplosionEvent {
  type: 'explosion';
  x: number;
  z: number;
  radius: number;
}

/** The arc caster's chain: up to four points, x/z pairs, `n` points used. */
export interface ArcEvent {
  type: 'arc';
  points: number[];
  n: number;
}

export interface LaunchEvent {
  type: 'launch';
  x: number;
  z: number;
}

export interface PickupEvent {
  type: 'pickup';
  kind: string;
  x: number;
  z: number;
}

export interface WeaponSwitchEvent {
  type: 'weaponSwitched';
  weapon: string;
}

/** Health ran out (FLATLINED) or the police cuffed the player (BOOKED). */
export interface FateEvent {
  type: 'playerWasted' | 'playerBusted';
  x: number;
  z: number;
  creditsLost: number;
}

export interface TyresPoppedEvent {
  type: 'tyresPopped';
  vehicleId: number;
  x: number;
  z: number;
  byPlayer: boolean;
}

export interface ScoreBankedEvent {
  type: 'scoreBanked';
  amount: number;
}

export interface RoadblockEvent {
  type: 'roadblock';
  x: number;
  z: number;
}

export interface ResprayEvent {
  type: 'respray';
  /** broke: could not pay (the shop's verdict; the police verdicts are the others). */
  result: ResprayResult | 'broke';
  /** Credits charged (or asked for, when broke). */
  price?: number;
}

export type ResprayResult = 'cleared' | 'clean' | 'seen' | 'tooHot';

export interface OfficerDownEvent {
  type: 'officerDown';
  officerId: number;
  x: number;
  z: number;
  byPlayer: boolean;
}

export type CombatEvent =
  | HeatEvent
  | CrimeReportedEvent
  | MeleeEvent
  | ExplosionEvent
  | ArcEvent
  | LaunchEvent
  | PickupEvent
  | WeaponSwitchEvent
  | FateEvent
  | TyresPoppedEvent
  | ScoreBankedEvent
  | RoadblockEvent
  | ResprayEvent
  | OfficerDownEvent;
