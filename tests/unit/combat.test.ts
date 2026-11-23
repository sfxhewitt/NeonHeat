import { describe, expect, it } from 'vitest';
import type { Ped, SimContent, SimEvent, Vehicle, World } from '@neonheat/sim';
import { intents, loadContent, makeWorld, run } from './helpers';

const idle = intents();

/** An open lot: no buildings, traffic, pedestrians or police response. */
async function arena(seed = 1, patch?: (c: SimContent) => void): Promise<World> {
  const c = loadContent();
  c.traffic.count = 0;
  c.peds.count = 0;
  c.map.buildings = [];
  c.map.props = [];
  for (const l of c.heat.levels) l.units = 0;
  patch?.(c);
  const w = await makeWorld(seed, c);
  w.peds.cap = 12; // let tests place pedestrians
  w.playerCtl.teleport(0, 0);
  w.playerCtl.facing = Math.PI / 2; // east
  w.step(idle);
  return w;
}

function standingPed(w: World, x: number, z: number): Ped {
  const p = w.peds.spawnPedAt(x, z)!;
  // Rooted to the spot so the test is about the weapon.
  p.state = 'cower';
  p.timer = 1000;
  return p;
}

function parkedCop(w: World, x: number, z: number): Vehicle {
  const v = w.spawnVehicle('interceptor', x, z, 0, 'police')!;
  v.ai.mode = 'stunned';
  v.ai.timer = 1000;
  return v;
}

function hold(w: World, id: string, ammo = 999): void {
  w.combat.give(id, ammo);
  const i = w.combat.order.indexOf(id);
  while (w.combat.current !== i) w.combat.nextWeapon();
  // Let the weapon-switch delay pass.
  run(w, 0.2, idle);
}

function events(w: World, seconds: number, input = idle, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  run(w, seconds, () => {
    out.push(...w.events);
    each?.();
    return input;
  });
  return out;
}

/** Keep a hurt pedestrian from running off (they normally flee), so a combo can land. */
function root(p: Ped): () => void {
  return () => {
    if (p.state === 'down') return;
    p.state = 'cower';
    p.timer = 1000;
  };
}

describe('inventory', () => {
  it('starts with fists and a pistol in hand, and cycles owned weapons', async () => {
    const w = await arena();
    expect(w.combat.weaponId).toBe('pistol');
    expect(w.combat.has('fists')).toBe(true);
    expect(w.combat.has('smg')).toBe(false);
    w.step(intents({ nextWeapon: true }));
    expect(w.combat.weaponId).toBe('fists');
    w.combat.give('shotgun', 10);
    expect(w.combat.weaponId).toBe('shotgun');
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      w.step(intents({ nextWeapon: true }));
      seen.add(w.combat.weaponId);
    }
    expect([...seen].sort()).toEqual(['fists', 'pistol', 'shotgun']);
  });

  it('uses ammo and drops to the next weapon when empty', async () => {
    const w = await arena();
    hold(w, 'shotgun', 2);
    run(w, 3, intents({ fire: true }));
    expect(w.combat.ammoOf('shotgun')).toBe(0);
    expect(w.combat.weaponId).not.toBe('shotgun');
  });

  it('caps ammo at the weapon maximum', async () => {
    const w = await arena();
    w.combat.give('rifle', 10_000);
    expect(w.combat.ammoOf('rifle')).toBe(w.content.weapons.weapons.rifle!.ammoMax);
    expect(w.combat.give('rifle', 5)).toBe(false);
  });
});

