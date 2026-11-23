// Raw content, as authored. Consumers validate it with the Zod schemas in the sim, engine and missions packages.
import vehicles from './data/vehicles.json' with { type: 'json' };
import camera from './data/camera.json' with { type: 'json' };
import map from './map/block0.json' with { type: 'json' };
import heat from './data/heat.json' with { type: 'json' };
import traffic from './data/traffic.json' with { type: 'json' };
import feel from './data/feel.json' with { type: 'json' };
import peds from './data/peds.json' with { type: 'json' };
import weapons from './data/weapons.json' with { type: 'json' };
import quality from './data/quality.json' with { type: 'json' };
import squads from './data/squads.json' with { type: 'json' };
import dialogue from './data/dialogue.json' with { type: 'json' };
import props from './data/props.json' with { type: 'json' };
import crews from './data/crews.json' with { type: 'json' };
import actors from './data/actors.json' with { type: 'json' };

import story01 from './missions/story_01_first_call.json' with { type: 'json' };
import story02 from './missions/story_02_cold_boot.json' with { type: 'json' };
import story03 from './missions/story_03_paper_trail.json' with { type: 'json' };
import story04 from './missions/story_04_salt_and_iron.json' with { type: 'json' };
import story05 from './missions/story_05_dead_air.json' with { type: 'json' };
import story06 from './missions/story_06_lattice_fall.json' with { type: 'json' };
import glass01 from './missions/glasshounds_01_window_shopping.json' with { type: 'json' };
import glass02 from './missions/glasshounds_02_test_drive.json' with { type: 'json' };
import glass03 from './missions/glasshounds_03_hot_chrome.json' with { type: 'json' };
import glass04 from './missions/glasshounds_04_repo_job.json' with { type: 'json' };
import kuro01 from './missions/kurogane_01_severance.json' with { type: 'json' };
import kuro02 from './missions/kurogane_02_hostile_takeover.json' with { type: 'json' };
import kuro03 from './missions/kurogane_03_quarterly_figures.json' with { type: 'json' };
import kuro04 from './missions/kurogane_04_golden_parachute.json' with { type: 'json' };
import velvet01 from './missions/velvet_01_guest_list.json' with { type: 'json' };
import velvet02 from './missions/velvet_02_encore.json' with { type: 'json' };
import velvet03 from './missions/velvet_03_bad_reviews.json' with { type: 'json' };
import velvet04 from './missions/velvet_04_last_dance.json' with { type: 'json' };
import rust01 from './missions/rustmouth_01_scrap_value.json' with { type: 'json' };
import rust02 from './missions/rustmouth_02_low_tide.json' with { type: 'json' };
import rust03 from './missions/rustmouth_03_crane_game.json' with { type: 'json' };
import rust04 from './missions/rustmouth_04_bridge_toll.json' with { type: 'json' };
import saints01 from './missions/nullsaints_01_handshake.json' with { type: 'json' };
import saints02 from './missions/nullsaints_02_ghost_signal.json' with { type: 'json' };
import saints03 from './missions/nullsaints_03_root_access.json' with { type: 'json' };
import saints04 from './missions/nullsaints_04_blue_screen.json' with { type: 'json' };

export const rawContent = { vehicles, camera, map, heat, traffic, feel, peds, weapons, quality, squads, dialogue, props, crews, actors };

/** Every mission file, keyed by file name. One JSON file per mission. */
export const rawMissions: Record<string, unknown> = {
  'story_01_first_call.json': story01,
  'story_02_cold_boot.json': story02,
  'story_03_paper_trail.json': story03,
  'story_04_salt_and_iron.json': story04,
  'story_05_dead_air.json': story05,
  'story_06_lattice_fall.json': story06,
  'glasshounds_01_window_shopping.json': glass01,
  'glasshounds_02_test_drive.json': glass02,
  'glasshounds_03_hot_chrome.json': glass03,
  'glasshounds_04_repo_job.json': glass04,
  'kurogane_01_severance.json': kuro01,
  'kurogane_02_hostile_takeover.json': kuro02,
  'kurogane_03_quarterly_figures.json': kuro03,
  'kurogane_04_golden_parachute.json': kuro04,
  'velvet_01_guest_list.json': velvet01,
  'velvet_02_encore.json': velvet02,
  'velvet_03_bad_reviews.json': velvet03,
  'velvet_04_last_dance.json': velvet04,
  'rustmouth_01_scrap_value.json': rust01,
  'rustmouth_02_low_tide.json': rust02,
  'rustmouth_03_crane_game.json': rust03,
  'rustmouth_04_bridge_toll.json': rust04,
  'nullsaints_01_handshake.json': saints01,
  'nullsaints_02_ghost_signal.json': saints02,
  'nullsaints_03_root_access.json': saints03,
  'nullsaints_04_blue_screen.json': saints04,
};
export type RawContent = typeof rawContent;
