import { describe, expect, it } from 'vitest';
import { rawContent } from '@neonheat/content';
import { paintFor, parseSimContent, serviceSites, type ServiceSite, type SimContent, type SimEvent, type World } from '@neonheat/sim';
import { intents, loadContent, makeWorld, run } from './helpers';

const idle = intents();

function quiet(patch?: (c: SimContent) => void): SimContent {
  const c = loadContent();
  c.traffic.count = 0;
  c.peds.count = 0;
  patch?.(c);
  return c;
}

async function quietWorld(seed = 1, patch?: (c: SimContent) => void): Promise<World> {
  const w = await makeWorld(seed, quiet(patch));
  w.police.cap = 0;
  return w;
}

function site(w: World, id: string): ServiceSite {
  const s = w.economy.sites.find((q) => q.id === id);
  if (!s) throw new Error(`no site ${id}`);
  return s;
}

/** Step the world, collecting every event. */
function collect(w: World, seconds: number, input = idle): SimEvent[] {
  const out: SimEvent[] = [];
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    w.step(input);
    out.push(...w.events);
  }
  return out;
}

/** Walk the on-foot player to (x, z) in small steps (no teleport jump), collecting events. */
function walkTo(w: World, x: number, z: number): SimEvent[] {
  const out: SimEvent[] = [];
  const pc = w.playerCtl;
  for (let i = 0; i < 200; i++) {
    const dx = x - pc.x;
    const dz = z - pc.z;
    const d = Math.hypot(dx, dz);
    const k = Math.min(1, 0.25 / Math.max(d, 1e-6));
    pc.teleport(pc.x + dx * k, pc.z + dz * k);
    w.step(idle);
    out.push(...w.events);
    if (d < 0.05) break;
  }
  return out;
}

/** Creep the player's car to (x, z) at walking pace, collecting events. */
function creepTo(w: World, x: number, z: number): SimEvent[] {
  const out: SimEvent[] = [];
  const v = w.player.vehicle!;
  for (let i = 0; i < 400; i++) {
    const dx = x - v.x;
    const dz = z - v.z;
    const d = Math.hypot(dx, dz);
    const k = Math.min(1, 0.04 / Math.max(d, 1e-6));
    w.teleportVehicle(v, v.x + dx * k, v.z + dz * k, v.yaw);
    w.step(idle);
    out.push(...w.events);
    if (d < 0.05) break;
  }
  return out;
}

/** Put the player in a fresh car a little way out from a drive-in site. */
function carNear(w: World, s: ServiceSite, variant = 'kestrel') {
  const out = w.content.economy.carPad.radius + 4;
  const x = s.x + s.fx * out;
  const z = s.z + s.fz * out;
  const v = w.spawnVehicle(variant, x, z, Math.atan2(-s.fx, -s.fz), 'parked')!;
  w.playerCtl.enter(v);
  w.step(idle);
  return v;
}

/** Stand just beside an on-foot pad. */
function standNear(w: World, s: ServiceSite): void {
  if (w.player.vehicle) w.playerCtl.exit();
  const r = w.content.economy.padRadius + 1.5;
  w.playerCtl.teleport(s.x - s.fz * r, s.z + s.fx * r);
  w.step(idle);
}

describe('service sites', () => {
  it('finds every service marker, faces each towards a road and puts a workshop behind each drive-in pad', async () => {
    const w = await quietWorld(1);
    const sites = serviceSites(w.content.map);
    const kinds = new Map<string, number>();
    for (const s of sites) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
    expect(Object.fromEntries(kinds)).toEqual({ clinic: 2, precinct: 2, safehouse: 3, respray: 2, arms: 2, chopshop: 2 });
    for (const s of sites) {
      expect(Math.abs(s.fx) + Math.abs(s.fz), s.id).toBe(1);
      if (s.drive) {
        expect(s.back, `${s.id} workshop`).toBeGreaterThan(4);
        expect(s.back, `${s.id} workshop`).toBeLessThan(7);
        // The yard in front of the door is open ground.
        expect(w.insideBuilding(s.x, s.z, 1), s.id).toBe(false);
      }
    }
  });
});

