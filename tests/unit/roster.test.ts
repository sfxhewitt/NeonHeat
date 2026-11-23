import { describe, expect, it } from 'vitest';
import {
  Rng,
  SIM_DT,
  VehicleClassSchema,
  VehiclesSchema,
  emptyControls,
  forwardSpeed,
  paintFor,
  paintsFor,
  pickTrafficVariant,
  stepArcade,
  variantsOfClass,
  type ArcadeState,
  type DriveControls,
  type VehicleParams,
} from '@neonheat/sim';
import { rawContent } from '@neonheat/content';
import { MODEL_IDS, buildCarModel, modelFor } from '@neonheat/engine';
import { EW, intents, loadContent, makeWorld, movePlayer, run } from './helpers';

const content = loadContent();
const variants = content.vehicles.variants;
const ids = Object.keys(variants);

function fresh(yaw = 0): ArcadeState {
  return { yaw, vx: 0, vz: 0, yawRate: 0, drifting: false };
}

/** Integrate the arcade model on its own (no collisions): velocities plus heading. */
function drive(s: ArcadeState, p: VehicleParams, c: Partial<DriveControls>, seconds: number, each?: (t: number) => boolean | void): number {
  const ctl = { ...emptyControls(), ...c };
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) {
    stepArcade(s, p, ctl, SIM_DT);
    s.yaw += s.yawRate * SIM_DT;
    if (each?.((i + 1) * SIM_DT)) return (i + 1) * SIM_DT;
  }
  return seconds;
}

/** Seconds from rest to a speed under full throttle (Infinity if never). */
function timeTo(p: VehicleParams, speed: number): number {
  const s = fresh();
  let t = Infinity;
  drive(s, p, { throttle: 1 }, 20, (tt) => {
    if (forwardSpeed(s) >= speed) {
      t = tt;
      return true;
    }
  });
  return t;
}

