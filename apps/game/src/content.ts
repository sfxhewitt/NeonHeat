import { rawContent } from '@neonheat/content';
import { parseSimContent, type SimContent } from '@neonheat/sim';
import { CameraConfigSchema, FeelConfigSchema, type CameraConfig, type FeelConfig } from '@neonheat/engine';

export interface GameContent {
  sim: SimContent;
  camera: CameraConfig;
  feel: FeelConfig;
}

export function loadGameContent(): GameContent {
  const raw = structuredClone(rawContent);
  return {
    sim: parseSimContent(raw),
    camera: CameraConfigSchema.parse(raw.camera),
    feel: FeelConfigSchema.parse(raw.feel),
  };
}
