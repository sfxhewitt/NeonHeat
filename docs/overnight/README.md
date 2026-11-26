# Overnight build loop

Each night an unattended Claude session takes the next items from a backlog, builds them, playtests them,
has them independently reviewed and merges only what is green.

| File | What it is |
| --- | --- |
| [`PROMPT.md`](PROMPT.md) | The complete instruction for the nightly session. Start a fresh session with: "Read docs/overnight/PROMPT.md in sfxhewitt/neonheat and do exactly what it says." |
| [`REVIEWER.md`](REVIEWER.md) | Instructions for the independent reviewer subagent. |
| [`backlog.json`](backlog.json) | The queue. File order is priority. Edit by hand: add items, reorder, set a blocked item back to `todo`. |
| [`LOG.md`](LOG.md) | What each night shipped, failed and skipped. |

## Commands

```sh
pnpm overnight:check            # the gate: backlog, lint, typecheck, unit, mission-lint, build, size, playtest, e2e, perf
pnpm playtest                   # the smoke playtest alone (about 30 s)
pnpm overnight:guard            # scope guard for an item branch against origin/main
pnpm overnight:backlog list     # also: validate | next | done <id> <pr-url> [attempts] | block <id> "<why>" [attempts]
node tools/overnight/wait-ci.mjs <sha> [check ...]   # wait for GitHub Actions on a commit; exit 0 only when green
```

## The gate

`pnpm overnight:check` runs everything CI runs, in one command, with no way to skip a step. A unit test
(`tests/unit/overnight.test.ts`) fails if CI gains a check the gate lacks, if a GitHub Action is not pinned to
a full commit SHA, or if a workflow installs dependencies without the frozen lockfile.

The smoke playtest (`tests/e2e/playtest.spec.ts`) is a short touch session on a 956x440 screen. It fails on
console errors, a blank or frozen canvas, a lost WebGL context or frame time badly over budget. It runs in CI
as part of `pnpm e2e`. Headless Chromium renders WebGL in software: the numbers catch regressions, they do
not measure a phone.

## Adding a backlog item

Copy an existing item. Keep it small enough for one night (`S` about an hour, `M` about half a night) and
give it acceptance criteria a test can check, plus the `verify` commands that check them.
