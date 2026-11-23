import type { DriveScheme } from '@neonheat/sim';

export type QualityTier = 'low' | 'mid' | 'high' | 'ultra';

export interface Settings {
  scheme: DriveScheme;
  quality: QualityTier | 'auto';
  vibration: boolean;
  sound: boolean;
  /** Frame rate and tier readout in the corner. */
  perf: boolean;
}

const KEY = 'neonheat.settings.v1';

export function loadSettings(): Settings {
  const defaults: Settings = { scheme: 'direction', quality: 'auto', vibration: true, sound: true, perf: false };
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
