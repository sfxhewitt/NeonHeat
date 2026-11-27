import { expect, test, type CDPSession, type Page } from '@playwright/test';

/**
 * Mobile-first path. Runs as an emulated iPhone 13 held in portrait (rotation
 * lock on: the game draws itself turned on its side) and held in landscape.
 * Every action is a real touch on the screen: the floating stick and the
 * on-screen buttons. Test hooks only read state and teleport the player
 * between steps to keep the run short.
 */

interface Pt {
  x: number;
  y: number;
}

/** App (landscape) coordinates -> screen coordinates, matching packages/ui/src/screen.ts. */
async function toScreen(page: Page, x: number, y: number): Promise<Pt> {
  return page.evaluate(
    ([lx, ly]) => {
      const rotated = matchMedia('(orientation: portrait) and (pointer: coarse)').matches;
      return rotated ? { x: window.innerWidth - ly!, y: lx! } : { x: lx!, y: ly! };
    },
    [x, y],
  );
}

/** Wait until the game has simulated `seconds` (slow CI renders fewer frames per wall second). */
async function simFor(page: Page, seconds: number): Promise<void> {
  const t0 = await page.evaluate(() => window.__neon!.game.world.time as number);
  await page.waitForFunction((t) => (window.__neon!.game.world.time as number) >= t, t0 + seconds, { timeout: 60_000 });
}

async function appSize(page: Page): Promise<{ w: number; h: number }> {
  return page.evaluate(() => {
    const r = document.getElementById('app')!;
    return { w: r.clientWidth, h: r.clientHeight };
  });
}

/** One finger on the floating stick, in app coordinates. */
class Finger {
  private down = false;
  constructor(
    private readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}
  private async send(type: 'touchStart' | 'touchMove' | 'touchEnd', p: Pt | null): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1 }] : [] });
  }
  async press(x: number, y: number): Promise<void> {
    await this.send('touchStart', await toScreen(this.page, x, y));
    this.down = true;
  }
  async move(x: number, y: number): Promise<void> {
    // A few intermediate moves, like a real thumb.
    await this.send('touchMove', await toScreen(this.page, x, y));
  }
  async release(): Promise<void> {
    if (this.down) await this.send('touchEnd', null);
    this.down = false;
  }
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

const player = (page: Page) =>
  page.evaluate(() => {
    const w = window.__neon!.game.world;
    const v = w.player.vehicle;
    return { x: w.player.x, z: w.player.z, driving: !!v, variant: v?.variantId ?? null, speed: v ? Math.hypot(v.vx, v.vz) : 0 };
  });