describe('respray', () => {
  it('charges, repaints, repairs and clears HEAT when nobody is watching', async () => {
    const w = await quietWorld(3);
    const s = site(w, 'respray_1');
    const v = carNear(w, s);
    w.score.credits = 1000;
    v.hp = v.params.maxHealth * 0.4;
    const paint = paintFor(w.content.vehicles, v.variantId, v.paintSeed);
    w.content.heat.levels[2]!.drone = false;
    w.heat.setLevel(2, s.x, s.z);
    run(w, 2, idle);
    const ev = creepTo(w, s.x, s.z);
    const r = ev.find((e) => e.type === 'respray');
    expect(r?.type === 'respray' && r.result).toBe('cleared');
    expect(r?.type === 'respray' && r.price).toBe(w.content.economy.respray.price);
    expect(w.score.credits).toBe(1000 - w.content.economy.respray.price);
    expect(w.heat.level).toBe(0);
    expect(v.hp).toBe(v.params.maxHealth);
    expect(paintFor(w.content.vehicles, v.variantId, v.paintSeed)).not.toBe(paint);
  });

  it('refuses when you cannot pay, and charges nothing', async () => {
    const w = await quietWorld(4);
    const s = site(w, 'respray_2');
    const v = carNear(w, s);
    w.score.credits = 20;
    const seed = v.paintSeed;
    w.heat.setLevel(1, s.x, s.z);
    run(w, 2, idle);
    const ev = creepTo(w, s.x, s.z);
    const r = ev.find((e) => e.type === 'respray');
    expect(r?.type === 'respray' && r.result).toBe('broke');
    expect(w.score.credits).toBe(20);
    expect(v.paintSeed).toBe(seed);
    expect(w.heat.level).toBe(1);
  });

  it('refuses while the police can see you or when HEAT is too high', async () => {
    const w = await quietWorld(5);
    const s = site(w, 'respray_1');
    carNear(w, s);
    w.score.credits = 1000;
    w.heat.setLevel(2, s.x, s.z);
    w.police.sinceSeen = 0;
    w.economy.respray();
    // sinceSeen is reset by a sighting each step; here it is zero at the moment of the respray.
    expect(w.events.some((e) => e.type === 'respray' && e.result === 'seen')).toBe(true);
    expect(w.score.credits).toBe(1000);
    w.events.length = 0;
    w.heat.setLevel(4, s.x, s.z);
    w.police.sinceSeen = 10;
    w.economy.respray();
    expect(w.events.some((e) => e.type === 'respray' && e.result === 'tooHot')).toBe(true);
    expect(w.heat.level).toBe(4);
    expect(w.score.credits).toBe(1000);
  });

  it("goes on the crew's tab while a job runs", async () => {
    const w = await quietWorld(6);
    const s = site(w, 'respray_1');
    carNear(w, s);
    w.score.credits = 0;
    w.economy.jobActive = true;
    w.economy.respray();
    expect(w.events.some((e) => e.type === 'respray' && e.result === 'clean' && e.price === 0)).toBe(true);
  });

  it('every car rolls its own paint seed without touching the world RNG', async () => {
    const a = await quietWorld(7);
    const b = await quietWorld(7);
    const va = a.spawnVehicle('hatch', 0, -150, 0, 'parked')!;
    const vb = b.spawnVehicle('hatch', 0, -150, 0, 'parked')!;
    expect(va.paintSeed).toBe(vb.paintSeed);
    const vc = a.spawnVehicle('hatch', 5, -150, 0, 'parked')!;
    expect(vc.paintSeed).not.toBe(va.paintSeed);
    run(a, 1, idle);
    run(b, 1, idle);
    expect(a.stateHash()).not.toBe(''); // still deterministic with the extra car
  });
});

