// Raw content, as authored. Consumers validate it with the Zod schemas in the sim, engine and missions packages.
import vehicles from './data/vehicles.json' with { type: 'json' };
import camera from './data/camera.json' with { type: 'json' };
import map from './map/block0.json' with { type: 'json' };
import heat from './data/heat.json' with { type: 'json' };
import traffic from './data/traffic.json' with { type: 'json' };
import feel from './data/feel.json' with { type: 'json' };

export const rawContent = { vehicles, camera, map, heat, traffic, feel };
export type RawContent = typeof rawContent;
