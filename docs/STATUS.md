# Status

Phase 0: feel prototype. Question being answered: is driving, crashing and escaping the police fun on a phone?

## Done

- **M1 Skeleton**: pnpm workspace, Vite app with full-screen landscape canvas (resize + DPR scaling), fixed 60 Hz sim loop with render interpolation and a seeded RNG (`packages/sim`), ESLint (with rules enforcing a DOM/Three-free sim), typecheck, Vitest, Playwright, GitHub Actions CI and Pages workflows, dev-only debug panel (FPS, draw calls, sim tick time, sliders).

- **M2 Car and camera**: 300 × 300 m block (`content/map/block0.json`) with a 4 × 4 road grid and 24 instanced box buildings; custom arcade car model in the XZ plane (`packages/sim/src/vehicle.ts`) driven by `content/data/vehicles.json`; Rapier cuboid colliders for car vs building and car vs car (cars are dynamic bodies whose velocities the arcade model sets each step; Rapier resolves contacts); pitched follow camera with speed-scaled height and look-ahead; intent layer with keyboard, gamepad and touch (direction steering by default, classic arrows + gas/brake switchable in the ☰ menu); auto-straighten; every handling and camera value live-tunable in the debug panel with "Save" writing back to the JSON via a dev-server endpoint.

## Next

- M3 Traffic, collisions feedback, HEAT and police.

## Open questions

- None yet.