describe('vehicle roster', () => {
  it('has at least 20 variants covering every class asked for', () => {
    expect(ids.length).toBeGreaterThanOrEqual(20);
    for (const cls of ['compact', 'saloon', 'estate', 'taxi', 'sports', 'super', 'muscle', 'van', 'pickup', 'truck', 'bus', 'bike', 'emergency', 'police'] as const) {
      expect(variantsOfClass(content.vehicles, cls).length, cls).toBeGreaterThan(0);
    }
    expect(variantsOfClass(content.vehicles, 'bike').length).toBeGreaterThanOrEqual(2);
    expect(variantsOfClass(content.vehicles, 'truck').length).toBeGreaterThanOrEqual(2);
  });

  it('every variant parses with a known class and an explicit body model', () => {
    for (const id of ids) {
      const p = variants[id]!;
      expect(VehicleClassSchema.safeParse(p.class).success, id).toBe(true);
      expect(p.model && (MODEL_IDS as readonly string[]).includes(p.model), `${id} model ${p.model}`).toBe(true);
      expect(p.twoWheel, id).toBe(p.class === 'bike');
    }
  });

  it('keeps old content valid: new fields default', () => {
    const raw = structuredClone(rawContent.vehicles) as unknown as { paints?: unknown; variants: Record<string, Record<string, unknown>> };
    delete raw.paints;
    const k = raw.variants.kestrel!;
    for (const f of ['class', 'model', 'twoWheel', 'traffic', 'districts', 'paints', 'leanMax']) delete k[f];
    const parsed = VehiclesSchema.parse(raw);
    const v = parsed.variants.kestrel!;
    expect([v.class, v.model, v.twoWheel, v.traffic, v.districts, v.paints, v.leanMax]).toEqual(['saloon', undefined, false, 0, [], [], 0]);
    expect(parsed.paints).toEqual({});
    expect(paintFor(parsed, 'kestrel', 3)).toBe(v.colour);
  });

  it.each(ids)('%s reaches a sensible top speed and no more', (id) => {
    const p = variants[id]!;
    expect(p.topSpeed).toBeGreaterThanOrEqual(18);
    expect(p.topSpeed).toBeLessThanOrEqual(50);
    const s = fresh();
    drive(s, p, { throttle: 1 }, 20);
    expect(forwardSpeed(s)).toBeGreaterThan(p.topSpeed * 0.97);
    expect(forwardSpeed(s)).toBeLessThanOrEqual(p.topSpeed * 1.001);
    // 0 to 20 m/s (72 km/h) between a superbike's 1 s and a loaded lorry's 6 s.
    const t = timeTo(p, 20);
    expect(t).toBeGreaterThan(0.6);
    expect(t).toBeLessThan(6.5);
  });

  it.each(ids)('%s turns and brakes', (id) => {
    const p = variants[id]!;
    const s = fresh();
    drive(s, p, { throttle: 1 }, 3);
    const yaw0 = s.yaw;
    drive(s, p, { throttle: 0.6, steer: 1 }, 1.5);
    expect(Math.abs(s.yaw - yaw0)).toBeGreaterThan(0.6);
    // Straighten, get up to speed, then stop.
    const b = fresh();
    drive(b, p, { throttle: 1 }, 6);
    const v0 = forwardSpeed(b);
    let dist = 0;
    const t = drive(b, p, { brake: 1 }, 6, () => {
      dist += forwardSpeed(b) * SIM_DT;
      return forwardSpeed(b) < 0.5;
    });
    expect(t).toBeLessThan(v0 / p.brakeDecel + 0.3);
    expect(dist).toBeLessThan((v0 * v0) / (2 * p.brakeDecel) + 2);
  });

  it('bikes out-accelerate vans and trucks, and the sport bike is the quickest of all', () => {
    const bikes = variantsOfClass(content.vehicles, 'bike');
    const slow = [...variantsOfClass(content.vehicles, 'van'), ...variantsOfClass(content.vehicles, 'truck'), ...variantsOfClass(content.vehicles, 'bus'), 'patrolvan', 'lifeline'];
    for (const b of bikes) for (const v of slow) expect(timeTo(variants[b]!, 20), `${b} vs ${v}`).toBeLessThan(timeTo(variants[v]!, 20));
    const best = Math.min(...ids.map((id) => timeTo(variants[id]!, 20)));
    expect(timeTo(variants.shrike!, 20)).toBe(best);
  });

  it('heavier classes are heavier, tougher and slower to turn', () => {
    const mass = (cls: Parameters<typeof variantsOfClass>[1]) => Math.min(...variantsOfClass(content.vehicles, cls).map((id) => variants[id]!.mass));
    expect(mass('bus')).toBeGreaterThan(mass('van'));
    expect(mass('truck')).toBeGreaterThan(mass('saloon'));
    expect(mass('saloon')).toBeGreaterThan(Math.max(...variantsOfClass(content.vehicles, 'bike').map((id) => variants[id]!.mass)) * 3);
    expect(variants.leviathan!.steerRateLow).toBeLessThan(variants.hatch!.steerRateLow);
    expect(variants.leviathan!.maxHealth).toBeGreaterThan(variants.hatch!.maxHealth * 3);
  });

  it('a two-wheeler leans instead of sliding: no drift without the rear brake', () => {
    for (const id of variantsOfClass(content.vehicles, 'bike')) {
      const p = variants[id]!;
      const s = fresh();
      drive(s, p, { throttle: 1 }, 3);
      let drifted = false;
      drive(s, p, { throttle: 1, steer: 1 }, 1.5, () => {
        drifted ||= s.drifting;
      });
      expect(drifted, id).toBe(false);
      const h = fresh();
      drive(h, p, { throttle: 1 }, 3);
      drive(h, p, { throttle: 1, steer: 1, handbrake: true }, 0.3);
      expect(h.drifting, id).toBe(true);
    }
    // A car under the same hard steer at speed does break into a slide.
    const car = fresh();
    drive(car, variants.vandal!, { throttle: 1 }, 3);
    let carDrift = false;
    drive(car, variants.vandal!, { throttle: 1, steer: 1 }, 1.5, () => {
      carDrift ||= car.drifting;
    });
    expect(carDrift).toBe(true);
  });
});

