import { expect, test } from '@playwright/test';

/**
 * Side activities in the browser build: the activity key puts a cab on duty
 * (panel up, fare waiting), and a data shard picked up shows the counter and
 * lands in the autosave.
 */
test('taxi duty from the activity key, and a data shard saved', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?autostart=1&quality=low');
  await page.waitForFunction(() => window.__neon?.ready === true, null, { timeout: 30_000 });

  // Into a cab: the activity button offers duty, and the key takes it.
  const label = await page.evaluate(() => {
    const w = window.__neon!.game.world;
    const variant = Object.entries(w.content.vehicles.variants).find(([, p]) => (p as { class?: string }).class === 'taxi')![0];
    const v = w.spawnVehicle(variant, w.player.x + 4, w.player.z, 0, 'parked')!;
    w.playerCtl.enter(v);
    window.__neon!.fastForward(0.2);
    return w.activities.prompt?.label ?? null;
  });
  expect(label).toBe('TAXI DUTY');
  await expect(page.locator('.nh-btn--activity')).toHaveText('TAXI DUTY');
  await page.keyboard.press('KeyT');
  await expect(page.locator('.nh-act')).toBeVisible();
  await expect(page.locator('.nh-act__phase')).toHaveText('PICK UP');
  expect(await page.evaluate(() => window.__neon!.game.world.activities.fares.shift?.phase)).toBe('seek');

  // A shard underfoot.
  const found = await page.evaluate(() => {
    const w = window.__neon!.game.world;
    w.playerCtl.exit();
    const s = w.activities.sites.shards[0]!;
    w.playerCtl.teleport(s.x, s.z);
    window.__neon!.fastForward(0.2);
    return w.activities.shards.count;
  });
  expect(found).toBe(1);
  await expect(page.locator('.nh-shardpop')).toContainText('1/50');
  await page.waitForTimeout(400);
  const saved = await page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const req = indexedDB.open('neonheat', 1);
        req.onsuccess = () => {
          const get = req.result.transaction('saves', 'readonly').objectStore('saves').get('slot1');
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  expect((saved as { version: number; activities: { shards: string[] } }).version).toBe(3);
  expect((saved as { activities: { shards: string[] } }).activities.shards).toHaveLength(1);
  expect(errors).toEqual([]);
});
