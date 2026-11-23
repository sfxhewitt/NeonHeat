/**
 * The slice of world state the sound layer reads each frame. Structural, so the sim's `World`
 * satisfies it directly and audio never depends on sim internals (or the sim on audio).
 */
export interface AudioVehicleView {
  id: number;
  active: boolean;
  x: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  variantId: string;
  role: string;
  destroyed: boolean;
  drifting: boolean;
  controls: { throttle: number; brake: number; handbrake: boolean };
  params: { topSpeed: number };
  /** An ambulance or fire tender on a call (police sirens follow HEAT). */
  siren?: boolean;
}

export interface AudioPedView {
  active: boolean;
  state: string;
  x: number;
  z: number;
}

export interface AudioWorldView {
  vehicles: readonly AudioVehicleView[];
  player: { vehicle: { id: number } | null; vx: number; vz: number };
  playerCtl: { mode: string; x: number; z: number; vx: number; vz: number };
  heat: { level: number };
  police?: { drone: { active: boolean; x: number; z: number; vx: number; vz: number } };
  peds?: { peds: readonly AudioPedView[] };
}

/** Any sim event: audio switches on `type` and ignores what it does not know. */
export interface AudioEvent {
  readonly type: string;
}
