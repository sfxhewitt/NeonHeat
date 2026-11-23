import { describe, expect, it } from 'vitest';
import type { SimContent, SimEvent, World } from '@neonheat/sim';
import { intents, loadContent, makeWorld, run } from './helpers';

const idle = intents();

/** Distance from the player to the nearest marker whose id starts with one of `prefixes`. */
function nearestMarkerDist(w: World, ...prefixes: string[]): number {
  let best = Infinity;
  for (const [id, m] of Object.entries(w.content.map.markers)) {
    if (!prefixes.some((p) => id.startsWith(p))) continue;
    best = Math.min(best, Math.hypot(w.playerCtl.x - m.pos[0], w.playerCtl.z - m.pos[2]));
  }
  return best;
}

async function quietWorld(seed = 1, patch?: (c: SimContent) => void): Promise<World> {
  const c = loadContent();
  c.traffic.count = 0;
  c.peds.count = 0;
  patch?.(c);
  return makeWorld(seed, c);
}

function events(w: World, seconds: number, input = idle): SimEvent[] {
  const out: SimEvent[] = [];
  run(w, seconds, () => {
    out.push(...w.events);
    return input;
  });
  return out;
}

describe('armour', () => {
  it('absorbs damage before health', async () => {
    const w = await quietWorld();
    const pc = w.playerCtl;
    pc.armour = 50;
    pc.hurt(30, -1);
    expect(pc.hp).toBe(pc.maxHp);
    expect(pc.armour).toBe(20);
    pc.hurt(40, -1);
    expect(pc.armour).toBe(0);
    expect(pc.hp).toBe(pc.maxHp - 20);
  });
});

describe('FLATLINED', () => {
  it('loses a share of credits and the weapons, then respawns at the nearest clinic with HEAT cleared', async () => {
    const w = await quietWorld(2);
    const pc = w.playerCtl;
    w.score.credits = 1000;
    w.combat.give('smg', 100);
    w.heat.setLevel(2, pc.x, pc.z);
    const ev: SimEvent[] = [];
    pc.hurt(500, -1);
    ev.push(...w.events);
    const card = ev.find((e) => e.type === 'playerWasted');
    expect(card?.type === 'playerWasted' && card.creditsLost).toBe(Math.floor(1000 * w.content.survival.flatlined.creditFraction));
    expect(w.score.credits).toBe(1000 - Math.floor(1000 * w.content.survival.flatlined.creditFraction));
    expect(w.survival.fate).toBe('flatlined');
    expect(w.combat.has('smg')).toBe(false);
    const more = events(w, w.content.survival.flatlined.respawnSec + 0.2);
    expect(more.some((e) => e.type === 'playerRespawned')).toBe(true);
    expect(w.survival.alive).toBe(true);
    expect(pc.dead).toBe(false);
    expect(pc.hp).toBe(pc.maxHp);
    expect(w.heat.level).toBe(0);
    expect(nearestMarkerDist(w, 'clinic')).toBeLessThan(1);
  });

  it('respawns at the nearest of several clinics', async () => {
    const w = await quietWorld(3, (c) => {
      c.map.markers['clinic_east'] = { pos: [100, 0, 100] };
    });
    const pc = w.playerCtl;
    pc.teleport(110, 110);
    w.step(idle);
    pc.hurt(500, -1);
    run(w, w.content.survival.flatlined.respawnSec + 0.2, idle);
    expect(Math.hypot(pc.x - 100, pc.z - 100)).toBeLessThan(1);
  });

  it('a wrecked car near the player hurts them but does not instantly kill', async () => {
    const w = await quietWorld(4);
    const pc = w.playerCtl;
    const car = w.spawnVehicle('kestrel', pc.x + 5, pc.z, 0, 'parked')!;
    w.damageVehicle(car, 1e6);
    run(w, 1, idle);
    expect(pc.hp).toBeLessThan(pc.maxHp);
    expect(pc.dead).toBe(false);
  });
});

