import { DialogueSchema, SquadsSchema, parseMission, type Dialogue, type Mission, type Squads } from './schema';

export interface MissionContent {
  missions: Mission[];
  squads: Squads;
  dialogue: Dialogue;
}

export function loadMissionContent(raw: { squads: unknown; dialogue: unknown }, rawMissions: Record<string, unknown>): MissionContent {
  return {
    missions: Object.entries(rawMissions).map(([file, m]) => parseMission(m, `mission ${file}`)),
    squads: SquadsSchema.parse(raw.squads),
    dialogue: DialogueSchema.parse(raw.dialogue),
  };
}
