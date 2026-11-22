import { z } from 'zod';

/** Collision feedback tuning: shake, hit-stop, vibration and sparks. */
export const FeelConfigSchema = z.object({
  shakePerStrength: z.number().nonnegative(),
  shakeMax: z.number().nonnegative(),
  shakeDecay: z.number().positive(),
  hitStopMinStrength: z.number().nonnegative(),
  hitStopBaseMs: z.number().nonnegative(),
  hitStopPerStrengthMs: z.number().nonnegative(),
  hitStopMaxMs: z.number().nonnegative(),
  vibrateMinStrength: z.number().nonnegative(),
  vibrateBaseMs: z.number().nonnegative(),
  vibratePerStrengthMs: z.number().nonnegative(),
  vibrateMaxMs: z.number().nonnegative(),
  sparksPerStrength: z.number().nonnegative(),
  sparksMax: z.number().int().nonnegative(),
});
export type FeelConfig = z.infer<typeof FeelConfigSchema>;