describe('BOOKED', () => {
  it('an officer next to a player standing still on foot cuffs them', async () => {
    const w = await quietWorld(5);
    const pc = w.playerCtl;
    w.score.credits = 1000;
    w.score.pending = 300;
    w.heat.setLevel(2, pc.x, pc.z);
    w.officers.spawnAt(pc.x + 1, pc.z);
    const ev = events(w, 2.5);
    const card = ev.find((e) => e.type === 'playerBusted');
    expect(card).toBeDefined();
    expect(w.survival.fate).toBe('booked');
    expect(pc.busted).toBe(true);
    expect(w.score.pending).toBe(0);
    expect(w.score.credits).toBe(1000 - Math.floor(1000 * w.content.survival.booked.creditFraction));
    // Respawn at a precinct, or player_start when the map has none.
    run(w, w.content.survival.booked.respawnSec + 0.2, idle);
    expect(pc.busted).toBe(false);
    expect(w.heat.level).toBe(0);
    expect(nearestMarkerDist(w, 'precinct', 'player_start')).toBeLessThan(1);
  });

  it('running away keeps you free; the arrest meter falls back', async () => {
    const w = await quietWorld(6);
    const pc = w.playerCtl;
    w.heat.setLevel(2, pc.x, pc.z);
    w.police.cap = 0;
    w.officers.spawnAt(pc.x + 1, pc.z);
    run(w, 0.5, idle);
    expect(w.police.arrestProgress).toBeGreaterThan(0);
    run(w, 3, intents({ moveX: -1 }));
    expect(w.survival.alive).toBe(true);
    expect(w.police.arrestProgress).toBe(0);
  });

  it('boxed in by two patrol cars while stopped in a car', async () => {
    const w = await quietWorld(7);
    w.police.cap = 0;
    const car = w.spawnVehicle('kestrel', -100, 0, 0, 'parked')!;
    w.playerCtl.enter(car);
    w.heat.setLevel(2, car.x, car.z);
    for (const dx of [-3.2, 3.2]) {
      const cop = w.spawnVehicle('interceptor', car.x + dx, car.z, 0, 'police')!;
      cop.ai.mode = 'stunned';
      cop.ai.timer = 1000;
    }
    const ev = events(w, w.content.heat.pursuit.boxInBustSec + 0.5);
    expect(ev.some((e) => e.type === 'playerBusted')).toBe(true);
    expect(w.playerCtl.mode).toBe('foot');
  });

  it('officers shoot an on-foot player from HEAT 3, not below', async () => {
    const shotAt = async (level: number): Promise<number> => {
      const w = await quietWorld(8);
      const pc = w.playerCtl;
      pc.teleport(-120, 0);
      w.step(idle);
      w.police.cap = 0;
      w.heat.setLevel(level, -120, 0);
      w.officers.spawnAt(-120, -8);
      const ev = events(w, 6, intents({ moveX: 0.5 }));
      return ev.filter((e) => e.type === 'shot' && !e.byPlayer).length;
    };
    expect(await shotAt(2)).toBe(0);
    expect(await shotAt(3)).toBeGreaterThan(2);
  });
});

