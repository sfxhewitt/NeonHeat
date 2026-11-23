import { describe, expect, it } from 'vitest';
import { Cell, cityGrid, rampLength, rampProfile, rampSurface, type RampSite, type SimEvent, type World } from '@neonheat/sim';
import { intents, loadContent, makeWorld, run } from './helpers';

/** Put the player in a fresh car at a point, facing `yaw`, moving at `speed`. */
function drive(w: World, variant: string, x: number, z: number, yaw: number, speed = 0): NonNullable<World['player']['vehicle']> {
  const v = w.spawnVehicle(variant, x, z, yaw, 'parked')!;
  w.playerCtl.enter(v);
  v.vx = Math.sin(yaw) * speed;
  v.vz = Math.cos(yaw) * speed;
  v.body!.setLinvel({ x: v.vx, y: 0, z: v.vz }, true);
  return v;
}

/** Clear traffic and parked cars round a point so a test run is not shunted. */
function clearAround(w: World, x: number, z: number, r: number): void {
  w.traffic.cap = 0;
  for (const v of w.vehicles) if (v.active && v !== w.player.vehicle && Math.hypot(v.x - x, v.z - z) < r) w.despawnVehicle(v);
}

function collect(w: World, seconds: number, input = intents({ throttle: 1 })): SimEvent[] {
  const out: SimEvent[] = [];
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    w.step(input);
    out.push(...w.events);
  }
  return out;
}

/** Line up `metres` before a ramp's kicker, on its centre line. */
function runUp(r: RampSite, metres: number): [number, number] {
  return [r.x - Math.sin(r.yaw) * metres, r.z - Math.cos(r.yaw) * metres];
}

describe('activity placement', () => {
  it('places 10+ ramps, 50 shards, a token per rampage and a flag per race, all in sensible places', () => {
    const c = loadContent();
    const a = c.activities!;
    const g = cityGrid(c.map);
    expect(a.sites.ramps.length).toBeGreaterThanOrEqual(10);
    expect(new Set(a.sites.ramps.map((r) => r.district)).size).toBe(5);
    expect(a.sites.shards).toHaveLength(50);
    expect(new Set(a.sites.shards.map((s) => s.id)).size).toBe(50);
    expect(a.sites.tokens.map((t) => t.id).sort()).toEqual(a.config.rampages.defs.map((d) => d.id).sort());
    expect(a.sites.flags.map((t) => t.id).sort()).toEqual(a.config.races.defs.map((d) => d.id).sort());
    for (const r of a.sites.ramps) {
      // The whole ramp and its run-up sit on the road; the landing run has no building or water.
      for (let k = -a.config.jumps.runUp; k <= rampLength(r); k += 1) {
        const x = r.x + Math.sin(r.yaw) * k;
        const z = r.z + Math.cos(r.yaw) * k;
        expect(g.at(x, z) & Cell.road, `${r.id} at ${k}`).not.toBe(0);
      }
      for (let k = rampLength(r); k < rampLength(r) + a.config.jumps.landingRun; k += 2) {
        expect(g.at(r.x + Math.sin(r.yaw) * k, r.z + Math.cos(r.yaw) * k) & (Cell.building | Cell.water), `${r.id} landing ${k}`).toBe(0);
      }
      // No parked car left on the ramp or its run-up.
      for (const p of c.map.parking) {
        const dx = p.x - r.x;
        const dz = p.z - r.z;
        const along = dx * Math.sin(r.yaw) + dz * Math.cos(r.yaw);
        const lat = dx * Math.cos(r.yaw) - dz * Math.sin(r.yaw);
        expect(along > -20 && along < rampLength(r) + 4 && Math.abs(lat) < r.width / 2 + 2, `parked car on ${r.id}`).toBe(false);
      }
      // Nowhere near a player spawn: a fresh start never drives straight onto a kicker.
      for (const s of Object.values(c.map.spawns)) {
        for (let k = -a.config.jumps.runUp; k <= rampLength(r) + a.config.jumps.landingRun; k += 4) {
          const d = Math.hypot(r.x + Math.sin(r.yaw) * k - s.pos[0], r.z + Math.cos(r.yaw) * k - s.pos[2]);
          expect(d, `${r.id} near a spawn`).toBeGreaterThanOrEqual(a.config.jumps.spawnClear);
        }
      }
    }
    // Shards: never in a building, the river or a traffic lane; spread over every district and kind of spot.
    for (const s of a.sites.shards) {
      const cell = g.at(s.x, s.z);
      expect(cell & (Cell.building | Cell.water), s.id).toBe(0);
      if (cell & Cell.road) expect(cell & Cell.alley, `${s.id} in a traffic lane`).not.toBe(0);
    }
    expect(new Set(a.sites.shards.map((s) => s.district)).size).toBe(5);
    expect(new Set(a.sites.shards.map((s) => s.kind))).toEqual(new Set(['pavement', 'alley', 'park', 'lot', 'edge']));
  });

  it('is deterministic', () => {
    expect(JSON.stringify(loadContent().activities!.sites)).toBe(JSON.stringify(loadContent().activities!.sites));
  });

  it('shapes a ramp as a kicker, a deck and a slope down the back', () => {
    const r = { up: 9, deck: 2.5, down: 5, height: 1.8 };
    expect(rampProfile(r, -0.1)).toBe(-1);
    expect(rampProfile(r, 4.5)).toBeCloseTo(0.9);
    expect(rampProfile(r, 10)).toBe(1.8);
    expect(rampProfile(r, 11.5 + 2.5)).toBeCloseTo(0.9);
    expect(rampProfile(r, 17)).toBe(-1);
    const site = { id: 't', district: 'x', x: 0, z: 0, yaw: Math.PI / 2, width: 5, road: 'street', target: 20, ...r } as RampSite;
    expect(rampSurface(site, 4.5, 0)).toBeCloseTo(0.9); // yaw π/2 runs east
    expect(rampSurface(site, 4.5, 3)).toBe(-1); // off the side
  });
});

