import { expect, test, type Page } from '@playwright/test';

/**
 * Smoke playtest: the gate the overnight build loop must pass before anything is merged
 * (docs/overnight/PROMPT.md). One short session on a phone-sized landscape screen with touch:
 * start from the title by tap, walk with the floating stick, get in a car, drive a scripted
 * route through the intent layer, get out and fire.
 *
 * It fails on any console error or uncaught exception, on a blank or frozen canvas, on a lost
 * WebGL context, and on frame time badly over budget. Run it alone with `pnpm playtest`.
 */

/** Average frame time budget in headless software WebGL. Real devices target 16.7 ms. */
const FRAME_BUDGET_MS = Number(process.env.FRAME_BUDGET_MS ?? 50);
/** A hitch or two is normal in software rendering; one frame in twenty over this is not. */
const P95_BUDGET_MS = FRAME_BUDGET_MS * 2.5;
/** No single frame may stall this long while driving: that is a hang, not a hitch. */
const STALL_MS = Math.max(1000, FRAME_BUDGET_MS * 12);

interface Picture {
  /** Distinct colours after quantising each channel to 4 bits. */
  colours: number;
  /** Share of pixels brighter than the near-black base palette. */
  lit: number;
  /** Brightest pixel, 0-255. */
  peak: number;
  contextLost: boolean;
  width: number;
  height: number;
}

/** Sample the game canvas right after the game has drawn a frame (the drawing buffer is cleared after compositing). */
async function picture(page: Page): Promise<Picture> {
  return page.evaluate(
    () =>
      new Promise<Picture>((resolve) => {
        requestAnimationFrame(() => {
          const src = document.getElementById('game') as HTMLCanvasElement;
          const w = 120;
          const h = 56;
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const g = c.getContext('2d', { willReadFrequently: true })!;
          g.drawImage(src, 0, 0, w, h);
          const d = g.getImageData(0, 0, w, h).data;
          const seen = new Set<number>();
          let lit = 0;
          let peak = 0;
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i]!;
            const gr = d[i + 1]!;
            const b = d[i + 2]!;
            seen.add(((r >> 4) << 8) | ((gr >> 4) << 4) | (b >> 4));
            const m = Math.max(r, gr, b);
            if (m > 48) lit++;
            if (m > peak) peak = m;
          }
          const gl = window.__neon!.game.renderer.getContext() as WebGL2RenderingContext;
          resolve({ colours: seen.size, lit: lit / (w * h), peak, contextLost: gl.isContextLost(), width: src.width, height: src.height });
        });
      }),
  );
}

function expectPicture(p: Picture, when: string): void {
  expect(p.contextLost, `WebGL context lost ${when}`).toBe(false);
  expect(p.width * p.height, `canvas has no pixels ${when}`).toBeGreaterThan(0);
  expect(p.colours, `canvas is blank or one flat colour ${when}`).toBeGreaterThanOrEqual(24);
  expect(p.peak, `nothing bright on screen ${when}`).toBeGreaterThan(90);
  expect(p.lit, `almost nothing lit on screen ${when}`).toBeGreaterThan(0.01);
}

async function simFor(page: Page, seconds: number): Promise<void> {
  const t0 = await page.evaluate(() => window.__neon!.game.world.time as number);
  await page.waitForFunction((end) => (window.__neon!.game.world.time as number) >= end, t0 + seconds, { timeout: seconds * 1000 * 12 + 5000, polling: 50 });
}

const where = (page: Page) =>
  page.evaluate(() => {
    const w = window.__neon!.game.world;
    const v = w.player.vehicle;
    return { x: (v ?? w.player).x as number, z: (v ?? w.player).z as number, driving: !!v };
  });

