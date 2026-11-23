import { describe, expect, it } from 'vitest';
import { Look, SIM_DT, onPavement, trafficLight, type SimEvent, type World } from '@neonheat/sim';
import { EW, intents, makeWorld, movePlayer } from './helpers';

/** Step the world, collecting events, until `done` returns true or `seconds` pass. Returns the seconds taken. */
function runUntil(w: World, seconds: number, done: () => boolean, seen: SimEvent[] = []): number {
  const steps = Math.round(seconds / SIM_DT);
  const i0 = intents();
  for (let i = 0; i < steps; i++) {
    w.step(i0);
    for (const e of w.events) seen.push(e);
    if (done()) return (i + 1) * SIM_DT;
  }
  return Infinity;
}

/** A quiet world: no ambient people or traffic unless a test adds them. */
async function quietWorld(seed = 1): Promise<World> {
  const w = await makeWorld(seed);
  w.weather.locked = true;
  w.weather.set('clear', 1e9);
  // People placed by a test stay put however far they are from the player.
  w.peds.config = { ...w.peds.config, respawnMinDist: 2000 };
  w.gangs.cap = 0;
  w.gangs.carCap = 0;
  w.gangs.config.fight.chance = 0;
  return w;
}

/** A pavement point beside the long east-west avenue (z = -330), near x (north side first). */
function pavementBy(w: World, x: number): { x: number; z: number } {
  for (const sign of [-1, 1]) {
    for (let dz = 9.5; dz < 15; dz += 0.5) {
      const z = EW.z + dz * sign;
      if (onPavement(w.content.map, x, z) && !w.insideBuilding(x, z, 1)) return { x, z };
    }
  }
  throw new Error('no pavement');
}