describe('stunt jumps', () => {
  it('launches a fast car off the kicker, flies with no grip, lands and pays by distance', async () => {
    const w = await makeWorld();
    const r = w.activities.sites.ramps[0]!;
    const [x, z] = runUp(r, 30);
    clearAround(w, r.x, r.z, 120);
    const v = drive(w, 'kestrel', x, z, r.yaw, 30);
    const credits = w.score.credits;
    let maxY = 0;
    let airSteps = 0;
    let headingAtTakeoff = 0;
    let maxHeadingDrift = 0;
    const events: SimEvent[] = [];
    for (let i = 0; i < 60 * 5; i++) {
      // Steering hard while airborne must change nothing.
      w.step(intents({ throttle: 1, steer: v.airborne ? 1 : 0 }));
      events.push(...w.events);
      if (v.airborne) {
        if (airSteps === 0) headingAtTakeoff = Math.atan2(v.vx, v.vz);
        airSteps++;
        maxHeadingDrift = Math.max(maxHeadingDrift, Math.abs(Math.atan2(v.vx, v.vz) - headingAtTakeoff));
      }
      maxY = Math.max(maxY, v.y);
    }
    const takeoff = events.find((e) => e.type === 'jumpTakeoff');
    const landed = events.find((e) => e.type === 'jumpLanded' && e.byPlayer);
    expect(takeoff, 'took off').toBeTruthy();
    expect(landed, 'landed').toBeTruthy();
    if (landed?.type !== 'jumpLanded' || takeoff?.type !== 'jumpTakeoff') return;
    expect(takeoff.rampId).toBe(r.id);
    expect(maxY).toBeGreaterThan(r.height + 1);
    expect(airSteps / 60).toBeGreaterThan(0.8);
    expect(maxHeadingDrift).toBeLessThan(0.02);
    expect(landed.distance).toBeGreaterThan(20);
    expect(landed.reward).toBeGreaterThan(0);
    expect(w.score.credits).toBeGreaterThan(credits);
    expect(v.y).toBe(0);
    expect(v.airborne).toBe(false);
    // Rewards are what the config says.
    const cfg = w.activities.config!.jumps.reward;
    const expected = Math.round(cfg.base + cfg.perMetre * landed.distance + cfg.perAirSecond * landed.air) + (landed.unique ? cfg.unique : 0);
    expect(landed.reward).toBe(expected);
    expect(w.activities.progress.jumps[r.id]!.best).toBeCloseTo(landed.distance, 0);
  });

  it('clears the unique jump once, at speed, and not again', async () => {
    const w = await makeWorld();
    const r = w.activities.sites.ramps[1]!;
    clearAround(w, r.x, r.z, 120);
    const fly = (): Extract<SimEvent, { type: 'jumpLanded' }> | undefined => {
      const [x, z] = runUp(r, 30);
      if (w.player.vehicle) {
        const old = w.player.vehicle;
        w.playerCtl.exit();
        w.despawnVehicle(old);
      }
      drive(w, 'razorback', x, z, r.yaw, 38);
      const e = collect(w, 4).find((q) => q.type === 'jumpLanded' && q.byPlayer);
      return e?.type === 'jumpLanded' ? e : undefined;
    };
    const first = fly();
    expect(first?.distance).toBeGreaterThan(r.target);
    expect(first?.unique).toBe(true);
    expect(w.activities.progress.jumps[r.id]!.unique).toBe(true);
    const second = fly();
    expect(second?.unique).toBe(false);
  });

  it('a slow car rolls over the ramp without leaving the ground for long, and a hard landing hurts', async () => {
    const w = await makeWorld();
    const r = w.activities.sites.ramps[2]!;
    clearAround(w, r.x, r.z, 120);
    const [x, z] = runUp(r, 6);
    const v = drive(w, 'hatch', x, z, r.yaw, 7);
    let air = 0;
    let maxY = 0;
    for (let i = 0; i < 60 * 6; i++) {
      w.step(intents({ throttle: 0.05 }));
      if (v.airborne) air++;
      maxY = Math.max(maxY, v.y);
    }
    expect(maxY).toBeGreaterThan(r.height - 0.05);
    expect(maxY).toBeLessThan(r.height + 0.3);
    expect(air / 60).toBeLessThan(0.35);
    // Dropped from a height: vertical speed past hardSpeed costs hull.
    v.y = 12;
    v.vy = 0;
    v.airborne = true;
    const hp = v.hp;
    run(w, 2, intents());
    expect(v.airborne).toBe(false);
    expect(v.hp).toBeLessThan(hp);
  });

  it('flies over a car in the way, and traffic rides the ramps too', async () => {
    const w = await makeWorld();
    const r = w.activities.sites.ramps[0]!;
    clearAround(w, r.x, r.z, 120);
    // A parked car right where a jump comes down.
    const lx = r.x + Math.sin(r.yaw) * (rampLength(r) + 12);
    const lz = r.z + Math.cos(r.yaw) * (rampLength(r) + 12);
    const blocker = w.spawnVehicle('hatch', lx, lz, r.yaw + Math.PI / 2, 'parked')!;
    const [x, z] = runUp(r, 30);
    const v = drive(w, 'kestrel', x, z, r.yaw, 33);
    const bx = blocker.x;
    const bz = blocker.z;
    const ev = collect(w, 3);
    expect(ev.some((e) => e.type === 'impact' && e.involvesPlayer && e.other === 'vehicle')).toBe(false);
    expect(Math.hypot(blocker.x - bx, blocker.z - bz)).toBeLessThan(0.2);
    expect(Math.hypot(v.x - lx, v.z - lz)).toBeGreaterThan(10);
    // An AI car (not the player's) takes off as well.
    const other = w.spawnVehicle('saloon', ...runUp(r, 25), r.yaw, 'traffic')!;
    other.vx = Math.sin(r.yaw) * 28;
    other.vz = Math.cos(r.yaw) * 28;
    other.role = 'mission';
    let flew = false;
    for (let i = 0; i < 120; i++) {
      other.controls.throttle = 1;
      w.step(intents());
      flew ||= other.airborne;
    }
    expect(flew).toBe(true);
  });

  it('is deterministic', async () => {
    const a = await makeWorld(5);
    const b = await makeWorld(5);
    for (const w of [a, b]) {
      const r = w.activities.sites.ramps[3]!;
      drive(w, 'kestrel', ...runUp(r, 30), r.yaw, 31);
      run(w, 4, intents({ throttle: 1 }));
    }
    expect(a.stateHash()).toBe(b.stateHash());
  });
});

