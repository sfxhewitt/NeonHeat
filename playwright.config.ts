import { defineConfig, devices } from '@playwright/test';

const port = 4173;

/** iPhone 17 Pro Max as a home-screen app: 440 × 956 CSS pixels at DPR 3, touch only. */
const proMax = { ...devices['iPhone 13'], viewport: { width: 440, height: 956 }, screen: { width: 440, height: 956 }, deviceScaleFactor: 3 };
const proMaxLandscape = { ...devices['iPhone 13 landscape'], viewport: { width: 956, height: 440 }, screen: { width: 956, height: 440 }, deviceScaleFactor: 3 };

/** Chromium flags so WebGL 2 works in headless CI via SwiftShader. */
export const chromiumArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'off',
    launchOptions: { args: chromiumArgs },
  },
  projects: [
    // Mobile first: an iPhone held in portrait (rotation lock on, or a home-screen app that will not rotate),
    // then held in landscape. Touch input only. Emulated in Chromium: WebKit is not installed here.
    {
      name: 'iphone-portrait',
      testMatch: /phone\.spec\.ts/,
      use: { ...proMax, defaultBrowserType: 'chromium' },
    },
    {
      name: 'iphone-landscape',
      testMatch: /phone\.spec\.ts/,
      use: { ...proMaxLandscape, defaultBrowserType: 'chromium' },
    },
    {
      name: 'desktop',
      testIgnore: /phone\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 960, height: 540 } },
    },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    port,
    reuseExistingServer: false, // always test the current build; a stale preview server hid fixes once
    timeout: 180_000,
  },
});
