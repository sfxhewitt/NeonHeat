import { defineConfig, devices } from '@playwright/test';
import { chromiumArgs } from './playwright.config';

const port = Number(process.env.E2E_PORT ?? 4173);
const soakMinutes = Number(process.env.SOAK_MINUTES ?? '1');

export default defineConfig({
  testDir: 'tests/perf',
  timeout: (soakMinutes * 60 + 180) * 1000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'off',
    launchOptions: { args: [...chromiumArgs, '--enable-precise-memory-info', '--js-flags=--expose-gc'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 960, height: 540 } } }],
  webServer: {
    command: `pnpm build && pnpm preview --port ${port} --strictPort`,
    port,
    reuseExistingServer: false, // always test the current build; a stale preview server hid fixes once
    timeout: 180_000,
  },
});
