# Status

## Living city (23 Nov 2026)

All tuning is in `content/data/life.json` (Zod: `packages/sim/src/life-config.ts`); per-tier caps (`responders`, `gangMembers`, `gangCars`) are in `quality.json`.

- **Emergency services** (`services.ts`). A ped knocked down near the player brings an ambulance; a wreck heavier than `wreckMinMass` catches fire and brings a fire tender. Units come from the nearest clinic marker or a road out of view, follow the road graph with sirens and beacons on, park at the kerb, and the crew walks round to the job. Paramedics kneel either side and revive the patient; firefighters hose the wreck until it goes out (flames, spray and steam in `apps/game/src/life-layer.ts`). Then the vehicle rejoins traffic with its lights off. Traffic pulls over and slows for any siren, including police with HEAT. Audio gets `siren` events, plus `v.siren` for the siren voices.
- **Street crews** (`gangs.ts`). Five crews hang about in groups at spots in their home district, each with its colour and its own silhouette: a hood, a visor with pads, a hat with coat tails, a beanie with vest bands, or a crest with an antenna pack. Crew cars cruise their turf in crew colours. Respect: call `world.gangs.setRespect(crew, n)` (the director syncs mission progress). At +20 or more, members nod to you and fight police who come for you. In between, they ignore you unless attacked. At -20 or less, they shoot on sight on their own turf. Rival squads raid each other now and then: a stand-off, then a fight, and a crowd gathers. Hitting a crew member is a police crime only if police see it.
- **Crowds** (`crowds.ts`).
  - People walk in small groups and cross at junctions on the pedestrian phase of `trafficLight()`, queueing across the zebra.
  - They put up umbrellas in rain and shelter in doorways in storms.
  - They gather round wrecks and fights, then scatter at gunfire, and dive away from a car mounting the pavement.
  - Density follows district style and time of day.
