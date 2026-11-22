import type { DebugPanel, SliderSpec } from '@neonheat/ui';
import type { VehicleParams } from '@neonheat/sim';
import type { Game } from './game';

const VEHICLE_SLIDERS: SliderSpec[] = [
  { key: 'acceleration', min: 4, max: 30 },
  { key: 'topSpeed', min: 10, max: 60 },
  { key: 'brakeDecel', min: 5, max: 60 },
  { key: 'grip', min: 1, max: 20 },
  { key: 'driftGrip', min: 0.2, max: 6 },
  { key: 'handbrakeGripMul', min: 0.02, max: 1 },
  { key: 'driftEnterSlip', min: 2, max: 16 },
  { key: 'driftExitSlip', min: 0.5, max: 8 },
  { key: 'steerRateLow', min: 0.5, max: 6 },
  { key: 'steerRateHigh', min: 0.5, max: 6 },
  { key: 'steerResponse', min: 1, max: 30 },
  { key: 'handbrakeSteerBoost', min: 1, max: 3 },
  { key: 'driftSteerMul', min: 0.5, max: 3 },
  { key: 'autoStraighten', min: 0, max: 30 },
  { key: 'mass', min: 400, max: 4000, step: 10 },
];

const CAMERA_SLIDERS: SliderSpec[] = [
  { key: 'pitchDeg', min: 55, max: 65, step: 0.5 },
  { key: 'fovDeg', min: 28, max: 36, step: 0.5 },
  { key: 'heightMin', min: 20, max: 120 },
  { key: 'heightMax', min: 20, max: 160 },
  { key: 'heightOnFoot', min: 15, max: 100 },
  { key: 'heightLerp', min: 0.2, max: 8 },
  { key: 'lookAheadSec', min: 0, max: 2 },
  { key: 'lookAheadMax', min: 0, max: 50 },
  { key: 'lookAheadLerp', min: 0.2, max: 10 },
  { key: 'followLerp', min: 1, max: 30 },
];

async function save(file: string, data: unknown, btn: HTMLButtonElement): Promise<void> {
  const label = btn.textContent;
  try {
    const res = await fetch(`/__neon/tune?file=${file}`, { method: 'POST', body: JSON.stringify(data) });
    btn.textContent = res.ok ? 'Saved ✓' : `Failed (${res.status})`;
  } catch {
    btn.textContent = 'Failed (no dev server)';
  }
  setTimeout(() => (btn.textContent = label), 1500);
}

/** Live tuning sliders for every handling and camera value, saved back to content JSON. */
export function setupTuning(debug: DebugPanel, game: Game): void {
  const vehicles = game.content.sim.vehicles;
  const veh = debug.addGroup('Handling');
  let current = vehicles.player;
  const sliders = document.createElement('div');
  const build = (): void => {
    sliders.innerHTML = '';
    const p = vehicles.variants[current] as VehicleParams;
    for (const spec of VEHICLE_SLIDERS) debug.addSlider(sliders, p, spec, () => game.onVehicleParamsChanged(current));
  };
  debug.addSelect(veh, 'variant', Object.keys(vehicles.variants), current, (v) => {
    current = v;
    build();
  });
  veh.appendChild(sliders);
  build();
  const vs = debug.addButton(veh, 'Save vehicles.json', () => void save('vehicles', vehicles, vs));

  const cam = debug.addGroup('Camera');
  for (const spec of CAMERA_SLIDERS) debug.addSlider(cam, game.content.camera, spec);
  const cs = debug.addButton(cam, 'Save camera.json', () => void save('camera', game.content.camera, cs));

  const cheats = debug.addGroup('World');
  debug.addButton(cheats, 'Respawn car', () => game.respawnPlayerCar());
  for (const name of Object.keys(vehicles.variants)) debug.addButton(cheats, `Drive ${name}`, () => game.respawnPlayerCar(name));
}
