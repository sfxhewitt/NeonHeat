# Status

Phase 0: feel prototype. Question being answered: is driving, crashing and escaping the police fun on a phone?

## Done

- **M1 Skeleton**: pnpm workspace, Vite app with full-screen landscape canvas (resize + DPR scaling), fixed 60 Hz sim loop with render interpolation and a seeded RNG (`packages/sim`), ESLint (with rules enforcing a DOM/Three-free sim), typecheck, Vitest, Playwright, GitHub Actions CI and Pages workflows, dev-only debug panel (FPS, draw calls, sim tick time, sliders).

- **M2 Car and camera**: 300 × 300 m block (`content/map/block0.json`) with a 4 × 4 road grid and 24 instanced box buildings; custom arcade car model in the XZ plane (`packages/sim/src/vehicle.ts`) driven by `content/data/vehicles.json`; Rapier cuboid colliders for car vs building and car vs car (cars are dynamic bodies whose velocities the arcade model sets each step; Rapier resolves contacts); pitched follow camera with speed-scaled height and look-ahead; intent layer with keyboard, gamepad and touch (direction steering by default, classic arrows + gas/brake switchable in the ☰ menu); auto-straighten; every handling and camera value live-tunable in the debug panel with "Save" writing back to the JSON via a dev-server endpoint.

- **M3 Something to hit, something to run from**: 10 pooled traffic cars on three lane loops with car-following (gap keeping, braking for obstacles, stuck recovery, brief "stunned" state after a hard hit); collision feedback (sparks, camera shake, hit-stop, Vibration API); vehicle damage with smoke and a destroyed state; HEAT 1–3 with 1–3 patrol cars that route along the road graph, pursue with lead and ram, and a level-3 surveillance drone that flies over buildings (its sight radius is drawn on the ground). HEAT decays one level after 10 s out of sight, and at level 2+ only while outside the search radius around the last known position. HEAT rises from ramming police, repeated hits on civilian cars (2 within 10 s), hitting peds and firing. HUD shows HEAT chevrons (flashing while seen), speed and hull. Buildings between the camera and the player are dithered away so the car is never hidden.

- **M4 On foot**: the player starts on foot (capsule with a neon visor) next to a car. Floating-stick movement; one context button that appears only when relevant (ENTER / STEAL / EXIT / HACK / LOCKED / mission actions); stealing a moving traffic car throws the driver out, who flees; three civilian variants (Kestrel coupé, Vandal muscle, Brick van) parked nearby and in traffic, each with its own handling; pistol with soft-lock auto-aim on the nearest hostile in a 60° cone (red lock marker), hitscan via Rapier ray casts, tracers and muzzle flash; dodge roll with i-frames; 15 pooled pedestrians that wander, flee gunfire and crashes, dive away from fast cars, sometimes cower, and are knocked down by cars. Getting run over hurts; at zero health you are FLATLINED and patched up at the clinic with HEAT cleared. A wrecked car throws you out.

- **M5 The look**: Neon Noir palette; deterministic emissive signage strips and roof edges on buildings (magenta, cyan, acid yellow); selective half-resolution bloom (only the bloom layer glows; buildings and car bodies are drawn black as occluders; two-iteration separable blur; vignette in the composite); wet-road shader with procedural lane markings, a tiny blurred neon-reflection texture painted from the sign layout, and a scrolling noise normal; one instanced rain streak mesh plus one instanced splash-ring mesh, both animated entirely in the vertex shader around the camera focus; blob shadows under cars, peds, player and drone (one instanced call). Three quality tiers in `content/data/quality.json` with a 1.5 s benchmark behind the title screen on first boot (stored), bloom and rain off on low, plus dynamic resolution scaling 0.6–1.0. Populated block at HEAT 3 measures **24 draw calls** (28 after M6 added mission markers) on the high tier (Playwright perf test asserts < 100). Title screen with tap to start (fullscreen + landscape lock on phones), Esc/☰ pause menu.

- **M6 One mission from data**: `content/missions/glasshounds_03_hot_chrome.json` is interpreted by `MissionRunner` (`packages/missions`) with three objective types (`reach`, `hack`, `deliverVehicle`) and four event types (`dialogue`, `setHeat`, `spawnSquad`, `addTrace`), validated by Zod with a generated JSON Schema. `pnpm mission-lint` checks schema, ids, registration and walk/drive reachability on the map grid. Pick-up is at a cyan-beamed payphone (ANSWER). The hack is a sequence-tap panel of six nodes, each a distinct shape and colour (keys 1–6 on desktop); a failed hack adds 40 % TRACE. Delivery has a 3-minute timer, a 50 % hull floor, HEAT 2 on pickup and a Kurogane enforcer squad after 20 s. HUD shows the objective, timer, dialogue, TRACE and an edge arrow to the target (cyan towards jobs in free roam). Failure shows JOB FAILED with Retry from checkpoint, Restart job and Walk away; the ☰ menu also has Restart job. Completion shows JOB DONE, pays 1,500 cr and rep, and autosaves. Saves are versioned (`packages/save`, v1 with a worked v0 migration) and stored in IndexedDB; autosave on mission end and every 2 minutes of free roam. `?bot=1` lets the headless `MissionBot` play the browser build through the intent layer.