describe('emergency services', () => {
  it('sends an ambulance to a knocked-down ped: paramedics revive them and drive off', async () => {
    const w = await quietWorld();
    w.peds.cap = 0;
    movePlayer(w, EW.x, EW.z - 30);
    const spot = pavementBy(w, EW.x + 10);
    const p = w.peds.spawnPedAt(spot.x, spot.z)!;
    w.peds.knockDown(p, 0, 0, false, false);
    w.services.requestAmbulance(p.id);
    const seen: SimEvent[] = [];
    const t = runUntil(w, 90, () => seen.some((e) => e.type === 'serviceLeft'), seen);
    const types = seen.map((e) => e.type);
    expect(types).toContain('serviceDispatched');
    expect(types).toContain('serviceArrived');
    expect(seen.some((e) => e.type === 'pedRevived' && e.pedId === p.id)).toBe(true);
    expect(t).toBeLessThan(90);
    expect(p.active && p.state).toBe('wander');
    const dispatched = seen.find((e) => e.type === 'serviceDispatched')!;
    const v = w.vehicles[(dispatched as { vehicleId: number }).vehicleId]!;
    expect(v.variantId).toBe('lifeline');
    // Lights off, back in traffic.
    expect(v.role).toBe('traffic');
    expect(v.beacons).toBe(false);
    expect(v.siren).toBe(false);
    expect(w.services.activeUnits()).toBe(0);
  });

  it('paramedics kneel by the patient, dressed as paramedics', async () => {
    const w = await quietWorld(2);
    w.peds.cap = 0;
    movePlayer(w, EW.x, EW.z - 30);
    const spot = pavementBy(w, EW.x - 20);
    const p = w.peds.spawnPedAt(spot.x, spot.z)!;
    w.peds.knockDown(p, 0, 0, false, false);
    w.services.requestAmbulance(p.id);
    let kneeling = 0;
    runUntil(w, 90, () => {
      kneeling = 0;
      for (const q of w.peds.peds) {
        if (!q.active || q.owner !== 'service') continue;
        expect(w.peds.tags.look[q.id]).toBe(Look.medic);
        if (w.peds.tags.anim[q.id] === 1 && Math.hypot(q.x - p.x, q.z - p.z) < 1.6) kneeling++;
      }
      return kneeling >= 2;
    });
    expect(kneeling).toBe(2);
  });

  it('sends a fire tender to a burning wreck, which puts the fire out', async () => {
    const w = await quietWorld();
    movePlayer(w, EW.x, EW.z - 40);
    const car = w.spawnVehicle('saloon', EW.x + 20, EW.z + 3, Math.PI / 2, 'parked')!;
    w.damageVehicle(car, 1e6);
    expect(w.services.ignite(car.id)).toBe(true);
    expect(w.services.burnOf(car.id)).toBe(1);
    const seen: SimEvent[] = [];
    let hosing = false;
    runUntil(
      w,
      120,
      () => {
        for (const q of w.peds.peds) if (q.active && q.owner === 'service' && w.peds.tags.anim[q.id] === 3) hosing = true;
        return seen.some((e) => e.type === 'serviceLeft');
      },
      seen,
    );
    expect(seen.some((e) => e.type === 'serviceDispatched' && e.kind === 'fire')).toBe(true);
    expect(hosing).toBe(true);
    expect(seen.some((e) => e.type === 'fireOut' && e.vehicleId === car.id)).toBe(true);
    expect(w.services.burnOf(car.id)).toBe(0);
    // Put out far faster than it would burn out on its own.
    expect(w.time).toBeLessThan(w.services.config.burnSec * 0.6);
  });

  it('caps responders at the tier limit', async () => {
    const w = await quietWorld();
    w.peds.cap = 0;
    w.services.cap = 1;
    movePlayer(w, EW.x, EW.z - 30);
    for (const dx of [-60, 0, 60]) {
      const s = pavementBy(w, EW.x + dx);
      const q = w.peds.spawnPedAt(s.x, s.z)!;
      w.peds.knockDown(q, 0, 0, false, false);
      w.services.requestAmbulance(q.id);
    }
    let most = 0;
    runUntil(w, 30, () => {
      most = Math.max(most, w.services.activeUnits());
      return false;
    });
    expect(most).toBe(1);
  });

  it('traffic ahead of a siren pulls over to the kerb and slows', async () => {
    const w = await quietWorld();
    w.peds.cap = 0;
    w.traffic.cap = 0;
    for (const v of w.vehicles) if (v.active && v.role === 'traffic') w.despawnVehicle(v);
    // Eastbound on the avenue, just past a junction, in the right-hand lane (+z of the centre line).
    const n = w.roads.nodes.find((q) => q.z === EW.z && q.x > EW.x && q.x < EW.x + 200 && q.links.some((l) => w.roads.nodes[l]!.z === EW.z && w.roads.nodes[l]!.x - q.x > 40))!;
    const next = n.links.find((l) => w.roads.nodes[l]!.z === EW.z && w.roads.nodes[l]!.x > n.x)!;
    movePlayer(w, n.x + 10, EW.z - 30);
    const lane = 18 / 4;
    const car = w.spawnVehicle('saloon', n.x + 12, EW.z + lane, Math.PI / 2, 'traffic')!;
    car.ai.mode = 'drive';
    car.ai.navFrom = n.id;
    car.ai.navTo = next;
    car.ai.cruise = 12;
    car.vx = 12;
    car.body!.setLinvel({ x: 12, y: 0, z: 0 }, true);
    const amb = w.spawnVehicle('lifeline', n.x - 14, EW.z + 1.5, Math.PI / 2, 'service')!;
    amb.siren = true;
    amb.beacons = true;
    amb.vx = 12;
    runUntil(w, 0.3, () => false);
    // The driver decides to move over and slow down...
    expect(car.ai.targetSpeed).toBeLessThanOrEqual(w.services.config.pullOver.speed);
    expect(car.ai.targetZ - EW.z).toBeGreaterThan(lane + 1);
    // ...and does.
    runUntil(w, 1.5, () => false);
    expect(car.z - EW.z).toBeGreaterThan(lane + 0.6);
    expect(Math.hypot(car.vx, car.vz)).toBeLessThan(8);
    // Siren gone: back to the lane at cruising speed.
    w.despawnVehicle(amb);
    runUntil(w, 1.5, () => false);
    expect(car.ai.targetSpeed).toBeGreaterThan(6);
    expect(Math.abs(car.ai.targetZ - EW.z - lane)).toBeLessThan(0.3);
  });

  it('police cars with lights on a case make traffic pull over too', async () => {
    const w = await quietWorld();
    const cop = w.spawnVehicle('interceptor', EW.x, EW.z + 1, Math.PI / 2, 'police')!;
    cop.ai.mode = 'drive';
    cop.vx = 15;
    const car = w.spawnVehicle('saloon', EW.x + 25, EW.z + 4.5, Math.PI / 2, 'traffic')!;
    w.heat.addPoints(200, EW.x, EW.z);
    w.services.step(SIM_DT);
    expect(w.services.sirenOn(cop)).toBe(true);
    expect(w.services.pullOver(car)).toBe(true);
    w.heat.clear();
    w.services.step(SIM_DT * 120);
    expect(w.services.sirenOn(cop)).toBe(false);
  });
});