describe('arms shop', () => {
  it('walking onto the pad opens the shop; a teleport onto it does not', async () => {
    const w = await quietWorld(8);
    const s = site(w, 'armsshop_1');
    standNear(w, s);
    const ev = walkTo(w, s.x, s.z);
    expect(ev.some((e) => e.type === 'shopOpen' && e.siteId === 'armsshop_1' && e.kind === 'arms')).toBe(true);
    expect(w.economy.atSite?.id).toBe('armsshop_1');
    expect(w.playerCtl.context?.label).toBe('SHOP');
    // Pressing the context button opens it again.
    const again = collect(w, 2 / 60, intents({ interact: true }));
    expect(again.some((e) => e.type === 'shopOpen')).toBe(true);
    // Away and back by teleport: no auto-open.
    w.playerCtl.teleport(s.x + 30, s.z);
    w.step(idle);
    w.playerCtl.teleport(s.x, s.z);
    const tp = collect(w, 0.2);
    expect(tp.some((e) => e.type === 'shopOpen')).toBe(false);
  });

  it('sells weapons, ammo and armour at the JSON prices, and refuses what you cannot use or afford', async () => {
    const w = await quietWorld(9);
    const s = site(w, 'armsshop_2');
    standNear(w, s);
    walkTo(w, s.x, s.z);
    const eco = w.economy;
    const cfg = w.content.economy.arms;
    w.score.credits = 2000;
    expect(eco.buy('ammo:smg').reason).toBe('needWeapon');
    const smg = eco.buy('weapon:smg');
    expect(smg).toMatchObject({ ok: true, price: cfg.weapons.smg!.price });
    expect(w.combat.has('smg')).toBe(true);
    expect(w.combat.ammoOf('smg')).toBe(cfg.weapons.smg!.ammo);
    expect(eco.unlocks.has('weapon:smg')).toBe(true);
    expect(eco.buy('weapon:smg').reason).toBe('owned');
    const before = w.combat.ammoOf('smg');
    expect(eco.buy('ammo:smg').ok).toBe(true);
    expect(w.combat.ammoOf('smg')).toBe(before + cfg.ammo.smg!.rounds);
    expect(eco.buy('armour').ok).toBe(true);
    expect(w.playerCtl.armour).toBe(cfg.armour.amount);
    expect(w.score.credits).toBe(2000 - cfg.weapons.smg!.price - cfg.ammo.smg!.price - cfg.armour.price);
    w.score.credits = 10;
    const broke = eco.buy('weapon:rifle');
    expect(broke).toMatchObject({ ok: false, reason: 'broke', price: cfg.weapons.rifle!.price });
    expect(w.combat.has('rifle')).toBe(false);
    expect(w.score.credits).toBe(10);
    w.playerCtl.armour = w.playerCtl.maxArmour;
    w.score.credits = 1000;
    expect(eco.buy('armour').reason).toBe('full');
    // Off the pad nothing is for sale.
    w.playerCtl.teleport(s.x + 30, s.z);
    w.step(idle);
    expect(eco.buy('ammo:smg').reason).toBe('away');
  });

  it('weapons are lost on FLATLINED but a bought one can be rebought at the rebuy price', async () => {
    const w = await quietWorld(10);
    w.content.economy.safehouses.respawn = false;
    const eco = w.economy;
    const cfg = w.content.economy.arms;
    w.score.credits = 5000;
    expect(eco.buy('weapon:shotgun', 'arms').ok).toBe(true);
    w.playerCtl.hurt(1000, -1);
    expect(w.combat.has('shotgun')).toBe(false);
    run(w, w.content.survival.flatlined.respawnSec + 0.3, idle);
    expect(w.survival.alive).toBe(true);
    const price = eco.weaponPrice('shotgun');
    expect(price).toBe(Math.round((cfg.weapons.shotgun!.price * cfg.rebuyFraction) / 10) * 10);
    expect(price).toBeLessThan(cfg.weapons.shotgun!.price);
    const offer = eco.offers('arms').find((o) => o.item === 'weapon:shotgun')!;
    expect(offer).toMatchObject({ rebuy: true, price, state: 'buy' });
    const credits = w.score.credits;
    expect(eco.buy('weapon:shotgun', 'arms')).toMatchObject({ ok: true, price });
    expect(w.score.credits).toBe(credits - price);
  });
});