## Phase 0 acceptance

| Criterion | Status |
| --- | --- |
| `pnpm dev` runs the game; `pnpm build` makes a static site; Pages workflow | Done (`.github/workflows/pages.yml`, `BASE_PATH` aware) |
| Phone, landscape, touch only; desktop with keyboard | Done (floating stick, context button, drift, fire, roll; WASD/arrows, Space, E, J/click, Shift, Esc) |
| Under 100 draw calls in the populated block, asserted in Playwright | Done: 28 max at HEAT 3 on the high tier (`tests/perf/drawcalls.spec.ts`) |
| 20-minute scripted soak with no frame-time or memory creep | Done. Final 20-minute run on 22 Nov 2026 (headless Chromium, mid tier, bot plus random chaos input): frame time 17.8 ms in minute 2 and 16.8 ms in minute 20; JS heap 13.1 MB then 11.0 MB; active cars stayed between 13 and 17, wrecks never above 2; 6 jobs completed; no console errors. Earlier runs found three bugs, now fixed: abandoned stolen cars and police wrecks piling up (cars crept from 15 to 26), and an endless retry on a checkpoint taken with a damaged car. |
| All sim logic covered by headless tests; CI green | Done: 64 unit tests (sim, missions, save, quality) run in Node; 5 e2e and 2 perf tests; CI green on the PR |
| Headless bot completes Hot Chrome in CI | Done in Node (`tests/unit/mission-bot.test.ts`, seeds 1–6) and in the browser build (`tests/e2e/mission.spec.ts`, also checks the IndexedDB save) |

## Cut, and why

- **HEAT 4–5**: levels are in the data (thresholds, radii, units) but only 1–3 have behaviour. Phase 0 asks whether escaping is fun; roadblocks and tactical units come later.
- **TRACE gameplay**: TRACE rises (failed hack) and decays, and shows on the HUD, but nothing reacts to it yet (no netrunner response).
- **Tiled maps and the map compiler**: one hand-authored JSON block instead. `tools/map-compiler` is a stub with a README.
- **Audio**: `packages/audio` is an empty stub; there is no sound in Phase 0. The settings toggle exists.
- **Safehouse autosave**: there is no safehouse in Phase 0. Mission-end and 2-minute free-roam autosaves are in.
- **Native wrapper**: Capacitor comes in a later phase (`apps/native/README.md`).
- **Dedicated debug panel for squad and mission tuning**: mission values are edited in the mission JSON; handling, camera, feel, HEAT and world values have live sliders.

## Known issues

- Hosted CI renders WebGL in software, so the smoke test budget is 120 ms per frame there (50 ms locally). It catches regressions only; real-device frame times must be measured on a phone.
- The bundle is about 1 MB gzip, mostly Rapier's inlined WASM (budget 1.6 MB).
- Wet-road reflections are painted once from the sign layout; moving lights (police bars) do not reflect.

## Tuning values settled on

- **Camera**: pitch 60°, FOV 32°, height 72–105 m driving (by speed), 52 m on foot, look-ahead 0.55 s capped at 20 m.
- **Kestrel (player default)**: top speed 36 m/s, acceleration 15, brake 32, grip 9, drift grip 1.6, handbrake grip ×0.14, drift enters at 9 m/s slip and exits at 2.2, steer rate 3.1 → 1.75 rad/s (low → high speed), auto-straighten 14.
- **Vandal** is driftier (grip 6.5, drift enters at 7); **Brick** is heavy and slow (2,600 kg, top speed 25).
- **Feel**: shake 0.05 per impact strength (max 1.6, decay 7); hit-stop from strength 9, 35 ms + 3 ms per strength, max 110 ms; vibration from strength 5, max 90 ms.
- **World**: 10 traffic cars on mid and high; abandoned stolen cars recycled after 20 s out of range; at most 3 wrecks.
- **HEAT**: thresholds 0 / 1 / 45 / 100; ram police 30, hit ped 14, repeated civilian hits 10, firing 6; decays a level after 10 s unseen; search radius 70 / 95 / 120 m at levels 1–3; drone at level 3 with 48 m sight.
- **Quality**: benchmark 1.5 s; high at ≤ 18 ms, mid at ≤ 26 ms, else low; dynamic resolution targets 16.7 ms, floor 0.6.

## Next

- Phase 1: audio (radio, adaptive stems, SFX pool), HEAT 4–5, TRACE response, a second and third mission from data, the Tiled map pipeline, and a real-phone performance pass on the three tiers.

## Open questions

- Should TRACE eventually be its own pursuit (netrunners, drones) or modify HEAT? Phase 1 design call.
- Which real phones count as the "mid-range" reference device for the performance budget?