describe('weapons', () => {
  it('fists: a three-hit combo, the last hit hardest, puts a pedestrian down', async () => {
    const w = await arena();
    hold(w, 'fists');
    const ped = standingPed(w, 1.2, 0);
    const hp0 = ped.hp;
    const ev = events(w, 0.95, intents({ fire: true }), root(ped));
    const blows = ev.filter((e) => e.type === 'melee');
    expect(blows.length).toBe(3);
    expect(blows.map((e) => (e.type === 'melee' ? e.combo : -1))).toEqual([0, 1, 2]);
    const combo = w.content.weapons.weapons.fists!.comboDamage;
    expect(combo[2]!).toBeGreaterThan(combo[0]!);
    expect(ped.hp).toBeLessThan(hp0);
    events(w, 1.5, intents({ fire: true }), root(ped));
    expect(ped.state).toBe('down');
  });

  it('bat: two swings floor a pedestrian', async () => {
    const w = await arena();
    hold(w, 'bat');
    const ped = standingPed(w, 1.6, 0);
    events(w, 1.2, intents({ fire: true }), root(ped));
    expect(ped.state).toBe('down');
  });

  it('pistol: soft-locks a police car and damages it', async () => {
    const w = await arena();
    hold(w, 'pistol');
    const cop = parkedCop(w, 15, 2);
    run(w, 1, intents({ fire: true }));
    expect(w.combat.aimKind).toBe('vehicle');
    expect(cop.hp).toBeLessThan(cop.params.maxHealth);
  });

  it('SMG: fires several times faster than the pistol', async () => {
    const shots = async (id: string): Promise<number> => {
      const w = await arena();
      hold(w, id);
      return events(w, 1, intents({ fire: true })).filter((e) => e.type === 'shot').length;
    };
    const smg = await shots('smg');
    const pistol = await shots('pistol');
    expect(smg).toBeGreaterThanOrEqual(10);
    expect(smg).toBeGreaterThanOrEqual(pistol * 2.5);
  });

  it('shotgun: one pull fires a spread of pellets', async () => {
    const w = await arena();
    hold(w, 'shotgun');
    const ev = events(w, 0.1, intents({ fire: true }));
    const pellets = ev.filter((e) => e.type === 'shot');
    expect(pellets.length).toBe(w.content.weapons.weapons.shotgun!.pellets);
    const angles = pellets.map((e) => (e.type === 'shot' ? Math.atan2(e.hx - e.x, e.hz - e.z) : 0));
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(0.1);
    expect(w.combat.ammoOf('shotgun')).toBe(w.content.weapons.weapons.shotgun!.ammoMax - 1);
  });

  it('rifle: reaches a target well beyond pistol range', async () => {
    const w = await arena();
    const cop = parkedCop(w, 55, 0);
    hold(w, 'pistol');
    run(w, 1, intents({ fire: true }));
    expect(cop.hp).toBe(cop.params.maxHealth);
    hold(w, 'rifle');
    run(w, 1, intents({ fire: true }));
    expect(cop.hp).toBeLessThan(cop.params.maxHealth);
  });

  it('grenade launcher: an arcing grenade blows up, hurts people and throws cars over', async () => {
    const w = await arena();
    hold(w, 'launcher');
    const car = parkedCop(w, 18, 0);
    const ped = standingPed(w, 17, 2.5);
    w.step(intents({ fire: true }));
    const g = w.combat.projectiles.find((p) => p.active)!;
    expect(g).toBeDefined();
    let peak = 0;
    let flip = 0;
    const ev: SimEvent[] = [];
    run(w, 2.5, () => {
      if (g.active) peak = Math.max(peak, g.y);
      flip = Math.max(flip, w.combat.flip[car.id]!);
      ev.push(...w.events);
      return idle;
    });
    expect(peak).toBeGreaterThan(2);
    expect(ev.some((e) => e.type === 'explosion')).toBe(true);
    expect(car.hp).toBeLessThan(car.params.maxHealth * 0.6);
    expect(ped.hp).toBeLessThan(w.content.peds.hp);
    expect(flip).toBeGreaterThan(0);
  });

  it('arc caster: chains to two more targets and stuns them', async () => {
    const w = await arena();
    hold(w, 'arc');
    const a = standingPed(w, 4, 0);
    const b = standingPed(w, 8, 1);
    const c = standingPed(w, 12, 0);
    for (const p of [a, b, c]) p.state = 'wander';
    const ev = events(w, 0.05, intents({ fire: true }));
    const arc = ev.find((e) => e.type === 'arc');
    expect(arc?.type === 'arc' && arc.n).toBe(4);
    for (const p of [a, b, c]) expect(p.state).toBe('cower');
  });

  it('arc caster stuns an officer', async () => {
    const w = await arena();
    hold(w, 'arc');
    w.heat.setLevel(2, 0, 0);
    const o = w.officers.spawnAt(5, 0)!;
    run(w, 0.05, intents({ fire: true }));
    expect(o.state).toBe('stunned');
  });

  it('drive-by: an SMG fires out of the side window', async () => {
    const w = await arena();
    const car = w.spawnVehicle('kestrel', 0, 0, 0, 'parked')!; // facing +Z: its left is +X
    w.playerCtl.enter(car);
    const cop = parkedCop(w, 10, 0);
    hold(w, 'smg');
    run(w, 1, intents({ fire: true }));
    expect(cop.hp).toBeLessThan(cop.params.maxHealth);
    expect(w.combat.aimKind).toBe('vehicle');
  });

  it('melee weapons cannot be fired from a car', async () => {
    const w = await arena();
    const car = w.spawnVehicle('kestrel', 0, 0, 0, 'parked')!;
    w.playerCtl.enter(car);
    hold(w, 'bat');
    const ev = events(w, 1, intents({ fire: true }));
    expect(ev.some((e) => e.type === 'melee' || e.type === 'shot')).toBe(false);
  });
});

describe('vehicles and explosions', () => {
  it('a wrecked car explodes and damages the cars around it', async () => {
    const w = await arena();
    const a = w.spawnVehicle('kestrel', 20, 0, 0, 'parked')!;
    const b = w.spawnVehicle('kestrel', 24, 0, 0, 'parked')!;
    w.damageVehicle(a, 1e6);
    const ev = events(w, 1);
    expect(ev.some((e) => e.type === 'explosion')).toBe(true);
    expect(b.hp).toBeLessThan(b.params.maxHealth);
  });

  it('shooting a police car to pieces is a serious crime', async () => {
    const w = await arena();
    const cop = parkedCop(w, 12, 0);
    w.damageVehicle(cop, cop.params.maxHealth - 5);
    hold(w, 'pistol');
    run(w, 0.5, intents({ fire: true }));
    expect(cop.destroyed).toBe(true);
    // The police car itself saw it: full HEAT, past the unwitnessed cap.
    expect(w.heat.level).toBeGreaterThanOrEqual(2);
  });
});