describe('pickups', () => {
  it('parses kinds from marker ids', async () => {
    const w = await quietWorld();
    expect(w.pickups.kindFromMarker('pickup_health')).toBe('health');
    expect(w.pickups.kindFromMarker('pickup_smg_2')).toBe('smg');
    expect(w.pickups.kindFromMarker('pickup_armour_north')).toBe('armour');
    expect(w.pickups.kindFromMarker('pickup_nonsense')).toBeNull();
    expect(w.pickups.kindFromMarker('clinic')).toBeNull();
    // The generated city's names: pickup_<kind>_<district>_<n>, with grenade and taser as aliases.
    expect(w.pickups.kindFromMarker('pickup_grenade_docks_0')).toBe('grenade');
    expect(w.content.pickups.kinds['taser']!.weapon).toBe('arc');
  });

  it('places every pickup marker of the generated city', async () => {
    const w = await quietWorld();
    const ids = Object.keys(w.content.map.markers).filter((id) => id.startsWith('pickup_'));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(w.pickups.kindFromMarker(id)).not.toBeNull();
  });

  it('places pickups from map markers when there are some', async () => {
    const w = await quietWorld(1, (c) => {
      for (const id of Object.keys(c.map.markers)) if (id.startsWith('pickup_')) delete c.map.markers[id];
      c.map.markers['pickup_rifle_1'] = { pos: [10, 0, 10] };
    });
    const placed = w.pickups.pickups.filter((p) => p.active);
    expect(placed.length).toBe(1);
    expect(placed[0]!.kind).toBe('rifle');
  });

  it('spreads pickups over street corners when the map has no markers', async () => {
    const w = await quietWorld(1, (c) => {
      for (const id of Object.keys(c.map.markers)) if (id.startsWith('pickup_')) delete c.map.markers[id];
    });
    const placed = w.pickups.pickups.filter((p) => p.active);
    expect(placed.length).toBeGreaterThan(8);
    for (const p of placed) {
      expect(w.insideBuilding(p.x, p.z)).toBe(false);
      expect(w.roads.onRoad(p.x, p.z)).toBe(false);
    }
    expect(new Set(placed.map((p) => p.kind)).size).toBeGreaterThan(5);
  });

  it('health is collected when hurt, skipped when full, and respawns', async () => {
    const w = await quietWorld();
    const pc = w.playerCtl;
    const p = w.pickups.place('health', pc.x, pc.z)!;
    run(w, 0.2, idle);
    expect(p.available).toBe(true); // full health: left for later
    pc.hp = 40;
    const ev = events(w, 0.2);
    expect(ev.some((e) => e.type === 'pickup' && e.kind === 'health')).toBe(true);
    expect(pc.hp).toBe(90);
    expect(p.available).toBe(false);
    pc.teleport(pc.x + 30, pc.z);
    run(w, w.content.pickups.respawnSec + 0.5, idle);
    expect(p.available).toBe(true);
  });

  it('armour and weapon pickups', async () => {
    const w = await quietWorld();
    const pc = w.playerCtl;
    w.pickups.place('armour', pc.x, pc.z);
    w.pickups.place('shotgun', pc.x, pc.z, false);
    run(w, 0.2, idle);
    expect(pc.armour).toBe(50);
    expect(w.combat.has('shotgun')).toBe(true);
    expect(w.combat.ammoOf('shotgun')).toBe(w.content.pickups.kinds.shotgun!.ammo);
    expect(w.combat.weaponId).toBe('shotgun');
  });

  it('can be collected from a car', async () => {
    const w = await quietWorld();
    const car = w.spawnVehicle('kestrel', -100, 0, 0, 'parked')!;
    w.playerCtl.enter(car);
    w.pickups.place('smg', -100, 1.5);
    run(w, 0.2, idle);
    expect(w.combat.has('smg')).toBe(true);
  });
});

describe('street score', () => {
  it('chains crimes into a multiplier and banks once HEAT is gone', async () => {
    const w = await quietWorld();
    const s = w.score;
    s.crime('killPed');
    const one = s.pending;
    expect(one).toBe(w.content.heat.crimes.killPed.credits);
    s.crime('killPed');
    expect(s.multiplier).toBeGreaterThan(1);
    expect(s.pending).toBeGreaterThan(one * 2);
    w.heat.setLevel(1, 0, 0);
    run(w, 1, idle);
    expect(s.credits).toBe(0);
    w.heat.clear();
    const ev = events(w, w.content.survival.score.chainWindowSec + w.content.survival.score.bankDelaySec + 0.5);
    expect(ev.some((e) => e.type === 'scoreBanked')).toBe(true);
    expect(s.pending).toBe(0);
    expect(s.credits).toBeGreaterThan(one * 2);
    expect(s.multiplier).toBe(1);
  });
});
