import { expect, test, type Page } from '@playwright/test';

/** Average frame time budget in headless CI (software WebGL). Real devices target 16.7 ms. */
const FRAME_BUDGET_MS = Number(process.env.FRAME_BUDGET_MS ?? 50);

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/**
 * Wait for this much game time. Slow software rendering (hosted CI) caps the sim's catch-up steps,
 * so wall-clock waits would test less driving than the script describes.
 */
async function simFor(page: Page, seconds: number): Promise<void> {
  const t0 = await page.evaluate(() => window.__neon!.game.world.time);
  await page.waitForFunction((end) => window.__neon!.game.world.time >= end, t0 + seconds, { timeout: seconds * 1000 * 12 + 5000, polling: 50 });
}

async function boot(page: Page): Promise<void> {
  await page.goto('/?autostart=1');
  await page.waitForFunction(() => window.__neon?.ready === true, null, { timeout: 30_000 });
}

test('boots to a full-screen canvas', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  const box = await page.locator('#game').boundingBox();
  expect(box?.width).toBe(960);
  expect(box?.height).toBe(540);
  expect(errors).toEqual([]);
});

test('drives for 10 seconds via injected intents within the frame budget', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  // The player starts on foot beside a car: walk up to it and get in.
  await page.evaluate(() => {
    const w = window.__neon!.game.world;
    const car = w.vehicles.find((v: { active: boolean; variantId: string }) => v.active && v.variantId === 'kestrel');
    w.playerCtl.teleport(car.x, car.z + 2.4);
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__neon!.setIntents({ interact: true }));
  await page.waitForFunction(() => window.__neon!.game.world.player.vehicle !== null, null, { timeout: 5000 });
  const start = await page.evaluate(() => {
    const v = window.__neon!.game.world.player.vehicle!;
    return { x: v.x, z: v.z };
  });
  // Ten seconds of driving: throttle, weave, a handbrake flick, then direction steering.
  const script: [number, Record<string, unknown>][] = [
    [2000, { throttle: 1 }],
    [2000, { throttle: 1, steer: 0.4 }],
    [1500, { throttle: 1, steer: -0.6, handbrake: true }],
    [2500, { scheme: 'direction', moveX: -0.6, moveY: 0.8 }],
    [2000, { brake: 1 }],
  ];
  await page.evaluate(() => window.__neon!.game.frameTimes.splice(0));
  for (const [ms, intents] of script) {
    await page.evaluate((i) => window.__neon!.setIntents(i), intents);
    await simFor(page, ms / 1000);
  }
  const result = await page.evaluate(() => {
    const v = window.__neon!.game.world.player.vehicle!;
    return { x: v.x, z: v.z, tier: window.__neon!.game.tier, stats: window.__neon!.stats() };
  });
  console.info(`smoke drive: ${result.tier} tier, avg frame ${result.stats.avgFrameMs.toFixed(1)} ms, ${result.stats.drawCalls} draw calls`);
  expect(Math.hypot(result.x - start.x, result.z - start.z)).toBeGreaterThan(20);
  expect(result.stats.avgFrameMs).toBeLessThan(FRAME_BUDGET_MS);
  expect(errors).toEqual([]);
});

test('on foot: walk, roll and fire without errors', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await page.evaluate(() => window.__neon!.setIntents({ moveX: 1 }));
  await simFor(page, 0.8);
  await page.evaluate(() => window.__neon!.setIntents({ moveX: -1, dodge: true }));
  await simFor(page, 0.5);
  await page.evaluate(() => window.__neon!.setIntents({ fire: true }));
  await simFor(page, 1.2);
  // A few unwitnessed shots register, but do not bring the police down on you.
  const heat = await page.evaluate(() => ({ level: window.__neon!.game.world.heat.level, points: window.__neon!.game.world.heat.points }));
  expect(heat.points).toBeGreaterThan(0);
  expect(heat.level).toBeLessThanOrEqual(1);
  await expect(page.locator('.nh-vitals .nh-bar--body')).toBeAttached();
  await expect(page.locator('.nh-weapon__name')).toHaveText(/\S/);
  // Hidden overlays must really be hidden (flex boxes ignore [hidden] without a rule).
  await expect(page.locator('.nh-fate')).toBeHidden();
  await expect(page.locator('.nh-arrest')).toBeHidden();
  expect(errors).toEqual([]);
});

test('title screen starts the game on tap', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?quality=low');
  await expect(page.getByRole('heading', { name: /NEON/ })).toBeVisible();
  await page.getByRole('button', { name: 'TAP TO START' }).click();
  await page.getByRole('menuitem', { name: /New game/ }).click();
  await page.waitForFunction(() => window.__neon?.ready === true, null, { timeout: 30_000 });
  const tier = await page.evaluate(() => window.__neon!.game.tier);
  expect(tier).toBe('low');
  expect(errors).toEqual([]);
});

test('sound unlocks on the first tap and plays every cue without errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?quality=low');
  await page.getByRole('button', { name: 'TAP TO START' }).click();
  await page.getByRole('menuitem', { name: /New game/ }).click();
  await page.waitForFunction(() => window.__neon?.ready === true, null, { timeout: 30_000 });
  await page.waitForFunction(() => window.__neon!.game.sound.audio.engine.pending === 0, null, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__neon!.game.sound.audio.engine.ctx?.state)).toBe('running');
  await page.evaluate(() => {
    const a = window.__neon!.game.sound.audio;
    const p = window.__neon!.game.world.player;
    for (const type of ['impact', 'vehicleDestroyed', 'shot', 'pedHit', 'kerb', 'propBroken', 'playerHurt', 'dodge', 'pickup', 'reload', 'someFutureEvent'])
      a.onEvent({ type, x: p.x + 2, z: p.z, strength: 15, other: 'static', kind: 'vending', hit: 'static', weapon: 'shotgun', hx: p.x, hz: p.z } as never);
    a.ui('cash');
    a.sting('missionComplete');
  });
  await page.keyboard.press('Escape');
  await page.locator('[data-tab="settings"]').click();
  await expect(page.locator('input[data-vol="musicVolume"]')).toBeVisible();
  await expect(page.locator('[data-k="radioStation"] button')).toHaveCount(5);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
