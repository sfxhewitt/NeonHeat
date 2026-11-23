import type { DriveScheme } from '@neonheat/sim';

export type QualityTier = 'low' | 'mid' | 'high' | 'ultra';

export interface Settings {
  scheme: DriveScheme;
  quality: QualityTier | 'auto';
  vibration: boolean;
  sound: boolean;
  /** Frame rate and tier readout in the corner. */
  perf: boolean;
  /** Volumes 0..1, read by the audio engine through the settings hook. */
  volumeMaster: number;
  volumeMusic: number;
  volumeSfx: number;
  /** Minimap turns with the player's heading instead of staying north-up. */
  minimapRotate: boolean;
}

const KEY = 'neonheat.settings.v1';

export function loadSettings(): Settings {
  const defaults: Settings = {
    scheme: 'direction',
    quality: 'auto',
    vibration: true,
    sound: true,
    perf: false,
    volumeMaster: 0.9,
    volumeMusic: 0.7,
    volumeSfx: 0.9,
    minimapRotate: false,
  };
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) } : defaults;
  } catch {
    return defaults;
  }
}

export function storeSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}
