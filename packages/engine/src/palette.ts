/** Neon Noir palette. Faction colour is gameplay information: always pair it with shape. */
export const Palette = {
  bg: 0x0b0d1a,
  ground: 0x0e0f1e,
  road: 0x2a2850,
  line: 0x3a3866,
  building: 0x34366a,
  buildingTop: 0x2a2c52,
  magenta: 0xff2bd6,
  cyan: 0x21f0ff,
  acid: 0xd7ff2b,
  policeRed: 0xff2a3d,
  policeBlue: 0x2f6bff,
  white: 0xf2f2ff,
  fog: 0x120f26,
} as const;

export const NeonColours = [Palette.magenta, Palette.cyan, Palette.acid] as const;
