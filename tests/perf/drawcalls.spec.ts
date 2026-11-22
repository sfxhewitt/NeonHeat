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