describe('rampages', () => {
  it('counts smashed street furniture, passes in time, pays and remembers', async () => {
    const w = await makeWorld();
    const t = w.activities.rampages.tokens.find((q) => q.def.kind === 'smash')!;
    w.playerCtl.teleport(t.site.x, t.site.z);
    w.step(intents());
    const run0 = w.activities.rampages.run!;
    expect(run0.def.id).toBe(t.def.id);
    expect(run0.phase).toBe('ready');
    run(w, w.activities.config!.rampages.readySec + 0.1, intents());
    expect(run0.phase).toBe('run');
    const credits = w.score.credits;
    // Simulate smashes as the props system reports them.
    const events: SimEvent[] = [];
    for (let i = 0; i < t.def.target; i++) {
      w.events.length = 0;
      w.step(intents());
      w.events.push({ type: 'propBroken', propId: 0, kind: 'bin', x: 0, z: 0, vx: 0, vz: 0, byPlayer: true });
      // Activities read this step's events: step them again by hand.
      w.activities.rampages.step(0);
      events.push(...w.events);
    }
    expect(events.some((e) => e.type === 'rampage' && e.phase === 'passed')).toBe(true);
    expect(w.activities.rampages.run).toBeNull();
    expect(w.score.credits).toBe(credits + t.def.reward);
    expect(w.activities.progress.rampages[t.def.id]!.passes).toBe(1);
    // Not counted: a prop broken by somebody else.
  });

  it('ignores props smashed by others, fails when time runs out and the token comes back later', async () => {
    const w = await makeWorld();
    const t = w.activities.rampages.tokens.find((q) => q.def.kind === 'smash')!;
    w.playerCtl.teleport(t.site.x, t.site.z);
    w.step(intents());
    run(w, 3, intents());
    const r = w.activities.rampages.run!;
    w.events.push({ type: 'propBroken', propId: 0, kind: 'bin', x: 0, z: 0, vx: 0, vz: 0, byPlayer: false });
    w.activities.rampages.step(0);
    expect(r.count).toBe(0);
    w.playerCtl.teleport(t.site.x + 30, t.site.z);
    const ev = collect(w, t.def.timeSec + 1, intents());
    expect(ev.some((e) => e.type === 'rampage' && e.phase === 'failed')).toBe(true);
    expect(w.activities.rampages.run).toBeNull();
    expect(t.cooldown).toBeGreaterThan(0);
    expect(w.activities.progress.rampages[t.def.id]).toBeUndefined();
  });

  it('counts wrecked cars near the player (not their own) and hands over the weapon', async () => {
    const w = await makeWorld();
    const t = w.activities.rampages.tokens.find((q) => q.def.kind === 'wreck')!;
    w.playerCtl.teleport(t.site.x, t.site.z);
    w.step(intents());
    expect(w.combat.weaponId).toBe(t.def.weapon);
    run(w, 3, intents());
    const r = w.activities.rampages.run!;
    for (let i = 0; i < 3; i++) {
      w.events.length = 0;
      const v = w.spawnVehicle('hatch', t.site.x + 20 + i * 6, t.site.z, 0, 'parked')!;
      w.damageVehicle(v, 1e6);
      w.activities.rampages.step(0);
    }
    expect(r.count).toBe(3);
    const far = w.spawnVehicle('hatch', t.site.x + 600, t.site.z, 0, 'parked');
    if (far) {
      w.events.length = 0;
      w.damageVehicle(far, 1e6);
      w.activities.rampages.step(0);
      expect(r.count).toBe(3);
    }
  });

  it('a takedown sends a hostile gang; putting them down passes it', async () => {
    const w = await makeWorld();
    const t = w.activities.rampages.tokens.find((q) => q.def.kind === 'takedown')!;
    w.playerCtl.teleport(t.site.x, t.site.z);
    w.step(intents());
    const r = w.activities.rampages.run!;
    expect(r.gang.length).toBe(t.def.target);
    expect(r.gang.every((a) => a.hostile)).toBe(true);
    run(w, 3, intents());
    expect(r.gang.every((a) => a.aggro)).toBe(true);
    const ev: SimEvent[] = [];
    for (const a of r.gang) {
      w.actors.hurtActor(a, 99);
      w.step(intents());
      ev.push(...w.events);
    }
    expect(ev.some((e) => e.type === 'rampage' && e.phase === 'passed')).toBe(true);
  });

  it('stands down while a job runs', async () => {
    const w = await makeWorld();
    const t = w.activities.rampages.tokens[0]!;
    w.activities.enabled = false;
    w.playerCtl.teleport(t.site.x, t.site.z);
    run(w, 0.5, intents());
    expect(w.activities.rampages.run).toBeNull();
    w.activities.enabled = true;
    run(w, 0.1, intents());
    expect(w.activities.rampages.run).not.toBeNull();
    w.activities.enabled = false;
    const ev = collect(w, 0.1, intents());
    expect(ev.some((e) => e.type === 'rampage' && e.phase === 'cancelled')).toBe(true);
  });
});