test('iPhone, touch only: start, walk, drive, steal, hack and finish Hot Chrome', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const cdp = await page.context().newCDPSession(page);
  const finger = new Finger(page, cdp);
  const context = page.locator('.nh-btn--context');

  // --- Start from the title screen with a tap, exactly as a player would.
  await page.goto('/?quality=low');
  const start = page.locator('.nh-title__press');
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.tap();
  await page.locator('.nh-title [data-act="new"]').tap();
  await page.waitForFunction(() => window.__neon?.ready === true, null, { timeout: 30_000 });

  // Sound starts on that first tap, and plays through the iPhone silent switch.
  await expect.poll(() => page.evaluate(() => window.__neon!.game.sound.audio.engine.ctx?.state)).toBe('running');
  expect(await page.evaluate(() => window.__neon!.game.sound.audio.engine.silentSwitch)).not.toBe('none');

  // The game is always landscape, whichever way the phone is held.
  const size = await appSize(page);
  expect(size.w).toBeGreaterThan(size.h);
  const view = await page.evaluate(() => window.__neon!.game.viewport.size);
  expect(view.width).toBeGreaterThan(view.height);
  await expect(page.locator('text=Turn your device')).toHaveCount(0);

  // --- Walk: push the floating stick up (north is -Z), then right (+X).
  // The title must be fully gone (it hides the touch layer while it fades out).
  await expect(page.locator('.nh-title')).toHaveCount(0);
  const sx = size.w * 0.2;
  const sy = size.h * 0.65;
  let p0 = await player(page);
  await finger.press(sx, sy);
  await finger.move(sx, sy - 30);
  await finger.move(sx, sy - 70);
  // The stick has taken the push before any walking is measured.
  await page.waitForFunction(() => (window.__neon!.game.input as unknown as { touch: { stick: { y: number } } }).touch.stick.y > 0.5, null, { timeout: 10_000 });
  // A thumb held perfectly still sends no events: the stick must stay live (it once timed out after 4 s).
  await page.waitForTimeout(4500);
  p0 = await player(page);
  await simFor(page, 1.2);
  await finger.release();
  let p1 = await player(page);
  expect(p1.z - p0.z, 'stick up walks north, even after holding still').toBeLessThan(-2.5);
  expect(Math.abs(p1.x - p0.x)).toBeLessThan(Math.abs(p1.z - p0.z));
  p0 = p1;
  await finger.press(sx, sy);
  await finger.move(sx + 70, sy);
  await simFor(page, 1);
  await finger.release();
  p1 = await player(page);
  expect(p1.x - p0.x, 'stick right walks east').toBeGreaterThan(2);

  // --- A quick tap of FIRE fires once (iOS can deliver a tap's down and up between two frames).
  const fire = page.locator('.nh-btn--fire');
  const ammo = () => page.evaluate(() => window.__neon!.game.world.combat.currentAmmo as number);
  const a0 = await ammo();
  await fire.tap();
  await expect.poll(ammo, { message: 'a tap of FIRE shoots' }).toBeLessThan(a0);
  // Fists: a tap throws a punch (the swing shows even when it hits nobody).
  await page.locator('.nh-btn--weapon').tap();
  await expect.poll(() => page.evaluate(() => window.__neon!.game.world.combat.weaponId)).toBe('fists');
  await page.waitForTimeout(300);
  await fire.tap();
  await expect.poll(() => page.evaluate(() => window.__neon!.game.world.combat.sinceFired < 1)).toBe(true);

  // --- Get into the parked starter car with the context button.
  await page.evaluate(() => {
    const w = window.__neon!.game.world;
    const car = w.vehicles.find((v: { active: boolean; variantId: string; role: string }) => v.active && v.variantId === 'kestrel' && v.role === 'parked');
    w.playerCtl.teleport(car.x, car.z + 2.4);
  });
  await expect(context).toHaveText('ENTER');
  await context.tap();
  await expect.poll(async () => (await player(page)).driving).toBe(true);

  // The car screen is just the stick, EXIT and SHOOT (the pistol comes out by itself).
  await expect(page.locator('.nh-btn--handbrake')).toBeHidden();
  await expect(page.locator('.nh-btn--weapon')).toBeHidden();
  await expect(page.locator('.nh-btn--driveby')).toBeVisible();

  // --- Drive: direction steering, push the stick the way you want to go.
  // Push the way the car faces (parked cars in the city face any direction), so the test drives rather than turns.
  p0 = await player(page);
  const yaw = await page.evaluate(() => window.__neon!.game.world.player.vehicle!.yaw as number);
  await finger.press(sx, sy);
  await finger.move(sx + Math.sin(yaw) * 70, sy + Math.cos(yaw) * 70);
  await simFor(page, 2.5);
  p1 = await player(page);
  await finger.release();
  expect(p1.speed, 'car is moving').toBeGreaterThan(5);
  expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeGreaterThan(8);

  // --- Stop and get out.
  await expect(context).toHaveText('EXIT', { timeout: 10_000 });
  await context.tap();
  await expect.poll(async () => (await player(page)).driving).toBe(false);

  // --- Steal a car out of traffic.
  // Stun its driver and let it brake to a stop before walking up: a stunned car only brakes, so one
  // still rolling (or mid-turn at a junction) can sweep into a player placed beside it and, at avenue
  // speed, flatline them (docs/STATUS.md, the old steal-step flake). The long stun keeps it parked
  // however slowly the steps below run.
  const stolenId = await page.evaluate(() => {
    const w = window.__neon!.game.world;
    const car = w.vehicles.find((v: { active: boolean; role: string; destroyed: boolean }) => v.active && v.role === 'traffic' && !v.destroyed);
    car.ai.mode = 'stunned';
    car.ai.timer = 60;
    return car.id as number;
  });
  const carSpeed = () =>
    page.evaluate((id) => {
      const v = window.__neon!.game.world.vehicles[id];
      return Math.hypot(v.vx, v.vz);
    }, stolenId);
  await expect.poll(carSpeed, { message: 'the stunned car comes to a stop', timeout: 20_000 }).toBeLessThan(0.3);
  await page.evaluate((id) => {
    const w = window.__neon!.game.world;
    const car = w.vehicles[id];
    w.playerCtl.teleport(car.x + Math.cos(car.yaw) * 2.2, car.z - Math.sin(car.yaw) * 2.2);
  }, stolenId);
  await expect(context).toHaveText('STEAL');
  await context.tap();
  await expect.poll(async () => (await player(page)).driving).toBe(true);
  await page.waitForTimeout(300);
  await expect(context).toHaveText('EXIT', { timeout: 10_000 });
  await context.tap();
  await expect.poll(async () => (await player(page)).driving).toBe(false);

  // --- Hot Chrome: answer the payphone.
  await page.evaluate(() => {
    const w = window.__neon!.game.world;
    w.heat.clear();
    const g = window.__neon!.unlockJob('glasshounds_03_hot_chrome')!;
    w.playerCtl.teleport(g.x + 1, g.z + 1);
  });
  await expect(context).toHaveText('ANSWER');
  await context.tap();
  await expect.poll(() => page.evaluate(() => window.__neon!.mission().objective)).toBe('goto_lot');
  await expect(page.locator('.nh-mission__obj')).toHaveText('Get to the marker');

  // Reach the lot, then hack the prototype on the touch panel.
  await page.evaluate(() => {
    const p = window.__neon!.game.world.content.map.markers['glass_lot_2'].pos;
    window.__neon!.game.world.playerCtl.teleport(p[0], p[2]);
  });
  await expect.poll(() => page.evaluate(() => window.__neon!.mission().objective)).toBe('hack_car');
  await page.evaluate(() => {
    const g = window.__neon!.game;
    const car = g.world.vehicles[g.director.runner.view.vehicleId];
    g.world.playerCtl.teleport(car.x, car.z + 2.6);
  });
  await expect(context).toHaveText('HACK');
  await context.tap();
  await expect(page.locator('.nh-hack')).toBeVisible();
  await page.waitForFunction(() => window.__neon!.game.director.hack?.phase === 'input', null, { timeout: 15_000 });
  const sequence: number[] = await page.evaluate(() => window.__neon!.game.director.hack.sequence);
  for (const n of sequence) await page.locator('.nh-hack__node').nth(n).tap();
  await expect.poll(() => page.evaluate(() => window.__neon!.mission().objective)).toBe('deliver');
  await expect(page.locator('.nh-hack')).toBeHidden({ timeout: 5000 });

  // Get in the prototype and bring it to the chop shop.
  await page.evaluate(() => {
    const g = window.__neon!.game;
    const car = g.world.vehicles[g.director.runner.view.vehicleId];
    g.world.playerCtl.teleport(car.x, car.z + 2.6);
  });
  await expect(context).toHaveText('ENTER');
  await context.tap();
  await expect.poll(async () => (await player(page)).variant).toBe('prototype');
  await expect(page.locator('.nh-mission__obj')).toContainText('Deliver the car');
  await expect(page.locator('.nh-mission__timer')).toHaveText(/^[0-3]:[0-5]\d$/);
  await page.evaluate(() => {
    const w = window.__neon!.game.world;
    const p = w.content.map.markers['chopshop_1'].pos;
    w.teleportVehicle(w.player.vehicle, p[0], p[2], Math.PI);
  });
  // The job-done card: title, pay, Continue.
  await expect(page.locator('.nh-done h2')).toHaveText('Hot Chrome', { timeout: 10_000 });
  await expect(page.locator('.nh-done [data-pay]')).toHaveText('+1,500', { timeout: 5000 });
  // The job pays 1,500 cr; street score banked on the way can add a little.
  expect(await page.evaluate(() => window.__neon!.mission().credits)).toBeGreaterThanOrEqual(1500);
  await page.locator('.nh-done [data-act="continue"]').tap();
  await expect(page.locator('.nh-done')).toHaveCount(0);
  await expect(page.locator('.nh-credits__num')).toHaveText(/^1,[5-9]\d\d$/, { timeout: 5000 });

  // The pause menu opens and closes with a tap.
  await page.locator('.nh-menu-btn').first().tap();
  await expect(page.locator('.nh-pause h2')).toHaveText('PAUSED');
  await page.locator('[data-act="resume"]').tap();
  await expect(page.locator('.nh-modal')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('iPhone: touch buttons stay on screen and at least 48 px', async ({ page }) => {
  await page.goto('/?autostart=1&quality=low');
  await page.waitForFunction(() => window.__neon?.ready === true, null, { timeout: 30_000 });
  await page.evaluate(() => {
    const w = window.__neon!.game.world;
    const car = w.vehicles.find((v: { active: boolean; variantId: string }) => v.active && v.variantId === 'kestrel');
    w.playerCtl.teleport(car.x, car.z + 2.4);
  });
  await page.waitForTimeout(300);
  const vw = page.viewportSize()!;
  const boxes = await page.locator('.nh-btn').evaluateAll((els) =>
    els
      .filter((e) => getComputedStyle(e).display !== 'none')
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { label: e.textContent, x: r.x, y: r.y, w: r.width, h: r.height };
      }),
  );
  expect(boxes.length).toBeGreaterThanOrEqual(3);
  for (const b of boxes) {
    expect(Math.min(b.w, b.h), `${b.label} size`).toBeGreaterThanOrEqual(48);
    expect(b.x, `${b.label} on screen`).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(vw.width + 1);
    expect(b.y + b.h).toBeLessThanOrEqual(vw.height + 1);
  }
});

