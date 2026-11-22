# NEON HEAT — agent rules

Mobile-first, top-down cyberpunk open-world crime game (working title NEON HEAT).
Inspired by classic top-down crime games. Low-poly 3D, neon on dark, pitched top-down camera.
Web first (browser), later wrapped with Capacitor for iOS and Android.

## Stack (do not change without asking)

- TypeScript (strict), Vite, pnpm workspaces
- Three.js `WebGLRenderer` (WebGL 2). No WebGPU path yet.
- Rapier (`@dimforge/rapier3d-simd-compat`) for collision queries and response only
- Custom arcade vehicle model (not Rapier's vehicle controller)
- HTML/CSS overlay for HUD, touch controls and menus
- Web Audio API for sound
- Zod + JSON Schema for all content data
- Vitest (unit), Playwright (headless e2e and perf)
- GitHub Actions CI: lint, typecheck, unit, e2e, bundle-size check

## Repository layout

```
apps/game/            Vite app: entry, boot, quality tiers
apps/native/          Capacitor config (added in a later phase)
packages/engine/      renderer, camera, chunk streaming, instancing, post-fx
packages/sim/         fixed-step world: vehicles, peds, traffic, heat, combat
packages/missions/    MissionRunner, objective types, trigger/event DSL
packages/ui/          HUD, touch controls, menus, minimap
packages/audio/       radio, adaptive stems, SFX pool
packages/save/        versioned save schema + migrations
content/map/          Tiled .tmj maps and tilesets
content/missions/     one JSON file per mission
content/data/         factions, vehicles, weapons, cyberware, economy
tools/map-compiler/   Tiled -> chunks, lane graph, ped graph
tools/mission-lint/   schema validation + reachability checks
tests/unit  tests/e2e  tests/perf
```

## Architecture rules (hard)

1. `packages/sim` must never import Three.js, the DOM or any browser API. It is pure
   TypeScript, deterministic, and runs in Node for tests. Rendering reads sim state; it never owns it.
2. Fixed 60 Hz simulation step with render interpolation. All randomness goes through one seeded RNG.
3. Everything a designer would tune lives in JSON under `content/`, validated with Zod at load.
   No gameplay constants hard-coded in logic.
4. Missions are data. New missions are new JSON files interpreted by `MissionRunner`, never new code paths,
   unless a new objective type is genuinely needed.
5. Pool every spawned object (cars, peds, bullets, particles, audio voices). No allocation in the hot loop.
6. Input is abstracted into an intent layer (`steer`, `throttle`, `fire`, `interact`...). Keyboard, touch and
   gamepad all feed the same intents.

## Performance budget (mid-range phone)

- Target 60 fps, floor 30 fps
- Under 100 draw calls, about 100k visible vertices
- Instanced meshes for buildings, props, traffic and peds; one shared palette atlas/material
- No real-time shadows: blob shadows, baked vertex AO, emissive signage
- Bloom is selective, half resolution, off on the low tier
- Dynamic resolution scaling 0.6–1.0 of device pixel ratio
- Three quality tiers, auto-selected by a short benchmark on first boot
- Caps on mid tier: ~40 peds, ~20 civilian cars, ~8 police units; AI ticks at 10–20 Hz, staggered

## Visual direction: "Neon Noir Low-Poly"

- Flat-shaded geometry, vertex colours or a single 256×256 palette atlas
- Base palette near-black blue/purple (around #0b0d1a); faction neons magenta, cyan, acid yellow;
  police red/blue. Faction colour is gameplay information: pair colour with shape for colour-blind safety.
- Wet-road shader: tiny blurred neon-reflection texture + scrolling noise normal. No planar reflections.
- Rain: one instanced streak mesh following the camera, plus splash decals
- Camera: pitch 55–65°, FOV 30–35°, height lerps with vehicle speed, look-ahead in travel direction

## Controls

- Landscape only
- On foot: floating left stick, auto-aimed fire on the right (nearest hostile in a 60° cone), dodge,
  one context button that appears only when relevant (Steal / Hack / Talk)
- Driving: ship two schemes behind a setting — direction steering (push the stick the way you want to go;
  default) and classic left/right + gas/brake. Auto-straighten when not steering. Handbrake button.
- Touch targets at least 48 dp, repositionable. Haptics on impacts. Gamepad API supported.
- Keyboard + mouse on desktop

## Game rules that must hold

- Wanted system is HEAT (1–5 chevrons) plus TRACE (0–100% net trace). Never stars.
- Autosave on mission end, safehouse entry and every 2 minutes of free roam. Pause when the tab/app is backgrounded.
- Missions are 3–8 minutes with checkpoint retry and instant restart.
- No loot boxes, energy timers, ads during play, or drug-dealing content.

## IP rules (hard)

Never use "GTA", "Grand Theft", Rockstar-style logos or fonts, star wanted icons, real car or brand names,
or anything imitating that series' UI or marketing, in code, assets, copy or comments shipped to users.

## Assets

- Phase 0 uses procedural boxes and primitives only. Later phases use CC0 kits (Kenney, Quaternius).
- Every imported asset gets a line in `assets/LICENCES.md` (source, licence, URL). No asset without provenance.

## Working agreement

- Before finishing any task: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` must pass.
- Add or update tests with every sim change. Sim behaviour is tested headlessly in Node.
- Playwright smoke test must boot the game, drive for 10 seconds via injected intents, and assert no console
  errors and an average frame time within budget.
- Small commits with clear messages. Keep `docs/STATUS.md` current: done, next, open questions.
- Feel tuning (handling, camera, shake) is exposed in a debug panel with live sliders that write back to JSON.
- British English in all player-facing text.
