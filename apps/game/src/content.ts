import { rawContent, rawMissions } from '@neonheat/content';
import { loadMissionContent, type MissionContent } from '@neonheat/missions';
import { parseAudioConfig, type AudioConfig } from '@neonheat/audio';
import { parseSimContent, type SimContent } from '@neonheat/sim';
import { SaveConfigSchema, type SaveConfig } from '@neonheat/save';
import { CameraConfigSchema, FeelConfigSchema, QualitySchema, type CameraConfig, type FeelConfig, type QualityConfig } from '@neonheat/engine';

export interface GameContent {
  sim: SimContent;
  camera: CameraConfig;
  feel: FeelConfig;
  quality: QualityConfig;
  missions: MissionContent;
  audio: AudioConfig;
  save: SaveConfig;
}

export function loadGameContent(): GameContent {
  const raw = structuredClone(rawContent);
  return {
    sim: parseSimContent(raw),
    camera: CameraConfigSchema.parse(raw.camera),
    feel: FeelConfigSchema.parse(raw.feel),
    quality: QualitySchema.parse(raw.quality),
    missions: loadMissionContent(raw, structuredClone(rawMissions)),
    audio: parseAudioConfig(raw.audio),
    save: SaveConfigSchema.parse(raw.save),
  };
}
