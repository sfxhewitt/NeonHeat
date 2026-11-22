/** Events the simulation emits each step, for rendering, audio, haptics and missions. */
export type ImpactOther = 'static' | 'vehicle' | 'ped' | 'player';

export interface ImpactEvent {
  type: 'impact';
  x: number;
  z: number;
  /** Change in velocity caused by the hit, m/s. */
  strength: number;
  vehicleId: number;
  other: ImpactOther;
  otherId: number;
  involvesPlayer: boolean;
}

export interface VehicleDestroyedEvent {
  type: 'vehicleDestroyed';
  vehicleId: number;
  x: number;
  z: number;
}

export interface ShotEvent {
  type: 'shot';
  x: number;
  z: number;
  /** Where the round ended (hit point or max range). */
  hx: number;
  hz: number;
  hit: 'none' | 'static' | 'vehicle' | 'ped';
}

export interface PedHitEvent {
  type: 'pedHit';
  pedId: number;
  x: number;
  z: number;
  byPlayer: boolean;
}

export interface PlayerEvent {
  type: 'playerHurt' | 'playerDied' | 'playerRespawned' | 'enteredVehicle' | 'exitedVehicle' | 'dodge';
  x: number;
  z: number;
  vehicleId: number;
  amount: number;
}

/** The player used the context action on a mission interactable. */
export interface InteractEvent {
  type: 'interact';
  id: string;
}

/** The player asked to hack a hackable vehicle. */
export interface HackRequestEvent {
  type: 'hackRequested';
  vehicleId: number;
}

/** A vehicle smashed a breakable prop. */
export interface PropBrokenEvent {
  type: 'propBroken';
  propId: number;
  kind: string;
  x: number;
  z: number;
  /** Direction and speed the debris flies. */
  vx: number;
  vz: number;
  byPlayer: boolean;
}

export type SimEvent =
  | PropBrokenEvent
  | ImpactEvent
  | VehicleDestroyedEvent
  | ShotEvent
  | PedHitEvent
  | PlayerEvent
  | InteractEvent
  | HackRequestEvent;
