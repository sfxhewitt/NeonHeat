import { expect, test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

/**
 * Soak test: the mission bot plays Hot Chrome on a loop in real time, with
 * bursts of random "chaos" driving injected through the intent layer. We sample
 * frame time and JS heap (after a forced GC) in windows and assert neither creeps.
 * Duration comes from SOAK_MINUTES (20 for the Phase 0 acceptance run, 1 in CI).
 */
const MINUTES = Number(process.env.SOAK_MINUTES ?? '1');
const WINDOW_MS = Math.min(60_000, (MINUTES * 60_000) / 4);

interface Sample {
  t: number;
  avgFrameMs: number;
  p95FrameMs: number;
  heapMb: number;
  completed: number;
  vehicles: number;
  wrecks: number;
  maxWrecks: number;
  peds: number;
}

test(`soak: ${MINUTES} minute(s) of bot play shows no frame-time or memory creep`, async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?autostart=1&bot=1&quality=mid&seed=7');
  await page.waitForFunction(() => window.__neon?.ready === true, null, { timeout: 60_000 });

  const samples: Sample[] = [];
  const start = Date.now();
  const end = start + MINUTES * 60_000;
  let nextWindow = start + WINDOW_MS;
  let chaosUntil = 0;
  let nextChaos = start + 20_000;
  await page.evaluate(() => window.__neon!.game.frameTimes.splice(0));
  while (Date.now() < end) {
    await page.waitForTimeout(1000);
    const now = Date.now();
    if (now >= nextChaos && chaosUntil === 0) {
      // Chaos: grab the controls for a few seconds with random input, then hand back to the bot.
      chaosUntil = now + 3000 + Math.random() * 3000;
      await page.evaluate(
        (i) => window.__neon!.setIntents(i),
        { throttle: Math.random(), steer: Math.random() * 2 - 1, handbrake: Math.random() < 0.3, fire: Math.random() < 0.5, moveX: Math.random() * 2 - 1, moveY: Math.random() * 2 - 1 },
      );
    } else if (chaosUntil !== 0 && now >= chaosUntil) {
      chaosUntil = 0;
      nextChaos = now + 25_000 + Math.random() * 20_000;
      await page.evaluate(() => window.__neon!.setIntents(null));
    }
    if (now >= nextWindow || now >= end) {
      nextWindow += WINDOW_MS;
      const s = await page.evaluate(() => {
        const g = window.__neon!.game;
        const ft = g.frameTimes.slice().sort((a: number, b: number) => a - b);
        const avg = ft.reduce((a: number, b: number) => a + b, 0) / Math.max(1, ft.length);
        g.frameTimes.splice(0);
        (globalThis as { gc?: () => void }).gc?.();
        const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        const w = g.world;
        return {
          avgFrameMs: avg,
          p95FrameMs: ft[Math.floor(ft.length * 0.95)] ?? 0,
          heapMb: mem ? mem.usedJSHeapSize / 1048576 : 0,
          completed: g.director.completed.length,
          vehicles: w.vehicles.filter((v: { active: boolean }) => v.active).length,
          wrecks: w.vehicles.filter((v: { active: boolean; destroyed: boolean }) => v.active && v.destroyed).length,
          maxWrecks: w.content.traffic.maxWrecks,
          peds: w.peds.activeCount(),
        };
      });
      samples.push({ t: Math.round((now - start) / 1000), ...s });
      console.info(
        `soak t=${samples.at(-1)!.t}s frame avg ${s.avgFrameMs.toFixed(1)} ms p95 ${s.p95FrameMs.toFixed(1)} ms heap ${s.heapMb.toFixed(1)} MB jobs ${s.completed} cars ${s.vehicles} wrecks ${s.wrecks} peds ${s.peds}`,
      );
    }
  }
  await page.evaluate(() => window.__neon!.setIntents(null));
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/soak.json', JSON.stringify({ minutes: MINUTES, samples }, null, 2));

  expect(samples.length).toBeGreaterThanOrEqual(2);
  // Ignore the first window (shader compiles, JIT warm-up): compare the second against the last.
  const base = samples[Math.min(1, samples.length - 1)]!;
  const last = samples.at(-1)!;
  expect(last.avgFrameMs).toBeLessThan(base.avgFrameMs * 1.3 + 3);
  if (base.heapMb > 0) expect(last.heapMb).toBeLessThan(base.heapMb * 1.25 + 8);
  // Pools are bounded: entity counts never exceed the pool sizes.
  for (const s of samples) {
    expect(s.vehicles).toBeLessThanOrEqual(40);
    // The player's own wreck and mission cars are exempt from the cap, hence the +2.
    expect(s.wrecks).toBeLessThanOrEqual(s.maxWrecks + 2);
  }
  if (MINUTES >= 10) expect(last.completed).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});
