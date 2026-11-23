# NEON HEAT: game design (v1, 23 Nov 2026)

Phase 0 proved that driving and crashing feel good. On the phone, the game still rated 1 out of 10: a tiny map, nothing to do, and HEAT that went from nothing to a lethal army after three shots. This document sets out the full game and the order it gets built in. It is wholly original: no names, places, characters, missions, layouts, UI, audio or look are taken from any other game.

## The pitch

You are a nobody with a stolen car and a burner phone in **Vey City**, a rain-soaked coastal megacity cut in two by the Sable River. Five crews run the streets. Every payphone is a job and every car is yours if you are quick. Build a name with the crews, play them off against each other, keep your HEAT down and your TRACE low, and climb from errand runner to the person who decides who owns the city.

## Core loop (the 10-minute session)

1. **Free roam**: drive or walk across a big, busy city. There is always something in view to do:
   - a payphone ringing in a crew's colour;
   - a car on the export list;
   - a glowing pickup on a rooftop route;
   - a rampage token;
   - a stunt ramp;
   - a taxi fare waving.
2. **Take a job** (3 to 8 minutes). It pays credits and crew respect, and opens the next job in that crew's chain.
3. **Cause trouble, get HEAT**. Escape with skill: break line of sight, use the alleys, change cars, get a respray, or lie low.
4. **Spend**: buy weapons, ammo and armour, get resprays, buy cyberware upgrades and safehouses. Each purchase shows up straight away in how you play.
5. **Fail cheap**: if you are WASTED you wake at a clinic, and if you are BUSTED you are released at a precinct. Either way you lose some credits and your weapons, never your progress.

## What makes free roam fun

- **Density over size**: every block has something to hit, smash, steal or shoot. Traffic and people react: drivers honk, swerve and flee, pedestrians scream, run and call it in.
- **Escape is a skill, not luck**:
  - HEAT 1 is a nuisance you can outrun;
  - HEAT 3 needs a plan;
  - HEAT 5 is a spectacle.
  - Police try to *stop* you: box in, PIT, spike strips at HEAT 4 or more, arrests on foot. They do not kill you on contact.
- **Score multiplier**: chaining crimes, near misses, jumps and drifts builds a credit multiplier that pays out when you lose HEAT.

## The city: Vey City (about 1.6 × 1.6 km)

Generated deterministically from `content/map/city.json` (district polygons, road spacing, densities, landmarks), not hand-placed. It is many times the size of the Phase 0 block (300 m), and crossing it at speed takes about a minute.

| District | Character | Crew turf | Colour |
|---|---|---|---|
| **Glass Quarter** (centre) | towers, wide avenues, plazas, corporate lobbies | Kurogane (corporate security syndicate) | white and steel, red trim |
| **Lantern Row** (north-west) | dense neon market, narrow streets, alleys, signs everywhere | Velvet Choir (club and vice syndicate) | magenta |
| **Saltworks** (south of the river) | docks, warehouses, containers, cranes, wide yards | Rustmouth (dock scrappers and smugglers) | acid yellow |
| **Ashgrove** (east) | low-rise housing, parks, corner shops, quiet streets | Glasshounds (car thieves and fixers) | cyan |
| **The Undercroft** (west, by the river) | elevated rail, junkyards, garages, back lots | Null Saints (hackers; TRACE) | green |

- The **Sable River** runs east to west and is crossed by three bridges.
- **Main avenues** are 18 m wide, streets 13 m and alleys 7 m (no traffic in alleys).
- **Landmarks**:
  - a clinic and a precinct in each half of the city;
  - safehouses;
  - a respray shop ("Fresh Coat") and a bomb and arms shop ("Loud Goods");
  - chop shops for export lists;
  - a stadium-like plaza, the dock cranes and the central tower.

## HEAT and TRACE

- **HEAT** has 5 chevrons, never stars.