describe('street crews', () => {
  async function crewWorld(crewId: string, respect: number): Promise<{ w: World; crew: number }> {
    const w = await quietWorld();
    w.peds.cap = 0;
    const crew = w.gangs.indexOf(crewId);
    expect(crew).toBeGreaterThanOrEqual(0);
    w.gangs.setRespect(crewId, respect);
    return { w, crew };
  }

  /** A crew group at its nearest spot to the player, the player `dist` metres away with a clear view. */
  function meetGroup(w: World, crew: number, dist: number): { x: number; z: number } {
    const c = w.gangs.crews[crew]!;
    for (const s of c.spots) {
      for (let a = 0; a < 8; a++) {
        const x = s.x + Math.sin(a * 0.785) * dist;
        const z = s.z + Math.cos(a * 0.785) * dist;
        if (w.insideBuilding(x, z, 1) || !w.police.lineOfSight(x, z, s.x, s.z)) continue;
        movePlayer(w, x, z);
        w.gangs.spawnGroup(crew, s.x, s.z, 4, c.spots.indexOf(s));
        return s;
      }
    }
    throw new Error('no spot with a view');
  }

  it('lays out loitering spots in each crew turf', async () => {
    const w = await makeWorld();
    expect(w.gangs.crews.length).toBe(5);
    for (const c of w.gangs.crews) {
      expect(c.spots.length).toBeGreaterThan(4);
      for (const s of c.spots) expect(w.content.map.districts[c.district]!.rects.some((r) => s.x >= r[0] && s.x <= r[2] && s.z >= r[1] && s.z <= r[3])).toBe(true);
    }
  });

  it('hostile crews shoot on sight in their turf', async () => {
    const { w, crew } = await crewWorld('glasshounds', -40);
    expect(w.gangs.attitude('glasshounds')).toBe('hostile');
    meetGroup(w, crew, 14);
    const seen: SimEvent[] = [];
    runUntil(w, 8, () => seen.some((e) => e.type === 'shot' && !e.byPlayer), seen);
    expect(seen.some((e) => e.type === 'gangAggro' && e.target === 'player')).toBe(true);
    expect(seen.some((e) => e.type === 'shot' && !e.byPlayer)).toBe(true);
    expect(w.gangs.hostileCount).toBeGreaterThan(0);
  });

  it('neutral crews ignore the player until attacked, and it is not a police crime unless police see it', async () => {
    const { w, crew } = await crewWorld('glasshounds', 0);
    meetGroup(w, crew, 8);
    const seen: SimEvent[] = [];
    runUntil(w, 6, () => false, seen);
    expect(seen.some((e) => e.type === 'gangAggro' || (e.type === 'shot' && !e.byPlayer))).toBe(false);
    const m = w.gangs.members.find((q) => q.active)!;
    w.combat.damageTarget('ped', m.pedId, 10, 0, 0, true);
    const g = w.gangs.groupOf(m);
    expect(g.mode).toBe('fight');
    expect(g.grudge).toBeGreaterThan(0);
    runUntil(w, 8, () => seen.some((e) => e.type === 'shot' && !e.byPlayer), seen);
    expect(seen.some((e) => e.type === 'shot' && !e.byPlayer)).toBe(true);
    expect(w.heat.points).toBe(0);
    expect(w.police.witnesses.pendingCount()).toBe(0);
  });

  it('friendly crews nod to the player and do not attack', async () => {
    const { w, crew } = await crewWorld('glasshounds', 40);
    expect(w.gangs.attitude('glasshounds')).toBe('friendly');
    const s = meetGroup(w, crew, 12);
    const seen: SimEvent[] = [];
    runUntil(w, 1, () => false, seen);
    w.playerCtl.teleport(s.x + 3.5, s.z);
    runUntil(w, 5, () => seen.some((e) => e.type === 'gangNod'), seen);
    expect(seen.some((e) => e.type === 'gangNod')).toBe(true);
    expect(seen.some((e) => e.type === 'gangAggro' && e.target === 'player')).toBe(false);
  });

  it('respect from the mission director reaches the crews', async () => {
    const w = await makeWorld();
    w.gangs.setAllRespect({ kurogane: -30, glasshounds: 25 });
    expect(w.gangs.attitude('kurogane')).toBe('hostile');
    expect(w.gangs.attitude('glasshounds')).toBe('friendly');
    expect(w.gangs.attitude('rustmouth')).toBe('neutral');
  });

  it('rival crews square up, then fight', async () => {
    const { w, crew } = await crewWorld('glasshounds', 0);
    meetGroup(w, crew, 30);
    const home = w.gangs.groups.find((g) => g.active)!;
    const squad = w.gangs.startFight(home, w.gangs.indexOf('kurogane'));
    expect(squad).not.toBeNull();
    const seen: SimEvent[] = [];
    runUntil(w, 50, () => seen.some((e) => e.type === 'shot' && !e.byPlayer), seen);
    expect(seen.some((e) => e.type === 'gangFight')).toBe(true);
    expect(seen.some((e) => e.type === 'shot' && !e.byPlayer)).toBe(true);
  });

  it('crew cars cruise their turf in crew colours', async () => {
    const w = await quietWorld();
    w.gangs.carCap = 2;
    // Stand in Ashgrove (Glasshounds turf) and let cars stream in.
    runUntil(w, 6, () => false);
    const cars = w.vehicles.filter((v) => v.active && w.gangs.carCrew[v.id]! >= 0);
    expect(cars.length).toBeGreaterThan(0);
    for (const v of cars) expect(w.gangs.crews[w.gangs.carCrew[v.id]!]!.config.cars).toContain(v.variantId);
  });
});