describe('safehouses', () => {
  it('the first safehouse is owned from the start; walking in heals and asks for a save', async () => {
    const w = await quietWorld(11);
    const s = site(w, 'safehouse_1');
    expect(w.economy.owns('safehouse_1')).toBe(true);
    expect(w.economy.owns('safehouse_2')).toBe(false);
    w.playerCtl.hp = 30;
    standNear(w, s);
    const ev = walkTo(w, s.x, s.z);
    expect(ev.some((e) => e.type === 'safehouseEntered' && e.siteId === 'safehouse_1' && e.healed)).toBe(true);
    expect(w.playerCtl.hp).toBe(w.playerCtl.maxHp);
    expect(w.playerCtl.context?.label).toBe('REST');
  });

  it('buys a safehouse at the door with the context button, and only with the credits', async () => {
    const w = await quietWorld(12);
    const s = site(w, 'safehouse_2');
    const price = w.content.economy.safehouses.prices['safehouse_2']!;
    standNear(w, s);
    w.score.credits = price - 1;
    const ev = walkTo(w, s.x, s.z);
    expect(ev.some((e) => e.type === 'safehouseForSale' && e.price === price)).toBe(true);
    expect(w.playerCtl.context?.label).toBe('BUY');
    collect(w, 2 / 60, intents({ interact: true }));
    expect(w.economy.owns('safehouse_2')).toBe(false);
    expect(w.score.credits).toBe(price - 1);
    w.score.credits = price + 50;
    const bought = collect(w, 2 / 60, intents({ interact: true }));
    expect(bought.some((e) => e.type === 'purchase' && e.item === 'safehouse:safehouse_2' && e.price === price)).toBe(true);
    expect(bought.some((e) => e.type === 'safehouseEntered')).toBe(true);
    expect(w.economy.owns('safehouse_2')).toBe(true);
    expect(w.score.credits).toBe(50);
  });

  it('after FLATLINED you wake at an owned safehouse when it is nearer than the clinic; BOOKED still goes to the precinct', async () => {
    const w = await quietWorld(13);
    const s = site(w, 'safehouse_3');
    w.economy.grant(['safehouse:safehouse_3']);
    w.playerCtl.teleport(s.x + 6, s.z + 6);
    w.step(idle);
    w.playerCtl.hurt(1000, -1);
    run(w, w.content.survival.flatlined.respawnSec + 0.3, idle);
    expect(Math.hypot(w.playerCtl.x - s.x, w.playerCtl.z - s.z)).toBeLessThan(1);
    // Not owned: the clinic.
    const w2 = await quietWorld(13);
    w2.playerCtl.teleport(s.x + 6, s.z + 6);
    w2.step(idle);
    w2.playerCtl.hurt(1000, -1);
    run(w2, w2.content.survival.flatlined.respawnSec + 0.3, idle);
    const clinic = w2.survival.nearestMarker('clinic', s.x + 6, s.z + 6);
    expect(Math.hypot(w2.playerCtl.x - clinic.x, w2.playerCtl.z - clinic.z)).toBeLessThan(1);
    // Booked beside the owned safehouse: precinct.
    w.playerCtl.teleport(s.x + 6, s.z + 6);
    w.step(idle);
    w.survival.book();
    run(w, w.content.survival.booked.respawnSec + 0.3, idle);
    const precinct = w.survival.nearestMarker('precinct', s.x + 6, s.z + 6);
    expect(Math.hypot(w.playerCtl.x - precinct.x, w.playerCtl.z - precinct.z)).toBeLessThan(1);
  });
});