describe('data shards', () => {
  it('collects on touch, pays a milestone every 10 and persists through progress', async () => {
    const w = await makeWorld();
    const sh = w.activities.shards;
    const cfg = w.activities.config!.shards;
    expect(sh.total).toBe(50);
    const credits = w.score.credits;
    let milestones = 0;
    for (let i = 0; i < 10; i++) {
      const s = sh.sites[i]!;
      w.playerCtl.teleport(s.x, s.z);
      w.step(intents());
      const e = w.events.find((q) => q.type === 'shardFound');
      expect(e, s.id).toBeTruthy();
      if (e?.type === 'shardFound' && e.milestone > 0) milestones++;
    }
    expect(sh.count).toBe(10);
    expect(milestones).toBe(1);
    expect(w.score.credits).toBe(credits + 10 * cfg.reward + cfg.milestoneReward);
    // Standing on one again does nothing.
    w.playerCtl.teleport(sh.sites[0]!.x, sh.sites[0]!.z);
    w.step(intents());
    expect(w.events.some((q) => q.type === 'shardFound')).toBe(false);
    // A new world loading the saved progress knows which are found.
    const saved = JSON.parse(JSON.stringify(w.activities.progress));
    const w2 = await makeWorld();
    w2.activities.load(saved);
    expect(w2.activities.shards.count).toBe(10);
    expect(w2.activities.shards.found.slice(0, 10).every(Boolean)).toBe(true);
    w2.playerCtl.teleport(sh.sites[3]!.x, sh.sites[3]!.z);
    w2.step(intents());
    expect(w2.events.some((q) => q.type === 'shardFound')).toBe(false);
  });

  it('can be picked up from a car', async () => {
    const w = await makeWorld();
    const s = w.activities.shards.sites.find((q) => q.kind === 'alley')!;
    drive(w, 'kestrel', s.x, s.z, 0, 0);
    w.step(intents());
    expect(w.activities.shards.count).toBe(1);
  });
});

