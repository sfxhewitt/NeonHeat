import { describe, expect, it } from 'vitest';
import { layoutLamps, onPavement, type SimContent, type World } from '@neonheat/sim';
import { EW, intents, loadContent, makeWorld, movePlayer } from './helpers';

/** Aim a car at the kerb of the east-west road at z = road, from the road side, and let it run. */
function crossKerb(w: World, road: number, x: number, side: 1 | -1, angleDeg: number, speed: number, throttle: number, hw = 9) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a);
  const dz = side * Math.sin(a);
  const kerbZ = road + side * hw;
  const car = w.player.vehicle!;
  car.hp = car.params.maxHealth;
  w.teleportVehicle(car, x, kerbZ - side * (1.2 + 2.2 * Math.sin(a)), Math.atan2(dx, dz));
  car.vx = dx * speed;
  car.vz = dz * speed;
  let kerbEvents = 0;
  let kerbLoss = 0;
  let through = false;
  for (let i = 0; i < 360; i++) {
    const before = Math.hypot(car.vx, car.vz);
    const was = car.kerbFront !== car.kerbRear || car.kerbFront;
    w.step(intents({ throttle }));
    kerbEvents += w.events.filter((e) => e.type === 'kerb').length;
    // Speed lost on the steps where an axle crossed the kerb (not to drag or throttle elsewhere).
    if (was !== (car.kerbFront !== car.kerbRear || car.kerbFront) || car.kerbFront !== car.kerbRear) kerbLoss += Math.max(0, before - Math.hypot(car.vx, car.vz));
    if (side * (car.z - kerbZ) > 2.6) {
      through = true;
      break;
    }
  }
  return { through, speed: Math.hypot(car.vx, car.vz), kerbEvents, kerbLoss };
}

/** A stretch of the east-west avenue at z = EW.z with pavement on both sides (no junction mouths). */
const KX = -140;

async function worldWith(edit: (c: SimContent) => void): Promise<World> {
  const c = loadContent();
  c.traffic.count = 0;
  c.peds.count = 0;
  edit(c);
  c.traffic.parkedMax = 0;
  const w = await makeWorld(1, c);
  movePlayer(w, KX, EW.z);
  for (const v of w.vehicles) if (v.active) w.despawnVehicle(v);
  const car = w.spawnVehicle('kestrel', KX, EW.z, 0, 'player')!;
  w.playerCtl.enter(car);
  return w;
}