describe('cyberware', () => {
  it('is sold at a clinic only, once each', async () => {
    const w = await quietWorld(14);
    const eco = w.economy;
    w.score.credits = 100000;
    expect(eco.buy('cyber:plating', 'arms').reason).toBe('away');
    expect(eco.buy('cyber:plating', 'clinic').ok).toBe(true);
    expect(eco.buy('cyber:plating', 'clinic').reason).toBe('owned');
    expect(eco.offers('clinic').find((o) => o.item === 'cyber:plating')?.state).toBe('owned');
    expect(eco.buy('cyber:telepathy', 'clinic').reason).toBe('unknown');
  });

  it('Plating raises the armour cap', async () => {
    const w = await quietWorld(15);
    const base = w.playerCtl.maxArmour;
    w.score.credits = 100000;
    w.economy.buy('cyber:plating', 'clinic');
    expect(w.playerCtl.maxArmour).toBe(base + w.content.economy.cyberware.plating.armourBonus);
    w.playerCtl.armour = w.playerCtl.maxArmour - 10;
    expect(w.economy.buy('armour', 'arms').ok).toBe(true);
    expect(w.playerCtl.armour).toBe(w.playerCtl.maxArmour);
  });

  it('Ghost slows HEAT build-up', async () => {
    const plain = await quietWorld(16);
    const ghost = await quietWorld(16);
    ghost.score.credits = 100000;
    ghost.economy.buy('cyber:ghost', 'clinic');
    plain.heat.addPoints(20, 0, 0);
    ghost.heat.addPoints(20, 0, 0);
    expect(ghost.heat.points).toBeCloseTo(plain.heat.points * ghost.content.economy.cyberware.ghost.heatMul, 6);
    plain.heat.addUnwitnessed(10, 0, 0);
    ghost.heat.addUnwitnessed(10, 0, 0);
    expect(ghost.heat.points).toBeLessThan(plain.heat.points);
  });

  it('Reflex slows time on a dodge and makes the roll untouchable', async () => {
    const w = await quietWorld(17);
    const r = w.content.economy.cyberware.reflex;
    w.playerCtl.teleport(0, -150);
    w.step(idle);
    // Without Reflex a dodge is just a dodge.
    collect(w, 1 / 60, intents({ dodge: true }));
    expect(w.economy.timeScale).toBe(1);
    run(w, 2, idle);
    w.score.credits = 100000;
    w.economy.buy('cyber:reflex', 'clinic');
    const ev = collect(w, 1 / 60, intents({ dodge: true }));
    expect(ev.some((e) => e.type === 'reflex')).toBe(true);
    expect(w.economy.timeScale).toBe(r.timeScale);
    const hp = w.playerCtl.hp;
    w.playerCtl.hurt(40, -1);
    expect(w.playerCtl.hp).toBe(hp);
    run(w, Math.max(r.slowSec, r.iframeSec) + 0.1, idle);
    expect(w.economy.timeScale).toBe(1);
    w.playerCtl.hurt(40, -1);
    expect(w.playerCtl.hp).toBeLessThan(hp);
  });
});

