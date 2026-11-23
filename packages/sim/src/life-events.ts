/** Events from the living city: emergency services, street crews and crowds (for audio, rendering and HUD). */

export interface ServiceEvent {
  type: 'serviceDispatched' | 'serviceArrived' | 'serviceLeft';
  kind: 'ambulance' | 'fire';
  vehicleId: number;
  x: number;
  z: number;
}

/** A vehicle's siren started or stopped (its beacons may stay on at the scene). */
export interface SirenEvent {
  type: 'siren';
  vehicleId: number;
  on: boolean;
}

export interface PedRevivedEvent {
  type: 'pedRevived';
  pedId: number;
  x: number;
  z: number;
}

export interface FireOutEvent {
  type: 'fireOut';
  vehicleId: number;
  x: number;
  z: number;
}

/** A crew group turned on someone: the player, police officers or a rival crew. */
export interface GangAggroEvent {
  type: 'gangAggro';
  crew: string;
  target: 'player' | 'police' | 'rival';
  x: number;
  z: number;
}

/** A friendly crew member acknowledged the player. */
export interface GangNodEvent {
  type: 'gangNod';
  crew: string;
  pedId: number;
  x: number;
  z: number;
}

/** Two rival crews squared up (the shooting starts after the stand-off). */
export interface GangFightEvent {
  type: 'gangFight';
  crews: [string, string];
  x: number;
  z: number;
}

/** Someone threw themselves out of the way of a car on the pavement. */
export interface PedDiveEvent {
  type: 'pedDive';
  pedId: number;
  x: number;
  z: number;
}

export type LifeEvent = ServiceEvent | SirenEvent | PedRevivedEvent | FireOutEvent | GangAggroEvent | GangNodEvent | GangFightEvent | PedDiveEvent;
