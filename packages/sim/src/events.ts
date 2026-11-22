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

export type SimEvent = ImpactEvent | VehicleDestroyedEvent;
