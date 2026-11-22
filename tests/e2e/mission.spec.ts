import { expect, test } from '@playwright/test';

/**
 * The headless mission bot plays Hot Chrome inside the real browser build:
 * Rapier WASM, the director wiring, hack panel, HUD and autosave. The sim is
 * fast-forwarded in chunks so CI does not wait minutes of real time.
 */
test('the bot completes Hot Chrome in the browser build and the result is saved', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?autostart=1&bot=1&quality=low');
  await page.waitForFunction(() => window.__neon?.ready === true, null, { timeout: 30_000 });

  const seen = new Set<string>();
  let hackSeen = false;
  for (let i = 0; i < 120; i++) {
    const m = await page.evaluate(() => {
      window.__neon!.fastForward(5);
      return window.__neon!.mission();
    });
    if (m.objective) seen.add(m.objective);
    if (m.hackOpen) hackSeen = true;
    if (m.completed > 0) break;
    // Let a frame render so the HUD and hack panel are exercised too.
    await page.waitForTimeout(16);
  }
  const m = await page.evaluate(() => window.__neon!.mission());
  expect(m.completed).toBe(1);
  expect([...seen]).toEqual(expect.arrayContaining(['goto_lot', 'hack_car', 'deliver']));
  expect(hackSeen || seen.has('deliver')).toBe(true);
  expect(m.credits).toBe(1500);
  // Wait for the autosave to land in IndexedDB, then read it back.
  await page.waitForTimeout(300);
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
  expect(saved).toMatchObject({ version: 1, credits: 1500, completedMissions: ['glasshounds_03_hot_chrome'] });
  await expect(page.locator('.nh-toast')).toContainText('JOB DONE');
  expect(errors).toEqual([]);
});