test('smoke playtest: a phone session boots, plays and renders within the frame budget', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`uncaught: ${String(e)}`));
  page.on('crash', () => errors.push('page crashed'));

  // --- Boot: title screen, then start with taps as a player would.
  await page.goto('/?quality=low');
  const start = page.locator('.nh-title__press');
  await expect(start).toBeVisible({ timeout: 30_000 });
  await start.tap();
  await page.locator('.nh-title [data-act="new"]').tap();
  await page.waitForFunction(() => window.__neon?.ready === true, null, { timeout: 30_000 });
  await expect(page.locator('.nh-title')).toHaveCount(0);

  // The canvas fills the phone screen, in landscape.
  const view = page.viewportSize()!;
  const box = (await page.locator('#game').boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(view.width - 1);
  expect(box.height).toBeGreaterThanOrEqual(view.height - 1);
  expect(box.width).toBeGreaterThan(box.height);
  await simFor(page, 0.5);
  expectPicture(await picture(page), 'after boot');

  // --- Walk with the floating stick: one real finger on the left of the screen.
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number, y?: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ x, y: y!, id: 1 }] });
  const sx = view.width * 0.2;
  const sy = view.height * 0.65;
  const p0 = await where(page);
  await touch('touchStart', sx, sy);
  await touch('touchMove', sx + 30, sy);
  await touch('touchMove', sx + 70, sy);
  await simFor(page, 1.2);
  await touch('touchEnd');
  const p1 = await where(page);
  expect(Math.hypot(p1.x - p0.x, p1.z - p0.z), 'the touch stick walks the player').toBeGreaterThan(2);

  // --- Get in the nearest car with the context button.
  await page.evaluate(() => {
    const w = window.__neon!.game.world;
    const car = w.vehicles.find((v: { active: boolean; variantId: string }) => v.active && v.variantId === 'kestrel');
    w.playerCtl.teleport(car.x, car.z + 2.4);
  });
  const context = page.locator('.nh-btn--context');
  await expect(context).toHaveText('ENTER', { timeout: 10_000 });
  await context.tap();
  await expect.poll(async () => (await where(page)).driving, { message: 'the context button gets the player into the car' }).toBe(true);

  // --- Drive: ten seconds of scripted intents (both steering schemes, a handbrake flick, braking).
  const d0 = await where(page);
  const script: [number, Record<string, unknown>][] = [
    [2, { throttle: 1 }],
    [2, { throttle: 1, steer: 0.4 }],
    [1.5, { throttle: 1, steer: -0.6, handbrake: true }],
    [2.5, { scheme: 'direction', moveX: -0.6, moveY: 0.8 }],
    [2, { brake: 1 }],
  ];
  const before = await page.evaluate(() => {
    const g = window.__neon!.game;
    g.frameTimes.splice(0);
    return { frames: g.stats.frames as number, time: g.world.time as number };
  });
  for (const [seconds, intents] of script) {
    await page.evaluate((i) => window.__neon!.setIntents(i), intents);
    await simFor(page, seconds);
  }
  const drive = await page.evaluate(() => {
    const g = window.__neon!.game;
    const ft = [...(g.frameTimes as number[])].sort((a, b) => a - b);
    const s = window.__neon!.stats();
    return {
      tier: g.tier as string,
      frames: g.stats.frames as number,
      time: g.world.time as number,
      avg: s.avgFrameMs as number,
      p95: ft[Math.min(ft.length - 1, Math.floor(ft.length * 0.95))] ?? 0,
      worst: ft[ft.length - 1] ?? 0,
      samples: ft.length,
      drawCalls: s.drawCalls as number,
    };
  });
  await page.evaluate(() => window.__neon!.setIntents(null));
  const d1 = await where(page);
  const driven = Math.hypot(d1.x - d0.x, d1.z - d0.z);
  console.info(
    `playtest: ${view.width}x${view.height} ${drive.tier} tier, drove ${driven.toFixed(0)} m, frame avg ${drive.avg.toFixed(1)} ms, ` +
      `p95 ${drive.p95.toFixed(1)} ms, worst ${drive.worst.toFixed(0)} ms over ${drive.samples} frames (budget ${FRAME_BUDGET_MS} ms), ${drive.drawCalls} draw calls`,
  );
  expect(driven, 'the scripted drive moves the car').toBeGreaterThan(20);
  expect(drive.frames - before.frames, 'the render loop kept drawing frames').toBeGreaterThan(60);
  expect(drive.time - before.time, 'the simulation clock kept running').toBeGreaterThan(9.5);
  expect(drive.avg, 'average frame time over budget').toBeLessThan(FRAME_BUDGET_MS);
  expect(drive.p95, '95th percentile frame time badly over budget').toBeLessThan(P95_BUDGET_MS);
  expect(drive.worst, 'a frame stalled').toBeLessThan(STALL_MS);
  expect(drive.drawCalls, 'draw-call budget (CLAUDE.md: under 100)').toBeLessThan(100);
  expect(drive.drawCalls).toBeGreaterThan(5);
  expectPicture(await picture(page), 'after driving');

  // --- Out of the car, a roll and a few shots.
  await page.evaluate(() => {
    const w = window.__neon!.game.world;
    const v = w.player.vehicle;
    if (v) {
      v.vx = 0;
      v.vz = 0;
    }
  });
  await expect(context).toHaveText('EXIT', { timeout: 10_000 });
  await context.tap();
  await expect.poll(async () => (await where(page)).driving, { message: 'the context button gets the player out' }).toBe(false);
  await page.evaluate(() => window.__neon!.setIntents({ moveX: -1, dodge: true }));
  await simFor(page, 0.5);
  await page.evaluate(() => window.__neon!.setIntents({ fire: true }));
  await simFor(page, 1);
  await page.evaluate(() => window.__neon!.setIntents(null));

  // --- Still alive and drawing at the end: the picture changes from frame to frame and nothing was logged.
  const t1 = await page.evaluate(() => window.__neon!.game.stats.frames as number);
  await simFor(page, 0.5);
  const t2 = await page.evaluate(() => window.__neon!.game.stats.frames as number);
  expect(t2, 'the render loop is still running at the end').toBeGreaterThan(t1);
  expectPicture(await picture(page), 'at the end');
  await expect(page.locator('.nh-hud, .nh-vitals').first()).toBeAttached();
  expect(errors, 'console errors or uncaught exceptions during the playtest').toEqual([]);
});