test('iPhone: the minimap opens the full map, a tap sets a waypoint, the menu closes by touch', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?autostart=1&quality=low');
  await page.waitForFunction(() => window.__neon?.ready === true, null, { timeout: 30_000 });
  const paused = () => page.evaluate(() => window.__neon!.game.isPaused);

  // Tap the minimap: the pause menu opens on the Map tab and the game pauses.
  await page.locator('.nh-minimap').tap();
  await expect(page.locator('.nh-pause h2')).toHaveText('PAUSED');
  await expect(page.locator('.nh-tab[data-tab="map"]')).toHaveClass(/is-on/);
  await expect(page.locator('.nh-fullmap__canvas')).toBeVisible();
  expect(await paused()).toBe(true);

  // Tap the map: a waypoint, and a GPS route from the player to it.
  const box = (await page.locator('.nh-fullmap__canvas').boundingBox())!;
  // Off-centre: the map opens centred on the player, and a waypoint on top of the player clears itself.
  await page.touchscreen.tap(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await expect.poll(() => page.evaluate(() => window.__neon!.game.flow.live.waypoint !== null)).toBe(true);
  expect(await page.evaluate(() => window.__neon!.game.flow.live.route.length)).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.nh-fullmap__readout')).toContainText('Waypoint');

  // Zoom with the on-screen button, then look at the other tabs.
  const zoom0 = await page.evaluate(() => (window.__neon!.game.flow as unknown as { fullMap: { view: { zoom: number } } }).fullMap.view.zoom);
  await page.locator('.nh-fullmap [data-map="in"]').tap();
  const zoom1 = await page.evaluate(() => (window.__neon!.game.flow as unknown as { fullMap: { view: { zoom: number } } }).fullMap.view.zoom);
  expect(zoom1).toBeGreaterThan(zoom0);
  await page.locator('.nh-tab[data-tab="jobs"]').tap();
  await expect(page.locator('.nh-crew')).toHaveCount(5);
  await page.locator('.nh-tab[data-tab="stats"]').tap();
  await expect(page.locator('.nh-stat').first()).toBeVisible();

  // Two quick taps (a double tap to iOS) never zoom the page, and the second tap still works.
  await page.locator('.nh-tab[data-tab="jobs"]').tap();
  await page.locator('.nh-tab[data-tab="settings"]').tap();
  await expect(page.locator('.nh-tab[data-tab="settings"]')).toHaveClass(/is-on/);
  await page.locator('.nh-tab[data-tab="settings"]').tap();
  await page.locator('.nh-tab[data-tab="settings"]').tap();
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  await expect(page.locator('.nh-tab[data-tab="settings"]')).toHaveClass(/is-on/);
  // Taps on a button's icon (SVG) still click it when they come quickly.
  await page.locator('.nh-tab[data-tab="map"]').tap();
  const zoomOf = () => page.evaluate(() => (window.__neon!.game.flow as unknown as { fullMap: { view: { zoom: number } } }).fullMap.view.zoom);
  const z0 = await zoomOf();
  await page.locator('.nh-fullmap [data-map="in"] svg').first().tap();
  await page.locator('.nh-fullmap [data-map="in"] svg').first().tap();
  await expect.poll(zoomOf).toBeGreaterThan(z0);

  // Resume by touch: the menu goes and the game runs again.
  await page.locator('[data-act="resume"]').tap();
  await expect(page.locator('.nh-pause')).toHaveCount(0);
  expect(await paused()).toBe(false);
  expect(errors).toEqual([]);
});
