# Status

Phase 0: feel prototype. Question being answered: is driving, crashing and escaping the police fun on a phone?

## Done

- **M1 Skeleton**: pnpm workspace, Vite app with full-screen landscape canvas (resize + DPR scaling), fixed 60 Hz sim loop with render interpolation and a seeded RNG (`packages/sim`), ESLint (with rules enforcing a DOM/Three-free sim), typecheck, Vitest, Playwright, GitHub Actions CI and Pages workflows, dev-only debug panel (FPS, draw calls, sim tick time, sliders).

- **M2 Car and camera**: 300 × 300 m block (`content/map/block0.json`) with a 4 × 4 road grid and 24 instanced box buildings; custom arcade car model in the XZ plane (`packages/sim/src/vehicle.ts`) driven by `content/data/vehicles.json`; Rapier cuboid colliders for car vs building and car vs car (cars are dynamic bodies whose velocities the arcade model sets each step; Rapier resolves contacts); pitched follow camera with speed-scaled height and look-ahead; intent layer with keyboard, gamepad and touch (direction steering by default, classic arrows + gas/brake switchable in the ☰ menu); auto-straighten; every handling and camera value live-tunable in the debug panel with "Save" writing back to the JSON via a dev-server endpoint.

- **M3 Something to hit, something to run from**: 10 pooled traffic cars on three lane loops with car-following (gap keeping, braking for obstacles, stuck recovery, brief "stunned" state after a hard hit); collision feedback (sparks, camera shake, hit-stop, Vibration API); vehicle damage with smoke and a destroyed state; HEAT 1–3 with 1–3 patrol cars that route along the road graph, pursue with lead and ram, and a level-3 surveillance drone that flies over buildings (its sight radius is drawn on the ground). HEAT decays one level after 10 s out of sight, and at level 2+ only while outside the search radius around the last known position. HEAT rises from ramming police, repeated hits on civilian cars (2 within 10 s), hitting peds and firing. HUD shows HEAT chevrons (flashing while seen), speed and hull. Buildings between the camera and the player are dithered away so the car is never hidden.

- **M4 On foot**: the player starts on foot (capsule with a neon visor) next to a car. Floating-stick movement; one context button that appears only when relevant (ENTER / STEAL / EXIT / HACK / LOCKED / mission actions); stealing a moving traffic car throws the driver out, who flees; three civilian variants (Kestrel coupé, Vandal muscle, Brick van) parked nearby and in traffic, each with its own handling; pistol with soft-lock auto-aim on the nearest hostile in a 60° cone (red lock marker), hitscan via Rapier ray casts, tracers and muzzle flash; dodge roll with i-frames; 15 pooled pedestrians that wander, flee gunfire and crashes, dive away from fast cars, sometimes cower, and are knocked down by cars. Getting run over hurts; at zero health you are FLATLINED and patched up at the clinic with HEAT cleared. A wrecked car throws you out.

- **M5 The look**: Neon Noir palette; deterministic emissive signage strips and roof edges on buildings (magenta, cyan, acid yellow); selective half-resolution bloom (only the bloom layer glows; buildings and car bodies are drawn black as occluders; two-iteration separable blur; vignette in the composite); wet-road shader with procedural lane markings, a tiny blurred neon-reflection texture painted from the sign layout, and a scrolling noise normal; one instanced rain streak mesh plus one instanced splash-ring mesh, both animated entirely in the vertex shader around the camera focus; blob shadows under cars, peds, player and drone (one instanced call). Three quality tiers in `content/data/quality.json` with a 1.5 s benchmark behind the title screen on first boot (stored), bloom and rain off on low, plus dynamic resolution scaling 0.6–1.0. Populated block at HEAT 3 measures **24 draw calls** on the high tier (Playwright perf test asserts < 100). Title screen with tap to start (fullscreen + landscape lock on phones), Esc/☰ pause menu.

## Next

- M6 One mission from data.

## Open questions

- None yet.