describe('crowds', () => {
  it('people at a crossing only step into the road on red for that road', async () => {
    const w = await quietWorld();
    w.peds.cap = 0;
    // A light-controlled junction near the start.
    const j = w.roads.nodes.find((n) => n.junction && Math.hypot(n.x - w.player.x, n.z - w.player.z) < 200 && n.edges.every((e) => w.roads.edges[e]!.kind !== 'alley'))!;
    movePlayer(w, j.x + 30, j.z + 30);
    let tested = 0;
    for (const [ox, oz] of [
      [12, 12],
      [-12, 12],
      [12, -12],
      [-12, -12],
    ] as const) {
      const p = w.peds.spawnPedAt(j.x + ox, j.z + oz);
      if (!p || w.roads.onRoad(p.x, p.z)) continue;
      if (!w.crowds.startCrossing(p, j.id)) continue;
      tested++;
      let onRoad = false;
      let crossed = false;
      runUntil(w, 70, () => {
        const nowOn = w.roads.onRoad(p.x, p.z);
        if (nowOn && !onRoad) {
          // Stepping off the kerb: the axis being crossed must have red.
          const e = w.content.traffic.lights;
          const alongX = w.crowds['axisX'][p.id] === 1;
          expect(trafficLight(j, alongX, w.time, e)).toBe('red');
        }
        if (onRoad && !nowOn) crossed = true;
        onRoad = nowOn;
        return crossed && w.crowds.taskOf(p.id) === 'none';
      });
      expect(crossed).toBe(true);
    }
    expect(tested).toBeGreaterThan(0);
  });

  it('a crowd gathers round a wreck, then scatters at gunfire', async () => {
    const w = await quietWorld();
    w.peds.cap = 0;
    movePlayer(w, EW.x, EW.z - 40);
    const car = w.spawnVehicle('saloon', EW.x + 10, EW.z + 3, Math.PI / 2, 'parked')!;
    for (let k = 0; k < 8; k++) {
      const s = pavementBy(w, EW.x - 6 + k * 3);
      w.peds.spawnPedAt(s.x, s.z);
    }
    w.services.cap = 0;
    w.damageVehicle(car, 1e6);
    w.crowds.addIncident(car.x, car.z, 'wreck');
    let gawkers = 0;
    runUntil(w, 20, () => {
      gawkers = w.peds.peds.filter((p) => p.active && w.crowds.taskOf(p.id) === 'gawk' && w.peds.tags.anim[p.id] === 6).length;
      return gawkers >= 3;
    });
    expect(gawkers).toBeGreaterThanOrEqual(3);
    w.peds.alarm(car.x, car.z, 40);
    w.step(intents());
    expect(w.peds.peds.filter((p) => p.active && w.crowds.taskOf(p.id) === 'gawk').length).toBe(0);
    expect(w.peds.peds.filter((p) => p.active && p.state === 'flee').length).toBeGreaterThanOrEqual(3);
  });

  it('people dive out of the way of a car on the pavement', async () => {
    const w = await quietWorld();
    w.peds.cap = 0;
    const s = pavementBy(w, EW.x);
    const p = w.peds.spawnPedAt(s.x + 14, s.z)!;
    const car = w.spawnVehicle('saloon', s.x, s.z, Math.PI / 2, 'parked')!;
    w.playerCtl.enter(car);
    const seen: SimEvent[] = [];
    runUntil(w, 1.5, () => seen.some((e) => e.type === 'pedDive'), seen);
    // Engine running into the pavement: the throttle intent drives it.
    if (!seen.some((e) => e.type === 'pedDive')) {
      for (let i = 0; i < 90 && !seen.some((e) => e.type === 'pedDive'); i++) {
        w.step(intents({ throttle: 1, scheme: 'classic' }));
        for (const e of w.events) seen.push(e);
      }
    }
    expect(seen.some((e) => e.type === 'pedDive' && e.pedId === p.id)).toBe(true);
  });

  it('some people walk in groups and sheltering happens in a storm', async () => {
    const w = await makeWorld(3);
    w.weather.locked = true;
    w.weather.set('clear', 1e9);
    w.peds.cap = 30;
    runUntil(w, 20, () => false);
    const followers = w.peds.peds.filter((p) => p.active && w.crowds.taskOf(p.id) === 'follow').length;
    expect(followers).toBeGreaterThan(0);
    w.weather.set('storm', 1e9);
    let sheltering = 0;
    runUntil(w, 40, () => {
      sheltering = w.peds.peds.filter((p) => p.active && w.peds.tags.anim[p.id] === 5).length;
      return sheltering > 0;
    });
    expect(sheltering).toBeGreaterThan(0);
  });

  it('density follows district and hour', async () => {
    const w = await makeWorld(1);
    w.weather.locked = true;
    // Lantern Row market in the evening is busier than the docks at night.
    movePlayer(w, -400, -560);
    w.weather.hour = 20;
    runUntil(w, 1.1, () => false);
    const market = w.crowds.density;
    movePlayer(w, 300, 600);
    w.weather.hour = 2;
    runUntil(w, 1.1, () => false);
    const docks = w.crowds.density;
    expect(market).toBeGreaterThan(1.2);
    expect(docks).toBeLessThan(0.5);
    expect(w.peds.extra).toBeLessThan(0);
  });
});