describe('taxi and courier fares', () => {
  it('offers duty in a cab, picks a fare up at the kerb, delivers against the clock and pays a tip', async () => {
    const w = await makeWorld();
    const start = w.content.map.markers['player_start']!.pos;
    const v = drive(w, 'taxi', start[0], start[2], 0);
    w.step(intents());
    expect(w.activities.prompt?.action).toBe('duty');
    expect(w.activities.prompt?.label).toBe('TAXI DUTY');
    const ev = collect(w, 0.05, intents({ activity: true }));
    expect(ev.some((e) => e.type === 'fare' && e.phase === 'onDuty')).toBe(true);
    const s = w.activities.fares.shift!;
    expect(s.phase).toBe('seek');
    expect(s.actor?.active).toBe(true);
    // The fare stands on the pavement, the stop is in the road beside them.
    expect(w.roads.onRoad(s.pickup.x, s.pickup.z)).toBe(false);
    expect(Math.hypot(s.pickup.x - s.pickup.laneX, s.pickup.z - s.pickup.laneZ)).toBeLessThan(12);
    expect(w.activities.prompt?.label).toBe('END SHIFT');
    // Drive up (teleport) and stop.
    w.teleportVehicle(v, s.pickup.laneX, s.pickup.laneZ, 0);
    const ev2 = collect(w, 0.1, intents());
    expect(ev2.some((e) => e.type === 'fare' && e.phase === 'pickedUp')).toBe(true);
    expect(s.phase).toBe('ride');
    expect(s.actor?.riding).toBe(true);
    expect(s.timeLeft).toBeGreaterThan(s.def.baseSec);
    const credits = w.score.credits;
    w.teleportVehicle(v, s.drop.laneX, s.drop.laneZ, 0);
    const ev3 = collect(w, 0.1, intents());
    const done = ev3.find((e) => e.type === 'fare' && e.phase === 'delivered');
    expect(done).toBeTruthy();
    if (done?.type !== 'fare') return;
    expect(done.tip).toBeGreaterThan(0);
    expect(w.score.credits).toBe(credits + done.pay + done.tip + done.bonus);
    expect(w.activities.progress.fares['taxi']!.done).toBe(1);
    // A new fare is already waiting.
    expect(w.activities.fares.shift?.phase).toBe('seek');
  });

  it('pays a streak bonus every few fares, resets it on a lost fare, and ends the shift when you walk off', async () => {
    const w = await makeWorld();
    const start = w.content.map.markers['player_start']!.pos;
    const v = drive(w, 'taxi', start[0], start[2], 0);
    w.step(intents());
    w.step(intents({ activity: true }));
    const s = w.activities.fares.shift!;
    let bonus = 0;
    for (let i = 0; i < s.def.streakEvery; i++) {
      w.teleportVehicle(v, s.pickup.laneX, s.pickup.laneZ, 0);
      w.step(intents());
      w.teleportVehicle(v, s.drop.laneX, s.drop.laneZ, 0);
      w.step(intents());
      const e = w.events.find((q) => q.type === 'fare' && q.phase === 'delivered');
      if (e?.type === 'fare') bonus += e.bonus;
    }
    expect(bonus).toBe(s.def.streakBonus);
    expect(s.streak).toBe(s.def.streakEvery);
    // Let the pick-up clock run out.
    const ev = collect(w, s.def.pickupSec + 1, intents());
    expect(ev.some((e) => e.type === 'fare' && e.phase === 'lost')).toBe(true);
    expect(s.streak).toBe(0);
    w.playerCtl.exit();
    const ev2 = collect(w, s.def.leaveSec + 0.5, intents());
    expect(ev2.some((e) => e.type === 'fare' && e.phase === 'offDuty')).toBe(true);
    expect(w.activities.fares.shift).toBeNull();
    expect(w.activities.progress.fares['taxi']!.bestStreak).toBe(s.def.streakEvery);
  });

  it('courier work runs from a van with parcels, and damage costs pay', async () => {
    const w = await makeWorld();
    const start = w.content.map.markers['player_start']!.pos;
    const v = drive(w, 'brick', start[0], start[2], 0);
    w.step(intents());
    expect(w.activities.prompt?.label).toBe('COURIER');
    w.step(intents({ activity: true }));
    const s = w.activities.fares.shift!;
    expect(s.actor).toBeNull();
    w.teleportVehicle(v, s.pickup.laneX, s.pickup.laneZ, 0);
    w.step(intents());
    expect(s.phase).toBe('ride');
    w.damageVehicle(v, v.params.maxHealth * 0.3);
    w.teleportVehicle(v, s.drop.laneX, s.drop.laneZ, 0);
    w.step(intents());
    const e = w.events.find((q) => q.type === 'fare' && q.phase === 'delivered');
    expect(e?.type === 'fare' && e.pay).toBeLessThan(Math.round(s.def.pay.base + s.def.pay.perMetre * s.routeLength));
  });

  it('is not offered in other cars', async () => {
    const w = await makeWorld();
    const start = w.content.map.markers['player_start']!.pos;
    drive(w, 'saloon', start[0], start[2], 0);
    w.step(intents());
    expect(w.activities.prompt).toBeNull();
  });

  it('puts fares on clear kerbs, never under a tree or on top of street furniture', async () => {
    const w = await makeWorld();
    const props = w.props.props.filter((p) => !p.broken);
    const start = w.content.map.markers['player_start']!.pos;
    for (let i = 0; i < 40; i++) {
      const s = w.activities.fares.findStop(start[0], start[2], 50, 600);
      expect(s).not.toBeNull();
      for (const p of props) {
        const r = p.kind === 'tree' ? 3.5 : 1.6;
        expect(Math.abs(p.x - s!.x) < r && Math.abs(p.z - s!.z) < r).toBe(false);
      }
    }
  });
});