describe('collisions by mass', () => {
  /** The attacker builds speed for 25 m, then either keeps its foot down (shove) or coasts in (hit). */
  async function ram(attacker: string, victim: string, coast = false) {
    const c = loadContent();
    c.map.buildings = [];
    c.map.props = [];
    c.traffic.count = 0;
    c.peds.count = 0;
    c.traffic.parkedMax = 0;
    const world = await makeWorld(3, c);
    // A straight stretch of the long east-west avenue.
    const X = -140;
    const Z = EW.z;
    movePlayer(world, X, Z);
    for (const v of world.vehicles) if (v.active) world.despawnVehicle(v);
    const target = world.spawnVehicle(victim, X, Z, 0, 'parked')!;
    const len = c.vehicles.variants[attacker]!.length;
    const car = world.spawnVehicle(attacker, X - len / 2 - 25, Z, Math.PI / 2, 'player')!;
    world.playerCtl.enter(car);
    const gap = c.vehicles.variants[victim]!.length / 2 + len / 2 + 1;
    run(world, 4, () => intents({ throttle: coast && car.x > X - gap ? 0 : 1 }));
    return { moved: Math.hypot(target.x - X, target.z - Z), target, car };
  }

  it('a lorry shoves a hatchback down the road', async () => {
    const big = await ram('leviathan', 'hatch');
    const small = await ram('hatch', 'leviathan');
    expect(big.moved).toBeGreaterThan(4);
    expect(big.moved).toBeGreaterThan(small.moved * 2);
  });

  it('in a hit, the heavy one barely moves and the light one is knocked away', async () => {
    const big = await ram('leviathan', 'hatch', true);
    const small = await ram('hatch', 'leviathan', true);
    expect(big.moved).toBeGreaterThan(2);
    expect(small.moved).toBeLessThan(1.2);
    expect(big.moved).toBeGreaterThan(small.moved * 3);
    const car = await ram('saloon', 'sparrow', true);
    const bike = await ram('sparrow', 'saloon', true);
    expect(car.moved).toBeGreaterThan(bike.moved * 3);
  });
});

describe('roster helpers', () => {
  it('picks traffic by weight, favouring a district', () => {
    const count = (district?: string) => {
      const rng = new Rng(7);
      const n: Record<string, number> = {};
      for (let i = 0; i < 4000; i++) {
        const id = pickTrafficVariant(content.vehicles, rng, district)!;
        n[id] = (n[id] ?? 0) + 1;
      }
      return n;
    };
    const any = count();
    const docks = count('docks');
    // Police, emergency and mission vehicles never come up as civilian traffic.
    for (const id of Object.keys(any)) expect(variants[id]!.role, id).toBe('civilian');
    expect(any.lifeline ?? 0).toBe(0);
    expect(any.saloon!).toBeGreaterThan(any.leviathan ?? 0);
    const trucks = (n: Record<string, number>) => (n.leviathan ?? 0) + (n.stacker ?? 0);
    expect(trucks(docks)).toBeGreaterThan(trucks(any) * 2);
    // Deterministic for a seed.
    expect(count('docks')).toEqual(docks);
  });

  it('rolls paint from the class palette, fixed liveries stay fixed', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(paintFor(content.vehicles, 'saloon', i));
    expect(seen.size).toBeGreaterThan(3);
    for (const c of seen) expect(paintsFor(content.vehicles, 'saloon')).toContain(c);
    for (let i = 0; i < 20; i++) {
      expect(paintFor(content.vehicles, 'taxi', i)).toBe('#ffd21f');
      expect(paintFor(content.vehicles, 'interceptor', i)).toBe(variants.interceptor!.colour);
    }
    expect(paintFor(content.vehicles, 'hatch', 5)).toBe(paintFor(content.vehicles, 'hatch', 5));
  });
});

describe('vehicle models', () => {
  it('every variant builds a model within its triangle budget, with wheels and lamps', () => {
    for (const id of ids) {
      const p = variants[id]!;
      const m = buildCarModel(modelFor(id, p.model), p);
      const heavy = ['truck', 'bus', 'emergency'].includes(p.class) || p.length > 5.5;
      expect(m.triangles, id).toBeLessThanOrEqual(heavy ? 900 : 600);
      expect(m.layout.wheels.length, id).toBeGreaterThanOrEqual(p.twoWheel ? 2 : 4);
      expect(m.layout.lights.some((l) => l.k === 'head'), id).toBe(true);
      expect(m.layout.lights.some((l) => l.k === 'tail'), id).toBe(true);
      expect(m.layout.rider !== null, id).toBe(p.twoWheel);
      if (p.role === 'police' || p.class === 'emergency') expect(m.layout.beacons, id).not.toBe('none');
      // Wheels sit inside the collision box (what you see is what you hit).
      for (const w of m.layout.wheels) expect(Math.abs(w.z * m.layout.scale) + w.r * m.layout.scale * 0.5, id).toBeLessThan(p.length / 2 + 0.01);
      expect(m.geometry.getAttribute('paintMask').count).toBe(m.geometry.getAttribute('position').count);
    }
  });
});
