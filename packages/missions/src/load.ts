import { ActorConfigSchema, type ActorConfig } from '@neonheat/sim';
import { CrewsSchema, DialogueSchema, SquadsSchema, parseMission, type Crews, type Dialogue, type Mission, type Squads } from './schema';

export interface MissionContent {
  missions: Mission[];
  squads: Squads;
  dialogue: Dialogue;
  crews: Crews;
  /** Tuning for mission actors (people and drivers); apply with world.actors.configure(). */
  actors: ActorConfig;
}

export function loadMissionContent(
  raw: { squads: unknown; dialogue: unknown; crews?: unknown; actors?: unknown },
  rawMissions: Record<string, unknown>,
): MissionContent {
  return {
    missions: Object.entries(rawMissions).map(([file, m]) => parseMission(m, `mission ${file}`)),
    squads: SquadsSchema.parse(raw.squads),
    dialogue: DialogueSchema.parse(raw.dialogue),
    crews: CrewsSchema.parse(raw.crews ?? {}),
    actors: ActorConfigSchema.parse(raw.actors ?? {}),
  };
}
