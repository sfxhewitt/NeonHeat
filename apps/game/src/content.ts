import { rawContent } from '@neonheat/content';
import { parseSimContent, type SimContent } from '@neonheat/sim';
import { CameraConfigSchema, type CameraConfig } from '@neonheat/engine';

export interface GameContent {
  sim: SimContent;
  camera: CameraConfig;
}

export function loadGameContent(): GameContent {
  const raw = structuredClone(rawContent);
  return {
    sim: parseSimContent(raw),
    camera: CameraConfigSchema.parse(raw.camera),
  };
}