| Level | Response |
|---|---|
| HEAT 1 | one patrol investigates; it decays in 15 s out of sight |
| HEAT 2 | patrols pursue and try to box you in |
| HEAT 3 | the drone, more units and officers who shoot when you are on foot |
| HEAT 4 | heavy interceptors, roadblocks, spike strips |
| HEAT 5 | tactical teams and a gunship-drone |

  - Points are scaled so a few shots in an empty street give HEAT 1 at most.
  - Witnessed crimes count more, and unwitnessed crimes barely count.
  - A respray clears HEAT 1 to 3 when nobody is watching.
- **TRACE** (0 to 100 % net trace) rises from hacks and Null Saints jobs. At 50 % drones scan for you, and at 100 % you are tagged: HEAT 2 floor until you jack out at a Null Saints node.

## Combat

Weapons are bought or picked up, each with ammo, and they switch on a touch button:
- fists and a bat (melee);
- a pistol;
- an SMG;
- a shotgun;
- a rifle;
- a grenade launcher (HEAT 4+ tool);
- a flamethrower-style "arc caster" (tasers chaining between targets).

Auto-aim stays: the nearest hostile in a 60° cone. Health, armour and weapon pickups are spread around the map and respawn.

## Missions

- Missions are data on MissionRunner.
- Each of the five crews has a chain of at least 4 jobs.
- A story thread with rising stakes runs through Vesper (Glasshounds), who first hands you the phone.
- Objective types:
  - reach;
  - hack;
  - deliverVehicle;
  - stealVehicle;
  - destroyVehicle;
  - kill (eliminate targets);
  - protect / escort;
  - tail (keep within range without being seen);
  - chase (catch a fleeing car);
  - escape (lose HEAT);
  - race checkpoints;
  - collect pickups;
  - timed variants;
  - getaway driving (wait, then drive passengers).
- The first job is a guided tutorial that teaches walking, stealing, driving, fighting and escaping.

## Side activities

- **Rampages**: tokens that start a timed kill or wreck challenge.
- **Stunt jumps**: ramps, with an air-time reward.
- **Hidden data shards**: 50 collectables.
- **Export list**: deliver listed models to a chop shop.
- **Taxi and courier fares**.
- **Street races** from flags.
- Each activity has a counter on the stats screen.

## Sound

All sound is procedural Web Audio; there is no copyrighted audio:
- engine notes by vehicle class;
- tyres;
- impacts;
- gunfire per weapon;
- sirens;
- rain;
- crowd reactions;
- UI blips;
- 4 radio stations of generated music (synthwave, dark techno, lo-fi, drum and bass), with station idents.

## Progression

- **Credits** buy weapons, armour, resprays and three cyberware slots:
  - **Reflex** slows time briefly on dodge;
  - **Plating** adds armour;
  - **Ghost** gives slower HEAT build-up.
- **Respect per crew** unlocks each crew's next job and its turf's discounts.
  - Hostile crews (negative respect) shoot on sight in their turf.
- **Safehouses** (3, buyable) save the game and give a respawn point.

## Onboarding and polish

- Title screen.
- First-time tutorial job.
- Pause with map, stats and settings.
- Mission-complete card with time, damage and pay.
- WASTED and BUSTED cards.
- Full-screen map with GPS route to a selected marker.
- Minimap with a route line.

## Build order (overnight, 23 Nov 2026)

1. **Foundation**: generated city, generic road network, traffic on the road graph with lights, people spawning around the player, chunked rendering, map and GPS. *(Lead.)*
2. **In parallel**:
   - HEAT, police and survival rework, weapons, pickups, WASTED and BUSTED;
   - sound and radio;
   - vehicle roster and models;
   - UI screens (title, pause, full map, complete and fail cards, stats).
3. **Missions**: objective types, then 20+ jobs across five crews, placed in the new city; side activities.
4. **Economy**: shops, respray, safehouses, cyberware.
5. **Play and balance** through the touch layer, then iterate on the weakest part until morning.

Decisions taken without asking are logged in `docs/STATUS.md` under "Overnight decisions".
