import type { Vehicle, VehicleRole } from '@neonheat/sim';
import type { Game } from './game';

/**
 * Dev-only showroom (?garage=1): every vehicle variant parked in two rows on
 * a city street under the game's own lighting, viewed from the gameplay camera.
 * The sim is frozen; bikes are posed mid-corner so their lean and rider show,
 * emergency and police vehicles have their beacons running. Not part of the
 * normal boot path: boot.ts imports this module only when the flag is set.
 *
 * window.__garage.view(x, z, height) moves the camera; ?labels=1 names each vehicle;
 * ?city=1 keeps the buildings (hidden by default so nothing blocks the view).
 */
export interface GarageHooks {
  vehicles: { id: string; x: number; z: number; length: number }[];
  view: (x: number, z: number, height: number) => void;
  triangles: Record<string, number>;
}

declare global {
  interface Window {
    __garage?: GarageHooks;
  }
}

/** Light vehicles in the near lane, heavies and bikes behind. */
const ROWS: string[][] = [
  ['hatch', 'kestrel', 'saloon', 'taxi', 'estate', 'bastion', 'vandal', 'razorback', 'nightjar', 'prototype', 'mule', 'interceptor', 'enforcer', 'warden'],
  ['sparrow', 'shrike', 'brick', 'patrolvan', 'lifeline', 'stacker', 'ember', 'loopline', 'leviathan'],
];

export function setupGarage(game: Game, opts: { labels: boolean; city: boolean }): void {
  const w = game.world;
  game.setPaused(true);
  w.traffic.cap = 0;
  w.peds.cap = 0;
  w.police.cap = 0;
  for (const p of w.peds.peds) p.active = false;
  if (w.player.vehicle) w.playerCtl.exit();
  for (const v of w.vehicles) if (v.active) w.despawnVehicle(v);
  // Hide the player: neither on foot nor driving, so no person is drawn at the camera focus.
  (w.playerCtl as { mode: string }).mode = 'garage';
  game.overlay.style.visibility = 'hidden';
  if (!opts.city) {
    // A clear floor: buildings and roof clutter hidden, streets, lamps and lighting kept.
    const city = (game as unknown as { city: { buildings: { visible: boolean }; roofProps: { visible: boolean } } }).city;
    city.buildings.visible = false;
    city.roofProps.visible = false;
  }
  // The sim is frozen, but beacons and signs still need a clock to flash by.
  const clock = (): void => {
    w.time += 1 / 60;
    requestAnimationFrame(clock);
  };
  requestAnimationFrame(clock);

  const variants = w.content.vehicles.variants;
  const placed: { v: Vehicle; id: string }[] = [];
  const roadZ = -330; // the long east-west avenue south of Lantern Row
  const lane = 4.5;
  const rowZ = [roadZ + lane, roadZ - lane];
  const all = new Set(Object.keys(variants));
  ROWS.forEach((ids, r) => {
    let x = -58;
    for (const id of ids) {
      if (!all.delete(id)) continue;
      x = place(id, x, rowZ[r]!);
    }
  });
  // Anything not in the hand-made order goes on the end of the back row.
  let x = 50;
  for (const id of all) x = place(id, x, rowZ[1]!);

  function place(id: string, x0: number, z: number): number {
    const p = variants[id]!;
    const cls = p.class;
    const role: VehicleRole = p.role === 'police' ? 'police' : p.role === 'squad' ? 'squad' : 'traffic';
    const v = w.spawnVehicle(id, x0 + p.length / 2, z, Math.PI / 2, role);
    if (!v) return x0;
    v.prevX = v.x;
    v.prevZ = v.z;
    if (p.twoWheel) {
      // Posed mid-corner at speed: the view leans the bike into the turn.
      const speed = 14;
      v.vx = speed;
      v.vz = 0;
      v.yawRate = id === 'shrike' ? 0.9 : -0.7;
    }
    if (cls === 'compact' || cls === 'taxi') v.controls.brake = 1;
    placed.push({ v, id });
    return x0 + p.length + (p.twoWheel ? 1.6 : 2.4);
  }

  const view = (vx: number, vz: number, height: number): void => {
    game.content.camera.heightOnFoot = height;
    w.playerCtl.teleport(vx, vz);
    game.rig.snap({ x: vx, z: vz, vx: 0, vz: 0, speedT: 0, onFoot: true });
  };
  view(-4, roadZ, 80);

  const tri: Record<string, number> = {};
  const viewTri = (game as unknown as { vehiclesView: { triangles: Map<string, number> } }).vehiclesView.triangles;
  for (const [id, n] of viewTri) tri[id] = n;
  window.__garage = {
    vehicles: placed.map(({ v, id }) => ({ id, x: v.x, z: v.z, length: v.params.length })),
    view,
    triangles: tri,
  };

  if (opts.labels) labels(game, placed);
}

/** Small name tags under each vehicle, projected every frame. */
function labels(game: Game, placed: { v: Vehicle; id: string }[]): void {
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;font:600 9px system-ui;color:#fff;';
  document.body.appendChild(root);
  const tags = placed.map(({ v, id }) => {
    const el = document.createElement('div');
    el.textContent = id;
    el.style.cssText = 'position:absolute;transform:translate(-50%,0);text-shadow:0 0 3px #000,0 0 2px #000;white-space:nowrap;';
    root.appendChild(el);
    return { el, v };
  });
  const tick = (): void => {
    const cam = game.rig.camera;
    const rect = game.canvas.getBoundingClientRect();
    for (const t of tags) {
      const p = cam.position.clone().set(t.v.x, 0, t.v.z + t.v.params.width / 2 + 1.2).project(cam);
      t.el.style.left = `${rect.left + (p.x * 0.5 + 0.5) * rect.width}px`;
      t.el.style.top = `${rect.top + (-p.y * 0.5 + 0.5) * rect.height}px`;
    }
    requestAnimationFrame(tick);
  };
  tick();
}
