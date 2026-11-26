# NEON HEAT

Mobile-first, top-down cyberpunk open-world crime game. Low-poly 3D, neon on dark, pitched top-down camera. Web first, later wrapped with Capacitor.

Read [`CLAUDE.md`](CLAUDE.md) for the stack, layout and rules, and [`docs/STATUS.md`](docs/STATUS.md) for where the project is.

## Getting started

```sh
pnpm install
pnpm dev          # play at http://localhost:5173 (debug panel: backtick key)
pnpm build        # static site in apps/game/dist
```

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e
pnpm perf         # draw-call budget + 1-minute soak
pnpm soak         # full 20-minute soak
pnpm mission-lint # validate content/missions
```

## Overnight build loop

An unattended nightly session works through [`docs/overnight/backlog.json`](docs/overnight/backlog.json) under the rules in [`docs/overnight/PROMPT.md`](docs/overnight/PROMPT.md). See [`docs/overnight/README.md`](docs/overnight/README.md).

```sh
pnpm overnight:check   # the full gate in one command
pnpm playtest          # the phone smoke playtest alone
```
