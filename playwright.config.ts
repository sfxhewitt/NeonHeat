import { defineConfig, devices } from '@playwright/test';

const port = 4173;

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
    viewport: { width: 960, height: 540 },
    launchOptions: { args: chromiumArgs },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 960, height: 540 } } }],
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
