import { expect, test, type Page } from '@playwright/test';

// CLAUDE.md, game rules that must hold: pause when the tab is backgrounded, and autosave every
// content/data/save.json `freeRoamAutosaveSec` (120 s) of free roam.

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

/** Pretend the tab went to the background (or came back), as the browser reports it. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** The save the game wrote to IndexedDB (database `neonheat`, store `saves`, slot `slot1`), if any. */
function storedSavedAt(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      new Promise<string | null>((resolve, reject) => {
        const req = indexedDB.open('neonheat', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('saves');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const get = req.result.transaction('saves', 'readonly').objectStore('saves').get('slot1');
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            req.result.close();
            resolve((get.result as { savedAt?: string } | undefined)?.savedAt ?? null);
          };
        };
      }),
  );
}

test('pauses while the tab is hidden and resumes when it is visible again', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  const time = () => page.evaluate(() => window.__neon!.game.world.time as number);
  // Running to start with.
  const t0 = await time();
  await expect.poll(time).toBeGreaterThan(t0);

  await setHidden(page, true);
  expect(await page.evaluate(() => window.__neon!.game.isPaused)).toBe(true);
  const hiddenAt = await time();
  await page.waitForTimeout(1500);
  expect(await time(), 'world time stands still while hidden').toBe(hiddenAt);

  await setHidden(page, false);
  expect(await page.evaluate(() => window.__neon!.game.isPaused)).toBe(false);
  await expect.poll(time, { message: 'world time runs again once visible' }).toBeGreaterThan(hiddenAt + 0.5);
  expect(errors).toEqual([]);
});

test('autosaves to IndexedDB after two minutes of free roam', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await boot(page);
  const interval = await page.evaluate(() => window.__neon!.game.content.save.freeRoamAutosaveSec);
  expect(interval).toBe(120);
  expect(await page.evaluate(() => window.__neon!.game.director.active)).toBe(false);
  // Hold the render loop still so only the fast-forwarded steps count.
  await setHidden(page, true);
  const before = await storedSavedAt(page);

  // Half the interval: no free-roam save yet.
  await page.evaluate((s) => window.__neon!.fastForward(s), interval / 2);
  await page.waitForTimeout(500);
  expect(await storedSavedAt(page), 'no autosave before the interval').toBe(before);

  // Past the interval: a save lands in IndexedDB.
  await page.evaluate((s) => window.__neon!.fastForward(s), interval / 2 + 5);
  await expect.poll(() => storedSavedAt(page), { message: 'free-roam autosave written', timeout: 10_000 }).not.toBe(before);
  const saved = await storedSavedAt(page);
  expect(saved).not.toBeNull();
  expect(Date.parse(saved!)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