describe('kerbs', () => {
  it('ride up onto the pavement at any angle and speed, with a bump, not a wall', async () => {
    const w = await worldWith((c) => {
      c.map.buildings = [];
      c.map.props = [];
      delete c.props.kinds['lamp'];
    });
    for (const angle of [15, 35, 60, 90]) {
      for (const speed of [3, 8, 16, 30]) {
        for (const side of [1, -1] as const) {
          const r = crossKerb(w, EW.z, KX + 20, side, angle, speed, 0.35);
          expect(r.through, `${angle}° at ${speed} m/s`).toBe(true);
          // Riding over the step costs only a little speed, even square on.
          expect(r.kerbLoss, `${angle}° at ${speed} m/s`).toBeLessThan(speed * 0.12);
          if (speed >= 8) expect(r.kerbEvents, `${angle}° at ${speed} m/s`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('dropping back off the pavement is gentler than mounting it', async () => {
    const w = await worldWith((c) => {
      c.map.buildings = [];
      c.map.props = [];
      delete c.props.kinds['lamp'];
    });
    const car = w.player.vehicle!;
    const hw = 9;
    // Up: from the road onto the south pavement of the avenue.
    w.teleportVehicle(car, KX + 20, EW.z + hw - 4, 0);
    car.vz = 15;
    let upLoss = 0;
    for (let i = 0; i < 40; i++) {
      const before = Math.hypot(car.vx, car.vz);
      w.step(intents());
      if (w.events.some((e) => e.type === 'kerb' && e.up)) upLoss += before - Math.hypot(car.vx, car.vz);
    }
    // Down: from the pavement onto the road.
    w.teleportVehicle(car, KX + 20, EW.z + hw + 4, Math.PI);
    car.vz = -15;
    let downLoss = 0;
    for (let i = 0; i < 40; i++) {
      const before = Math.hypot(car.vx, car.vz);
      w.step(intents());
      if (w.events.some((e) => e.type === 'kerb' && !e.up)) downLoss += before - Math.hypot(car.vx, car.vz);
    }
    expect(upLoss).toBeGreaterThan(0);
    expect(downLoss).toBeGreaterThan(0);
    expect(downLoss).toBeLessThan(upLoss);
  });

  it('a teleport or spawn onto the pavement makes no bump', async () => {
    const w = await worldWith((c) => {
      c.map.buildings = [];
      c.map.props = [];
    });
    const car = w.player.vehicle!;
    w.teleportVehicle(car, KX + 20, EW.z + 14, 0);
    expect(onPavement(w.content.map, car.x, car.z)).toBe(true);
    w.step(intents());
    expect(w.events.some((e) => e.type === 'kerb')).toBe(false);
  });

  it('every kerb around the start can be crossed: kerbside furniture smashes instead of stopping the car', async () => {
    // The real streets with their props and lamps, minus parked cars (real obstacles, tested elsewhere).
    const w = await worldWith(() => {});
    const map = w.content.map;
    const start = map.markers['player_start']!.pos;
    let runs = 0;
    const snags: string[] = [];
    for (const sg of map.roads.segments) {
      if (sg.z0 !== sg.z1 || sg.kind === 'alley' || sg.kind === 'bridge') continue;
      const hw = sg.width / 2;
      for (let x = Math.ceil(sg.x0 / 18) * 18; x <= sg.x1; x += 18) {
        if (Math.hypot(x - start[0], sg.z0 - start[2]) > 200) continue;
        // Clear of junction mouths: no crossing road within its half-width plus a margin.
        if (w.roads.nodes.some((n) => Math.abs(n.z - sg.z0) < 1 && Math.abs(n.x - x) < 16)) continue;
        // Stunt ramps have side rails: real obstacles, like parked cars.
        if (w.activities.sites.ramps.some((r) => Math.hypot(r.x - x, r.z - sg.z0) < 30)) continue;
        for (const side of [1, -1] as const) {
          const kerbZ = sg.z0 + side * hw;
          // A real kerb with pavement (not a side road, water or a building) just beyond it.
          let pavement = true;
          for (const dx of [-3, 0, 3]) if (!onPavement(map, x + dx, kerbZ + side * 1.5) || w.insideBuilding(x + dx, kerbZ + side * 5.2, 0)) pavement = false;
          if (!pavement) continue;
          for (const angle of [25, 60, 90]) {
            for (const speed of [10, 22]) {
              const r = crossKerb(w, sg.z0, x, side, angle, speed, 1, hw);
              runs++;
              if (!r.through) snags.push(`road z=${sg.z0} x=${x} side ${side} ${angle}° ${speed} m/s`);
              for (const p of w.props.props) {
                if (!p.broken) continue;
                p.broken = false;
                p.collider?.setEnabled(true);
              }
            }
          }
        }
      }
    }
    expect(runs).toBeGreaterThan(100);
    expect(snags).toEqual([]);
  });

  it('street lamps are solid, smash when driven into, and cost speed and hull', async () => {
    const w = await worldWith((c) => {
      c.map.buildings = [];
      c.map.props = [];
    });
    const lamps = layoutLamps(w.content.map);
    const lampProps = w.props.props.filter((p) => p.kind === 'lamp');
    expect(lampProps.length).toBe(lamps.length);
    const lamp = lampProps.filter((p) => Math.abs(p.yaw) < 0.01).sort((a, b) => Math.hypot(a.x - KX, a.z - EW.z) - Math.hypot(b.x - KX, b.z - EW.z))[0]!; // north kerb of an east-west road, arm facing +z
    const car = w.player.vehicle!;
    w.teleportVehicle(car, lamp.x, lamp.z - 8, 0);
    car.vz = 14;
    const hp = car.hp;
    for (let i = 0; i < 40 && !lamp.broken; i++) w.step(intents());
    expect(lamp.broken).toBe(true);
    expect(car.hp).toBeLessThan(hp);
    for (let i = 0; i < 20; i++) w.step(intents());
    expect(car.vz).toBeGreaterThan(9);
  });
});
