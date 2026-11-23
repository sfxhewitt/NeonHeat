import type { DriveScheme } from '@neonheat/sim';

export type QualityTier = 'low' | 'mid' | 'high' | 'ultra';

export interface Settings {
  scheme: DriveScheme;
  quality: QualityTier | 'auto';
  vibration: boolean;
  sound: boolean;
  /** Player volume trims, 0..1 (the mix itself lives in content/data/audio.json). */
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  /** Car radio station index; -1 = radio off. */
  radioStation: number;
  /** Frame rate and tier readout in the corner. */
  perf: boolean;
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
    masterVolume: 1,
    musicVolume: 1,
    sfxVolume: 1,
    radioStation: 0,
    perf: false,
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
