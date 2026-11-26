// The overnight gate: one command that runs everything a change must pass before it is merged.
// `pnpm overnight:check` runs every step in order and stops at the first failure.
// It mirrors .github/workflows/ci.yml; tests/unit/overnight.test.ts fails if the two drift apart.
// There is deliberately no flag to skip a step or loosen a budget. See docs/overnight/PROMPT.md.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

/** Every step, in order. Cheap checks first so a broken change fails fast. */
export const STEPS = [
  { name: 'backlog', cmd: 'node tools/overnight/backlog.mjs validate' },
  { name: 'lint', cmd: 'pnpm lint' },
  { name: 'typecheck', cmd: 'pnpm typecheck' },
  { name: 'unit', cmd: 'pnpm test' },
  { name: 'mission-lint', cmd: 'pnpm mission-lint' },
  { name: 'build', cmd: 'pnpm build' },
  { name: 'size', cmd: 'pnpm size' },
  { name: 'playtest', cmd: 'pnpm playtest' },
  { name: 'e2e', cmd: 'pnpm exec playwright test -c playwright.config.ts --project=iphone-portrait --project=iphone-landscape --project=desktop' },
  { name: 'perf', cmd: 'pnpm perf' },
];

/** Environment variables that loosen a budget. CI sets its own; a local gate run must not. */
export const LOOSENERS = ['FRAME_BUDGET_MS', 'SIZE_BUDGET_KB'];

function main() {
  const set = LOOSENERS.filter((k) => process.env[k] !== undefined);
  if (set.length) {
    console.error(`overnight:check refuses to run with ${set.join(', ')} set: the gate uses the repository's own budgets.`);
    process.exit(2);
  }
  // SOAK_MINUTES is pinned so a stray value cannot shorten (or stretch) the soak. CI is unset so
  // Playwright does not retry: a test that only passes on a retry is a failure here.
  const env = { ...process.env, SOAK_MINUTES: '1' };
  delete env.CI;
  const results = [];
  const lines = [];
  let failed = null;
  const t0 = Date.now();
  for (const step of STEPS) {
    if (failed) {
      results.push({ name: step.name, status: 'not run', seconds: 0 });
      continue;
    }
    console.info(`\n=== overnight:check · ${step.name} · ${step.cmd}`);
    const s0 = Date.now();
    const r = spawnSync(step.cmd, { shell: true, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    // Vite prints Rollup's notes about comments in dependencies on every build; they are noise here.
    process.stdout.write(out.split('\n').filter((l) => !l.startsWith('[WebServer]')).join('\n'));
    const seconds = Math.round((Date.now() - s0) / 100) / 10;
    const ok = r.status === 0;
    results.push({ name: step.name, status: ok ? 'pass' : 'FAIL', seconds });
    // Headline numbers worth copying into docs/overnight/LOG.md.
    for (const l of out.split('\n')) {
      if (/^\s*(playtest:|smoke drive:|bundle:|draw calls max|soak )/.test(l) || /^\s*Tests\s+\d+/.test(l) || /^\s*\d+ (passed|failed|flaky)/.test(l)) lines.push(`${step.name}: ${l.trim()}`);
    }
    if (!ok) failed = step.name;
  }
  const total = Math.round((Date.now() - t0) / 100) / 10;
  console.info('\n=== overnight:check summary');
  for (const r of results) console.info(`${r.status.padEnd(8)} ${r.name.padEnd(13)} ${r.seconds ? `${r.seconds} s` : ''}`);
  for (const l of lines) console.info(`  ${l}`);
  console.info(failed ? `GATE RED: ${failed} failed (${total} s)` : `GATE GREEN: ${results.length} of ${results.length} steps passed (${total} s)`);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/overnight-check.json', `${JSON.stringify({ green: !failed, failed, totalSeconds: total, results, lines }, null, 2)}\n`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