describe('export list', () => {
  it('lists distinct civilian variants from the pool, the same for the same seed', async () => {
    const a = await quietWorld(18);
    const b = await quietWorld(18);
    const n = a.content.economy.exports.listSize;
    expect(a.economy.exportList).toHaveLength(n);
    expect(new Set(a.economy.exportList).size).toBe(n);
    expect(a.economy.exportList).toEqual(b.economy.exportList);
    const pool = a.economy.exportPool();
    for (const v of a.economy.exportList) {
      expect(pool).toContain(v);
      expect(a.content.vehicles.variants[v]!.role).toBe('civilian');
    }
    expect(pool).not.toContain('interceptor');
    expect(pool).not.toContain('loopline');
  });

  it('pays for a listed car in decent condition by class and condition, takes the car and rotates the list', async () => {
    const w = await quietWorld(19);
    const s = site(w, 'chopshop_1');
    const variant = w.economy.exportList[0]!;
    const v = carNear(w, s, variant);
    v.hp = v.params.maxHealth * 0.8;
    const ex = w.content.economy.exports;
    const cls = w.content.vehicles.variants[variant]!.class;
    const expected = Math.round((ex.classPrice[cls]! * (ex.conditionFloor + (1 - ex.conditionFloor) * ((0.8 - ex.minCondition) / (1 - ex.minCondition)))) / 10) * 10;
    w.score.credits = 0;
    const ev = creepTo(w, s.x, s.z);
    const d = ev.find((e) => e.type === 'exportDelivered');
    expect(d?.type === 'exportDelivered' && d.price).toBe(expected);
    expect(w.score.credits).toBe(expected);
    expect(w.player.vehicle).toBeNull();
    expect(v.active).toBe(false);
    expect(w.economy.exportList).not.toContain(variant);
    expect(w.economy.exportList).toHaveLength(ex.listSize);
    expect(w.economy.exportsDelivered).toBe(1);
  });

  it('turns away unlisted, wrecked-looking and hot cars, and buys nothing during a job', async () => {
    const w = await quietWorld(20);
    const s = site(w, 'chopshop_2');
    const pool = w.economy.exportPool();
    const unlisted = pool.find((p) => !w.economy.exportList.includes(p))!;
    carNear(w, s, unlisted);
    let ev = creepTo(w, s.x, s.z);
    expect(ev.some((e) => e.type === 'exportRefused' && e.reason === 'notListed')).toBe(true);
    w.playerCtl.exit();
    const listed = w.economy.exportList[1]!;
    const v = carNear(w, s, listed);
    v.hp = v.params.maxHealth * (w.content.economy.exports.minCondition - 0.1);
    ev = creepTo(w, s.x, s.z);
    expect(ev.some((e) => e.type === 'exportRefused' && e.reason === 'tooDamaged')).toBe(true);
    expect(w.player.vehicle).toBe(v);
    v.hp = v.params.maxHealth;
    w.heat.setLevel(1, s.x, s.z);
    creepTo(w, s.x + s.fx * 9, s.z + s.fz * 9);
    ev = creepTo(w, s.x, s.z);
    expect(ev.some((e) => e.type === 'exportRefused' && e.reason === 'hot')).toBe(true);
    w.heat.clear();
    w.economy.jobActive = true;
    creepTo(w, s.x + s.fx * 9, s.z + s.fz * 9);
    ev = creepTo(w, s.x, s.z);
    expect(ev.some((e) => e.type === 'exportDelivered' || e.type === 'exportRefused')).toBe(false);
    expect(w.player.vehicle).toBe(v);
  });

  it('restores the list, unlocks and cyberware from the save state', async () => {
    const a = await quietWorld(21);
    a.score.credits = 100000;
    a.economy.buy('cyber:ghost', 'clinic');
    a.economy.buy('weapon:rifle', 'arms');
    const st = a.economy.state();
    const b = await quietWorld(22);
    b.economy.restore(st);
    expect(b.economy.exportList).toEqual(a.economy.exportList);
    expect(b.economy.cyberware.has('ghost')).toBe(true);
    expect(b.heat.gainMul).toBe(b.content.economy.cyberware.ghost.heatMul);
    expect(b.economy.unlocks.has('weapon:rifle')).toBe(true);
    expect(b.economy.owns('safehouse_1')).toBe(true);
    // Junk in an old save is dropped, and the list refilled.
    b.economy.restore({ exportList: ['not_a_car'], cyberware: ['laser_eyes'] });
    expect(b.economy.exportList).toHaveLength(b.content.economy.exports.listSize);
    expect(b.economy.cyberware.size).toBe(0);
    expect(b.heat.gainMul).toBe(1);
  });
});

describe('economy content', () => {
  it('validates economy.json and rejects prices for unknown weapons', () => {
    const c = loadContent();
    expect(c.economy.respray.price).toBeGreaterThan(0);
    const raw = structuredClone(rawContent) as unknown as { economy: { arms: { weapons: Record<string, unknown> } } };
    raw.economy.arms.weapons['raygun'] = { price: 1, ammo: 0 };
    expect(() => parseSimContent(raw as never)).toThrow(/raygun/);
  });
});
