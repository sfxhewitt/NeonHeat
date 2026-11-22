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
    await page.waitForTimeout(ms);
  }
  const result = await page.evaluate(() => {
    const v = window.__neon!.game.world.player.vehicle!;
    return { x: v.x, z: v.z, stats: window.__neon!.stats() };
  });
  expect(Math.hypot(result.x - start.x, result.z - start.z)).toBeGreaterThan(20);
  expect(result.stats.avgFrameMs).toBeLessThan(FRAME_BUDGET_MS);
  expect(errors).toEqual([]);
});

test('on foot: walk, roll and fire without errors', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await page.evaluate(() => window.__neon!.setIntents({ moveX: 1 }));
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__neon!.setIntents({ moveX: -1, dodge: true }));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__neon!.setIntents({ fire: true }));
  await page.waitForTimeout(1200);
  const heat = await page.evaluate(() => window.__neon!.game.world.heat.level);
  expect(heat).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.nh-heat .chev.on').first()).toBeAttached();
  expect(errors).toEqual([]);
});
