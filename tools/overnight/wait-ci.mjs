// Waits for GitHub Actions on one commit and exits 0 only when every check run finished green.
//
//   node tools/overnight/wait-ci.mjs <sha> [check-name ...]
//
// With check names (for example `check`, the CI job), those must all be present and green.
// Without names, at least one check run must exist and all must be green.
// Exit codes: 0 green, 1 red, 3 timed out or no checks appeared. Never treat 3 as green.
import { execFileSync } from 'node:child_process';

const [sha, ...want] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
  console.error('Usage: wait-ci.mjs <full commit sha> [check-name ...]');
  process.exit(2);
}
const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
const repo = /github\.com[:/]+([^/]+\/[^/.\s]+)/.exec(remote)?.[1];
if (!repo) {
  console.error(`Cannot read owner/repo from ${remote}`);
  process.exit(2);
}
const TIMEOUT_MIN = Number(process.env.CI_WAIT_MINUTES ?? 45);
const GOOD = new Set(['success', 'skipped', 'neutral']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + TIMEOUT_MIN * 60_000;
let last = '';

for (;;) {
  let runs = [];
  try {
    const out = execFileSync('gh', ['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`], { encoding: 'utf8' });
    // A re-run leaves the older run in the list: keep the newest run of each name.
    const byName = new Map();
    for (const r of JSON.parse(out).check_runs) {
      const prev = byName.get(r.name);
      if (!prev || r.id > prev.id) byName.set(r.name, r);
    }
    runs = [...byName.values()];
  } catch (err) {
    console.error(`check-runs request failed, will retry: ${String(err.message ?? err).split('\n')[0]}`);
  }
  const line = runs.map((r) => `${r.name}=${r.status === 'completed' ? r.conclusion : r.status}`).join(' ') || 'no checks yet';
  if (line !== last) console.info(`${new Date().toISOString().slice(11, 19)} ${line}`);
  last = line;
  const missing = want.filter((n) => !runs.some((r) => r.name === n));
  const pending = runs.filter((r) => r.status !== 'completed');
  if (runs.length > 0 && missing.length === 0 && pending.length === 0) {
    const red = runs.filter((r) => !GOOD.has(r.conclusion));
    if (red.length) {
      for (const r of red) console.error(`RED ${r.name}: ${r.conclusion} ${r.html_url}`);
      process.exit(1);
    }
    console.info(`CI GREEN on ${sha.slice(0, 7)}: ${runs.map((r) => r.name).join(', ')}`);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.error(`CI did not finish within ${TIMEOUT_MIN} minutes (${line}). This is not green.`);
    process.exit(3);
  }
  await sleep(30_000);
}
