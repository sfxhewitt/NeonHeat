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
import pickups from './data/pickups.json' with { type: 'json' };
import survival from './data/survival.json' with { type: 'json' };
import hotChrome from './missions/glasshounds_03_hot_chrome.json' with { type: 'json' };

export const rawContent = { vehicles, camera, map, heat, traffic, feel, peds, weapons, quality, squads, dialogue, props, pickups, survival };

/** Every mission file, keyed by file name. One JSON file per mission. */
export const rawMissions: Record<string, unknown> = {
  'glasshounds_03_hot_chrome.json': hotChrome,
};
export type RawContent = typeof rawContent;