describe('street races', () => {
  it('builds a checkpoint route along the roads for every race', async () => {
    const w = await makeWorld();
    for (const f of w.activities.sites.flags) {
      const r = w.activities.races.route(f.id);
      const def = w.activities.races.defOf(f.id)!;
      expect(r.xs.length).toBeGreaterThanOrEqual(4);
      expect(r.length).toBeGreaterThan(def.length * 0.6);
      for (let i = 0; i < r.xs.length; i++) expect(w.roads.onRoad(r.xs[i]!, r.zs[i]!), `${f.id} checkpoint ${i}`).toBe(true);
      if (def.kind === 'circuit') expect(Math.hypot(r.xs[r.xs.length - 1]! - f.gridX, r.zs[r.zs.length - 1]! - f.gridZ)).toBeLessThan(1);
    }
  });

  it('starts from the flag, holds the grid for the countdown, then counts checkpoints in order to the finish', async () => {
    const w = await makeWorld();
    const f = w.activities.sites.flags.find((q) => q.id === 'ashgrove_sprint')!;
    const v = drive(w, 'kestrel', f.gridX, f.gridZ + 0.5, f.yaw);
    w.step(intents());
    expect(w.activities.prompt?.action).toBe('race');
    w.step(intents({ activity: true }));
    const r = w.activities.races.run!;
    expect(r.opponents.length).toBe(2);
    expect(r.phase).toBe('countdown');
    // Held on the line even with the throttle down.
    run(w, 1, intents({ throttle: 1 }));
    expect(Math.hypot(v.x - f.gridX, v.z - f.gridZ)).toBeLessThan(0.5);
    run(w, 2.2, intents());
    expect(r.phase).toBe('run');
    // Opponents are driving.
    run(w, 2, intents());
    for (const o of r.opponents) expect(Math.hypot(w.vehicles[o.vehicleId]!.vx, w.vehicles[o.vehicleId]!.vz)).toBeGreaterThan(3);
    // Skipping a checkpoint does not count: go straight to the second.
    const c1 = w.activities.races.checkpoint(1)!;
    w.teleportVehicle(v, c1.x, c1.z, 0);
    w.step(intents());
    expect(r.player.next).toBe(0);
    const credits = w.score.credits;
    const events: SimEvent[] = [];
    for (let i = 0; i < r.total; i++) {
      const c = w.activities.races.checkpoint(i)!;
      w.teleportVehicle(v, c.x, c.z, 0);
      w.step(intents());
      events.push(...w.events);
    }
    const fin = events.find((e) => e.type === 'race' && e.phase === 'finished');
    expect(fin).toBeTruthy();
    if (fin?.type !== 'race') return;
    expect(fin.place).toBe(1);
    expect(w.score.credits).toBe(credits + fin.reward);
    expect(fin.reward).toBe(w.activities.races.defOf(f.id)!.prizes[0]);
    const rec = w.activities.progress.races[f.id]!;
    expect(rec.wins).toBe(1);
    expect(rec.bestSec).toBeGreaterThan(0);
    expect(w.activities.races.run).toBeNull();
    // Opponents are handed back.
    for (const o of r.opponents) expect(w.actors.driverFor(o.vehicleId)).toBeNull();
  });

  it('counts laps on a circuit, and leaving the car loses the race', async () => {
    const w = await makeWorld();
    const f = w.activities.sites.flags.find((q) => q.id === 'lantern_loop')!;
    const v = drive(w, 'kestrel', f.gridX, f.gridZ, f.yaw);
    w.step(intents({ activity: true }));
    w.step(intents({ activity: true }));
    const r = w.activities.races.run!;
    run(w, 3.2, intents());
    const n = r.route.xs.length;
    expect(r.total).toBe(n * 2);
    const ev: SimEvent[] = [];
    for (let i = 0; i < n; i++) {
      const c = w.activities.races.checkpoint(i)!;
      w.teleportVehicle(v, c.x, c.z, 0);
      w.step(intents());
      ev.push(...w.events);
    }
    expect(ev.some((e) => e.type === 'race' && e.phase === 'lap')).toBe(true);
    expect(w.activities.races.lap).toBe(2);
    w.playerCtl.exit();
    const ev2 = collect(w, w.activities.config!.races.leaveSec + 0.5, intents());
    expect(ev2.some((e) => e.type === 'race' && e.phase === 'failed')).toBe(true);
    expect(w.activities.progress.races[f.id]).toBeUndefined();
  });

  it('an AI racer can drive the whole route', async () => {
    const w = await makeWorld();
    const f = w.activities.sites.flags.find((q) => q.id === 'ashgrove_sprint')!;
    drive(w, 'kestrel', f.gridX, f.gridZ, f.yaw);
    w.step(intents({ activity: true }));
    const r = w.activities.races.run!;
    // Sit on the grid and let the field go.
    run(w, 120, intents());
    expect(r.finishedOpponents).toBeGreaterThanOrEqual(1);
  });
});
