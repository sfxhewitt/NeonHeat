import { expect, test } from '@playwright/test';

test('populated block stays under 100 draw calls on the high tier', async ({ page }) => {
  await page.goto('/?autostart=1&quality=high');
  await page.waitForFunction(() => window.__neon?.ready === true, null, { timeout: 60_000 });
  // Populate everything: HEAT 3 (patrol cars + drone), traffic, peds, rain, bloom; then drive into it.
  await page.evaluate(() => {
    const g = window.__neon!.game;
    const w = g.world;
    const car = w.vehicles.find((v: { active: boolean; variantId: string }) => v.active && v.variantId === 'kestrel');
    w.playerCtl.enter(car);
    w.heat.setLevel(3, w.player.x, w.player.z);
    window.__neon!.setIntents({ throttle: 1, steer: 0.15 });
  });
  let maxCalls = 0;
  let maxTris = 0;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500);
    const s = await page.evaluate(() => window.__neon!.stats());
    maxCalls = Math.max(maxCalls, s.drawCalls);
    maxTris = Math.max(maxTris, s.triangles);
  }
  const counts = await page.evaluate(() => {
    const w = window.__neon!.game.world;
    return {
      vehicles: w.vehicles.filter((v: { active: boolean }) => v.active).length,
      peds: w.peds.activeCount(),
      police: w.police.countRole('police'),
      drone: w.police.drone.active,
    };
  });
  console.info(`draw calls max ${maxCalls}, triangles max ${maxTris}`, counts);
  expect(counts.vehicles).toBeGreaterThanOrEqual(10);
  expect(counts.peds).toBeGreaterThanOrEqual(10);
  expect(maxCalls).toBeGreaterThan(5);
  expect(maxCalls).toBeLessThan(100);
});

test.describe('phone screen, mid tier', () => {
  // The iPhone 17 Pro Max held in landscape, as in the e2e phone projects (CSS pixels).
  test.use({ viewport: { width: 956, height: 440 } });

  /**
   * Most triangles drawn in one frame. Measured on 27 Nov 2026: 195,928 to 197,560 over three runs
   * (max 197,560). The budget is about 1.27x that, inside the 1.5x the backlog allows.
   * Note: CLAUDE.md's phone budget says about 100k visible vertices; this scene already draws about
   * twice that many triangles, so this guards against regressions, not against the CLAUDE.md target.
   */
  const TRIANGLE_BUDGET = 250_000;

  test('populated block stays under 100 draw calls and the triangle budget', async ({ page }) => {
    await page.goto('/?autostart=1&quality=mid');
    await page.waitForFunction(() => window.__neon?.ready === true, null, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__neon!.game.tier)).toBe('mid');
    // The same scene as the high-tier test: HEAT 3 (patrol cars + drone), traffic, peds, rain; then drive into it.
    await page.evaluate(() => {
      const w = window.__neon!.game.world;
      const car = w.vehicles.find((v: { active: boolean; variantId: string }) => v.active && v.variantId === 'kestrel');
      w.playerCtl.enter(car);
      w.heat.setLevel(3, w.player.x, w.player.z);
      window.__neon!.setIntents({ throttle: 1, steer: 0.15 });
    });
    let maxCalls = 0;
    let maxTris = 0;
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(500);
      const s = await page.evaluate(() => window.__neon!.stats());
      maxCalls = Math.max(maxCalls, s.drawCalls);
      maxTris = Math.max(maxTris, s.triangles);
    }
    const counts = await page.evaluate(() => {
      const w = window.__neon!.game.world;
      return {
        vehicles: w.vehicles.filter((v: { active: boolean }) => v.active).length,
        peds: w.peds.activeCount(),
        police: w.police.countRole('police'),
        drone: w.police.drone.active,
      };
    });
    console.info(`mid tier 956x440: draw calls max ${maxCalls}, triangles max ${maxTris} (budget ${TRIANGLE_BUDGET})`, counts);
    expect(counts.vehicles).toBeGreaterThanOrEqual(10);
    expect(counts.peds).toBeGreaterThanOrEqual(10);
    expect(maxCalls).toBeGreaterThan(5);
    expect(maxCalls).toBeLessThan(100);
    expect(maxTris).toBeGreaterThan(0);
    expect(maxTris).toBeLessThan(TRIANGLE_BUDGET);
  });
});
