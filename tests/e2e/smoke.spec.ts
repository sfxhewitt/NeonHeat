import { expect, test } from '@playwright/test';

test('boots to a full-screen canvas without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  const canvas = page.locator('#game');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width).toBe(960);
  expect(box?.height).toBe(540);
  await page.waitForTimeout(1000);
  expect(errors).toEqual([]);
});