- **Rendering** (`people-view.ts`, `people-gear.ts`). All kit and umbrellas are one `BatchedMesh` and every glowing detail one instanced mesh, so this adds 1 draw call (the glow mesh replaced the officers' shoulder-light mesh). New poses: kneel, nod, hose, film, shelter, aim, loiter. The people cap rose from 65 to 120.
- **Performance**: a 60 s headless run with everything on (crews, crowds, responders, traffic, police) took 1.15 ms per tick on average. The three life systems account for about 0.05 ms of that.
- **Tests**: `tests/unit/living-city.test.ts` (19). Screenshots are in `overnight/living-city/`.
- **Open**:
  - Police do not respond to crew fights, and officers do not shoot crew members.
  - Hostile crew cars cruise but do not chase.
  - Kneeling is approximate: the legs do not bend.
  - A responder sometimes parks at an angle part-way into the lane.
  - The first dispatch of a route runs a Dijkstra, which may cause a small hitch on a slow phone.
  - Wrecks too light to burn (bikes) no longer smoke.

## Wanted, combat and survival (23 Nov 2026)

- **HEAT 1-5, fairer.** A crime counts in full only when a police unit, the drone or a witness sees it. A witness is a pedestrian within 25 m with line of sight who phones it in after 4 s, unless they are knocked down first. Unwitnessed crime gives 20% of the points and is capped at HEAT 1, so a few shots fired in an empty street never bring a pursuit. Each level is distinct (`heat.json` `levels`):
  - HEAT 1: one patrol investigates and tails you.
  - HEAT 2: pursuit with flank, cut-off and PIT roles, plus box-in.
  - HEAT 3: the drone arrives and officers shoot at a player on foot.
  - HEAT 4: wardens (heavy interceptors), roadblocks and spike strips.
  - HEAT 5: patrol vans with tactical officers.
- **Escaping HEAT.** Break line of sight and it decays per level. Swapping cars unseen drops a level. A `respray*` marker, or `world.police.respray()`, clears HEAT up to 3 if you are unseen.
- **The police stop you instead of killing you.** Ram damage is capped per hit, with a cooldown and knock-on capping, so a car comes out of a 60 s HEAT 2 chase with more than half its hull. A unit at the cut-off position eases off once it is ahead of you. Patrol cars pull up short of a player on foot and officers get out. Officers cuff a slow player (BOOKED) and, from HEAT 3, shoot with spread.
- **FLATLINED / BOOKED.** You lose 10% or 15% of your credits and your weapons. You respawn at the nearest `clinic*` or `precinct*` marker (or `player_start`) with HEAT cleared, and a full-screen card shows what it cost.
- **Weapons** (`weapons.json`): fists (three-hit combo), bat, pistol, SMG, shotgun, rifle, grenade launcher (arcing shot, area damage, throws cars over) and arc caster (chains to two more targets and stuns them). Ammo and an inventory come with a `nextWeapon` intent: the touch WPN button, Q/Tab, or the gamepad's left shoulder. The SMG and pistol can be fired from a car (drive-by). Wrecked cars explode; bikes crumple (`wreckMinMass`).
- **Pickups** (`pickups.json`) are placed from `pickup_<kind>_*` markers; `grenade` and `taser` are aliases for the launcher and the arc caster. They respawn after 40 s and render as glowing, spinning icons, each with its own shape and colour.
- **Street score** (`survival.json`): crimes earn credits on a chain multiplier. The pending credits bank once HEAT has been 0 for a short while. The score is kept in step with the save's credits.
- **HUD**: BODY and ARMOUR bars, the weapon icon, its name and ammo, the score chain, credits, and a CUFFS meter under the HEAT chevrons. The hull bar only shows while driving.
- **Open**: the vehicle flip is visual only (the sim keeps cars flat). Jobs do not fail on FLATLINED or BOOKED; you respawn and the job goes on. Respray is reachable only through markers or the API, and the city has no `respray*` markers yet. Arc bolt flicker uses `Math.random` (visual only). Officers do not show a getting-out animation.

## Vehicle roster (23 Nov 2026)

- **23 variants** (17 new): hatchback, saloon, cab, estate, SUV, two sports cars, two supercars, muscle, pickup, van, box truck, hauler, bus, ambulance, fire tender, patrol car, patrol van, heavy interceptor, corporate enforcer, motorbike and sport bike. Every handling value is in `vehicles.json`. New optional fields (all defaulted): `class`, `model`, `twoWheel`, `traffic` (weight), `districts`, `paints`, `leanMax`, plus class paint palettes under `paints`.
- **Roster helpers** in `packages/sim/src/roster.ts`: `variantsOfClass`, `pickTrafficVariant` (weighted, district-boosted, seeded) and `paintFor`. Police escalate to `warden` (HEAT 4) and `patrolvan` (HEAT 5) through `heat.json`.
- **Bikes**: a two-wheeler only slides on the rear brake (handbrake); the view leans it into turns and seats a rider. They are light, so cars knock them about.
- **Rendering**: all bodies and riders are one `BatchedMesh` (one draw call) with per-instance paint. A `paintMask` vertex attribute keeps trim untinted. Lamps (head, tail and brake, beacons, taxi sign, clearance lamps and accent strips) are one instanced mesh. The whole roster costs 4 draw calls. Parked cars go dark.
- **Showroom**: `?garage=1` (add `&labels=1` for names, `&city=1` to keep the buildings) loads `apps/game/src/garage.ts` on demand.
- **Open**: district-aware traffic; per-class engine audio; a sustained shove from a light car still moves a parked lorry (the arcade model's push ignores mass until the contact).
## Sound (23 Nov 2026)

The game had no sound. It now has a fully procedural sound layer (`packages/audio`, tuned in `content/data/audio.json`). Nothing is shipped as an audio file: one-shots are rendered from code at runtime, in a frame-budgeted queue after the first tap.
- **Engine**: one AudioContext, created and unlocked on the first gesture. It resumes after iOS interruptions and suspends when the tab is hidden. Buses: music, world, ambience and UI, then a high-pass, a compressor and a limiter. One generated reverb is shared. Pausing mutes world sounds and puts the music behind a low-pass. One-shots play on a pool of 24 channel strips.
- **Cars**: the nearest 6 cars get engine voices. Each of the six classes (coupé, muscle, van, police, motorbike, sports) has its own harmonic spectrum. Rpm comes from speed, gear and load, with a throttle cut on upshifts. There is doppler, tyre squeal from lateral slip and handbrake, exhaust pops on lift-off, and traffic horns after a shunt.
- **Impacts**: metal crunches in three sizes, plus glass, explosions and kerb thumps. Smashed props sound by material (wood, plastic, metal, glass with electrical fizz, hydrant spray). Body hits are soft thuds.
- **Weapons**: pistol, SMG, shotgun and rifle each have their own sound, with street slap-back echoes. There are also a launcher thump, taser crackle, fist and bat swings and hits, a dry click and a reload, plus ricochets and bullet hits.
- **Police**: up to 3 sirens (wail far off, yelp close, doppler), drone rotor hum at HEAT 3 and above, and scanner chatter (garbled formant voice).
- **City**: rain (darker inside a car), the low hum of the city and distant traffic. Far-off sirens and horns play while not wanted. Crowd murmur rises near people. Short formant screams and shouts play when people scatter. Wrecks crackle with fire, and footsteps land on the wet street.
- **UI and stings**: menu blips, pickup, cash, HEAT up and down tones, and hack-panel notes per node. Mission start, complete and fail stings, plus flatline and busted stings; all stings duck the radio.
- **Radio**: four stations of generated music: NIGHTDRIVE 88.1 (synthwave), STATIC CHAPEL 101.9 (dark techno), SOFT RAIN FM 92.4 (lo-fi) and RUSH HOUR 174.0 (drum and bass). A seeded composer builds 6 tracks per station, each with its own tempo, key, progression, bass line, motif and arrangement. Stations run live, so coming back resumes mid-song. Tuning plays static, then the station's jingle. The radio plays only in a car: press **R** or the **FM** button to change station. The pause menu has a Sound section with master, music and effects volume and a station choice.
- **Tests**: `tests/unit/audio.test.ts` (19 tests) covers the content schema, sequencer determinism and form, scale correctness, the timeline, the ident, distance gain, engine pitch and gear mapping, voice allocation caps and hysteresis, doppler, siren range and DSP sanity. A new e2e test unlocks audio with a tap and fires every cue, checking for no errors.
- **Open**: the mix was checked by level and spectrum analysis of captured output, not by ear on a phone; levels may need a listening pass. There is no player horn input yet (`horn` events are supported). New weapon and pickup events are handled by name in `GameAudio.handle` (weapon from `e.weapon`).
## Front end and flow (23 Nov 2026)

The game now has a proper front end, all in `packages/ui` with the wiring in `apps/game/src/flow.ts` (game.ts only calls into it).

- **Title screen**: original NEON HEAT logotype drawn as SVG paths (neon-tube NEON, solid HEAT whose A is the double HEAT chevron), rain, light sweep and scanlines over the paused city. Tap to start is the first user gesture: it calls `flow.audio.onFirstGesture` (audio unlock) and requests full screen. Then Continue (with a save summary) / New game (two-tap confirm when a save exists) / Settings / Credits. The first-boot benchmark still runs behind it.
- **Pause menu** (menu button, Esc, or M for the map): tab rail with Map, Jobs (active job with Restart job / Walk away, respect bars for the five crews, payphone list), Stats (lifetime stats from the save) and Settings (steering scheme, touch layout, vibration, graphics, frame rate, minimap north-up or turning, Sound section with master / radio / effects volumes and a test-sound hook). Resume.
- **Full map** (Map tab or tap the minimap): pan, pinch, wheel, zoom buttons, centre on me, map key; districts tinted and labelled, roads, water, parks, landmarks (shape + colour badges), crew payphones, police with vision cones at HEAT 3+, the objective, tap to set a waypoint (tap the pin to clear) and the GPS route with its length.
- **Minimap**: static layer pre-rendered once, a window blitted at 30 Hz; zooms out with speed; optional heading-up rotation with a compass N; route line, police with cones at HEAT 3+, crew payphones, waypoint and objective clamped to the rim; district name underneath.
- **GPS**: `flow.setRouteFn(route)` takes the road graph's `route(fromX, fromZ, toX, toZ)`; until then a straight line. Routes refresh when the target moves or the player strays more than 10 m.
- **Map data**: everything draws from the `MapGeometry` interface (`packages/ui/src/map-geometry.ts`); `geometryFromBlockMap` adapts the current block. The new city calls `flow.setGeometry(geom)`.
- **Cards**: job start banner (crew icon and title), job done (time, damage, pay roll-up, respect changes, Continue; pauses the game), FLATLINED and BOOKED (`{ title, subtitle, lines[] }`; shown for `playerDied` now and for `playerWasted` / `playerBusted` with an optional `penalty` once those events exist), HEAT level-change flashes (chevron banner up, HEAT LOST when clear), "Entering <district>" banner.
- **HUD**: credits with a rolling count-up and +/- pop, weapon/ammo slot (`hud.setWeapon`) and armour bar (`hud.setArmour`) ready for combat, onboarding hint line `hud.showHint(text, controlId?)` with the named control pulsing, urgent timer, restyled objective, dialogue and toasts. Type is Chakra Petch (OFL, bundled).
- **Save**: new lifetime stats default to 0, so existing v1 saves load unchanged.
- **Tests**: e2e start flow updated (tap to start, New game), job-done card checked, and a new phone test opens the map from the minimap, sets a waypoint by touch, zooms, visits Jobs and Stats and resumes. Unit tests for the map geometry adapter, routes and crew icons, and the stats defaults.

### Next

- Swap in the generated city: `flow.setGeometry(cityGeometry)` and `flow.setRouteFn(world.route)`.
- Hook the AudioEngine to `flow.audio.onFirstGesture` / `onTestSound` and read the volume settings.
- Combat: call `hud.setWeapon` and `hud.setArmour` each frame (they only write on change).
- Tutorial mission `hint` event: call `game.hud.showHint(text, controlId)`.
## Missions and campaign (23 Nov 2026)

There is now a campaign: 26 missions across five crews, with a six-part story thread, all running on the generated Vey City.

- **Crews.** Each crew's payphones ring in its colour, and each colour is paired with a shape (`content/data/crews.json`):

  | Crew | Contact | Colour | Shape |
  |---|---|---|---|
  | Glasshounds | Vesper | cyan | diamond |
  | Kurogane | Mr Sato-Reyes | red | square |
  | Velvet Choir | Mother Lune | magenta | circle |
  | Rustmouth | Gaffer Odge | acid yellow | triangle |
  | Null Saints | Litany | green | hexagon |

  Several payphones ring at once, but only for jobs whose prerequisites are met. A payphone rings for one job at a time.
- **Story.** `story_01_first_call` is the tutorial. It shows hint lines for touch and keyboard controls, and is the only job a new game offers. The thread then runs through Cold Boot, Paper Trail, Salt and Iron and Dead Air to the finale, `story_06_lattice_fall`. Each crew has a chain of four jobs. The later jobs in a chain are gated by crew respect.
- **Objective types.** There are 16, all data-driven:
  - reach, hack (a vehicle or an on-foot terminal), deliverVehicle, stealVehicle, destroyVehicle (can have an escape point), eliminate;
  - protect (escort or defend), tail, chase (disable or wreck), escape, race (with AI opponents), collect;
  - wait, dropOff (with passengers), photograph, perform (dodge, fire, enter, exit).
  
  Any objective can have `timeLimitSec` and `failOn` conditions:
  - vehicle destroyed;
  - actor killed;
  - HEAT or TRACE at a level;
  - player on foot;
  - player too far away.
- **Schema.**
  - The giver takes `at: "marker:<id>"`; the old `pos` form still works.
  - Missions can declare their own `spawns` and `actors`. A `spawn:` ref looks in the mission's own spawns first, then in the map's.
  - An offset that lands inside a building is nudged out (`freeSpot` in `packages/missions/src/refs.ts`).
  - New mission fields: `prerequisites` (missions and/or crew respect), `chain`, `story`, and `rewards` (credits, respect per crew, unlocks, time bonus).
- **Actors.** `packages/sim/src/actors.ts` handles scripted people (guards, followers, fleeing targets, armed hostiles) and drivers (route, flee, ram, hold).
- **Main road network.** `packages/sim/src/road-main.ts` keeps routing on the main road network. The generated city has dead-end stubs that are islands in the road graph.
- **Save v2.** Adds respect per crew, unlocks and each mission's best time and number of passes. A migration converts v1 saves.
- **Results.** The director reports each completed job's time, damage, pay (with any time bonus), respect and unlocks. The game shows the time and pay, and writes the result to the save.
- **mission-lint.** It now also checks:
  - refs and objective fields;
  - squads, crews and HEAT levels;
  - whether targets can be reached on foot or by car;
  - a rough duration estimate against the budget;
  - for the whole campaign: unknown prerequisites, cycles, whether every job can be reached from a new game, chain order and the story start.
  
  Warnings do not fail the run unless you pass `--strict`. `--map <file>` checks against another map.

### Tests

- `mission-runner.test.ts` covers every objective type against a fake host.
- `missions.test.ts` covers:
  - content checks (counts, types, squads, a clean lint on the real city);
  - the schema;
  - lint and campaign errors;
  - payphones and progress;
  - tutorial hints;
  - Hot Chrome in the world (checkpoint, shunted target, completion result).
- `mission-bot.test.ts`: the bot plays Hot Chrome, Scrap Value, Handshake, Test Drive and the tutorial headlessly in the city.

### Open questions

- HEAT tops out at 3 in `heat.json`. The finale was written for 4, and now uses 3 until police work raises the cap.
- Auto-aim only targets police and squad cars. Hostile mission actors are hit by a segment test along the player's shots. Auto-aim should also consider `world.actors.nearestHostile`.
- Mission durations are estimated from straight-line distances. They need checking by playing each job on a phone.

## Kerbs and street furniture (23 Nov 2026)

Playing on the phone, hitting a kerb stopped the car dead. The kerb itself never had a collider. The problem was what stands on the pavement:
- Kerbside trees and vending machines could not be smashed, so they stopped a car at any speed.
- Bins, benches, bollards and hydrants blocked a slow car.
- Street lamps had no collider at all, so cars drove straight through them.

A sweep of about 4,900 kerb crossings snagged 13% of the time.

- **Kerbs are a bump.** Each axle that rides up costs a little speed (up to 7% square on, less for a glancing crossing; dropping off is gentler). The car body rises onto the pavement and pitches over the step. A small camera jolt and a haptic tap scale with speed into the kerb. People, the player and blob shadows now stand on the pavement instead of in it. Tuning lives in `vehicles.json` (`kerb`), `feel.json` (`kerb*`) and the map (`roads.kerbHeight`).
- **Everything kerbside smashes at driving speed**, losing speed and hull by how heavy it is. Bins and crates go from about walking pace; benches, barriers, bollards and hydrants from a slow roll; lamps from 11 km/h; vending machines and trees from 15 to 16 km/h, with a 22 to 28% speed loss and some hull damage. Only buildings, the outer wall, kiosks, dumpsters and other vehicles stop a car. Parked cars get shoved.
- **Street lamps are physical.** The layout moved into the sim (`packages/sim/src/street.ts`), and each lamp is a breakable prop. A knocked-down lamp lies on the pavement and its light goes out in the light field; a smashed vending machine stops lighting the street. They come back with the other props.
- **Checked by driving it.** A touch-steering roam of the whole block (260 random routes, about 29 minutes of driving) now only stops at buildings and at parked cars wedged against them. `tests/unit/kerbs.test.ts` covers:
  - crossing kerbs at 15 to 90° and 3 to 30 m/s;
  - every kerb of the real block at three angles and two speeds;
  - mounting versus dropping off;
  - no bump on a teleport;
  - lamps smashing.

## Visual and feel overhaul (22 Nov 2026): conclusions first

- **Budget comes from the target phone, not a guess.** An iPhone 17 Pro Max (A19 Pro: 6-core GPU with hardware ray tracing, roughly desktop-M2 class; 12 GB RAM; 2868 × 1320 panel = 956 × 440 CSS px at DPR 3; ProMotion up to 120 Hz, but Safari runs `requestAnimationFrame` at 60 fps by default) can afford a full-resolution, heavily lit frame. So there is a fourth tier, **Max** (`ultra`), built for it. The three lower tiers stay for ordinary phones, and only they keep the hard < 100 draw-call cap (measured: low 39, mid 79, high 80 in the populated block).
- **Lighting is the headline.** Max renders an HDR *light field*: every street lamp, sign, prop, headlight, tail light, police bar, muzzle flash and fire is splatted into a top-down HalfFloat texture, and each light's contribution is ray-marched against a building height map for soft, penumbra shadows (16 steps on Max, 8 on high). All materials sample it, so coloured light spills onto roads, pavements, walls, cars and people. On top: screen-space reflections on the wet road (28-step depth march + binary refine + streak blur), HDR exposure with a filmic shoulder, a grade, selective bloom, lit rain and volumetric lamp cones. That is real per-pixel ray marching against the city, within WebGL 2.
- **WebGPU recommendation: not yet.** Safari 26 ships WebGPU, and it would allow a compute-shader light grid and proper hardware-accelerated ray queries later. But the current look already fits WebGL 2 at 60 fps on this class of GPU, and switching renderers is a large, risky change for Phase 1. Revisit once the game loop is settled: compute-based clustered lights and SSR would be the first wins.
- **The first-boot benchmark now measures real frames.** It used to sample a fixed 2 s window, which slow shader compilation could eat entirely; with no samples it silently stored "mid" for ever. It also trusted frame intervals, which a browser can keep short while GPU work queues up behind them. It now waits for at least 40 frames (up to 6 s), reads back one pixel after each benchmark frame so the GPU work is included, judges on the mean, holds dynamic resolution while measuring, and stores the result under a new key (`neonheat.benchmark.v3`) so every device re-measures once.
- **What emulation cannot prove**: real iPhone frame times, thermal throttling over a long session, Safari's shader compile times, touch latency and haptics. Headless Chromium renders WebGL in software (SwiftShader); it proves the code paths and the draw-call counts, not the speed. The menu now has **Frame rate: Show**, which overlays tier, FPS, render scale and light count on the device.

### What changed

- **Character**: a modelled, animated runner (walk cycle, arms, visible pistol), 1.45× scale, white jacket, rim light, personal light and a ground ring, so the player reads at a glance. On-foot camera comes in to 27 m.
- **Cars**: six distinct low-poly models (coupé, muscle, van, interceptor, enforcer, prototype) with working head, tail and brake lights, light beams, police light bars and visible damage.
- **City**: map re-densified by `tools/map-compiler/src/densify.ts`: 133 buildings on subdivided lots, alleys and plazas, 379 props (bins, benches, bollards, hydrants, planters with trees, vending machines, kiosks, dumpsters, crates, barriers) and 19 parked cars. Roads gain kerbs, centre and edge lines, zebra crossings and stop lines; pavements are slabbed and toned; buildings get lit window grids, roof parapets, seams, plant and helipads, and neon signs facing the street.
- **Props are physical**: every prop has a collider; light ones smash (debris, hydrant spray, shake, haptics) and slow the car, then respawn after 45 s once nobody is near.
- **HUD and touch**: redesigned HEAT panel, italic speedo, segmented hull bar with a low-health pulse, a north-up minimap with police, objective and job markers, glassy touch buttons with a resting stick ring.
- **Rotation lock**: the game always plays landscape, even held in portrait with rotation lock on (the app rotates itself and remaps touches).

### Feel changes

- **Driving weight**: each car has a lateral grip ceiling (`latGripMax`), so fast turns are limited by grip rather than snapping; sliding scrubs speed; yaw rate is grip-limited when not drifting. Kestrel: 0–100 km/h in 2.1 s; a 90° stick turn at 80 km/h takes 1.2 s and drops to 57 km/h; a hairpin takes 1.8 s; a 45° change of lane loses no speed.
- **Direction steering assists**: pushing the stick hard against the direction of travel now brakes, then flicks the handbrake for a hairpin, so touch players can drift without a second thumb.
- **Skid marks and tyre smoke** while sliding, handbraking or braking hard; they fade over 14 s.
- **Impacts**: light flashes from gunfire, crashes and explosions; debris in each prop's colour; haptic pulses on shots (6–12 ms) and smashes.
- **On foot**: facing turns at up to 16 rad/s, so aiming and rolling feel immediate.
- **Traffic**: parked cars no longer count as lane obstacles, and traffic spawns respect them.
- **Camera**: pitch 57°, FOV 30°, height 58–88 m driving, 27 m on foot.

### Bugs found and fixed during the pass

- Parked cars crept backwards on their own: the "parked" controls held the foot brake, which at a standstill means reverse, and on fast cars it beat the handbrake. Parked cars now hold only the handbrake (`tests/unit/vehicle.test.ts`, "parked cars").
- A police car could shunt the locked Hot Chrome prototype into a corner during the hack, and every retry then restored it wedged there. A mission car the player has not driven yet is now checkpointed at its spawn point (`tests/unit/missions.test.ts`).

### Tests

- The iPhone touch path is the primary e2e path and runs first, at the exact Pro Max screen (440 × 956 portrait with rotation lock, 956 × 440 landscape, DPR 3): tap to start, walk with the floating stick, enter and drive, steal from traffic, answer the payphone, hack on the touch panel and deliver Hot Chrome. A second test checks every touch button stays on screen and at least 48 px.
- 74 unit tests, 9 e2e tests, draw-call perf test and a 1-minute soak all pass locally.

### Next from this pass

- Measure on the real phone with **Frame rate: Show**, and tune the Max tier from those numbers (light count, shadow steps and SSR are the expensive knobs).
- The start area is still quieter than the rest of the block; dress it in the next map pass.

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

- Hosted CI renders WebGL in software, so the smoke test budget is 120 ms per frame there (50 ms locally). It catches regressions only; real-device frame times must be measured on a phone. Software rendering benchmarks as the low tier.
- The bundle is about 1 MB gzip, mostly Rapier's inlined WASM (budget 1.6 MB).
- On low, mid and high, wet-road reflections are painted once from the sign layout, so moving lights do not reflect. Max uses screen-space reflections, which do reflect them but cannot show anything off screen.

## Tuning values settled on

- **Camera**: pitch 57°, FOV 30°, height 58–88 m driving (by speed), 27 m on foot, look-ahead 0.55 s capped at 20 m.
- **Kestrel (player default)**: top speed 36 m/s, acceleration 15, brake 32, grip 9, drift grip 1.6, handbrake grip ×0.14, drift enters at 9 m/s slip and exits at 2.2, steer rate 3.1 → 1.75 rad/s (low → high speed), auto-straighten 14.
- **Vandal** is driftier (grip 6.5, drift enters at 7); **Brick** is heavy and slow (2,600 kg, top speed 25).
- **Feel**: shake 0.05 per impact strength (max 1.6, decay 7); hit-stop from strength 9, 35 ms + 3 ms per strength, max 110 ms; vibration from strength 5, max 90 ms.
- **World**: 10 traffic cars on mid and high; abandoned stolen cars recycled after 20 s out of range; at most 3 wrecks.
- **HEAT**: thresholds 0 / 1 / 45 / 100; ram police 30, hit ped 14, repeated civilian hits 10, firing 6; decays a level after 10 s unseen; search radius 70 / 95 / 120 m at levels 1–3; drone at level 3 with 48 m sight.
- **Quality**: the benchmark renders the Max tier for at least 2 s and 40 frames; Max at ≤ 18.5 ms median, high at ≤ 28 ms, mid at ≤ 40 ms, else low; dynamic resolution targets 16.7 ms, floor 0.6.

## Next

- Phase 1: audio (radio, adaptive stems, SFX pool), HEAT 4–5, TRACE response, a second and third mission from data, the Tiled map pipeline, and a real-phone performance pass on the three tiers.

## Open questions

- Should TRACE eventually be its own pursuit (netrunners, drones) or modify HEAT? Phase 1 design call.
- Which real phones count as the "mid-range" reference device for the performance budget?