describe('living city performance', () => {
  it('runs 60 s with everything on and keeps the tick cheap', async () => {
    const w = await makeWorld(4);
    w.peds.cap = 40;
    w.traffic.cap = 18;
    w.gangs.cap = 20;
    w.gangs.carCap = 2;
    w.services.cap = 3;
    w.weather.locked = true;
    w.weather.rain = 0.9;
    w.gangs.setAllRespect({ glasshounds: -40 });
    const i0 = intents();
    let worst = 0;
    const t0 = performance.now();
    const steps = 60 * 60;
    for (let i = 0; i < steps; i++) {
      // Some incidents along the way.
      if (i % 600 === 300) {
        const p = w.peds.peds.find((q) => q.active && q.owner === 'ambient' && q.state !== 'down');
        if (p) {
          w.peds.knockDown(p, 0, 0, false, false);
          w.services.requestAmbulance(p.id);
        }
        const v = w.vehicles.find((q) => q.active && q.role === 'traffic' && !q.destroyed);
        if (v) w.damageVehicle(v, 1e6);
      }
      const s = performance.now();
      w.step(i0);
      worst = Math.max(worst, performance.now() - s);
    }
    const ms = (performance.now() - t0) / steps;
    console.info(`living city: ${ms.toFixed(3)} ms per tick (worst ${worst.toFixed(2)} ms), peds ${w.peds.activeCount()}, crew ${w.gangs.activeMembers()}, responders ${w.services.activeUnits()}`);
    expect(ms).toBeLessThan(4);
  });
});
