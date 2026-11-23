import type { LandmarkKind } from './map-geometry';

/**
 * Crews and map icons. Colour is gameplay information, so every crew and every
 * landmark pairs its colour with a distinct shape (colour-blind safe). Shapes
 * are SVG path strings in a 24×24 box, used both in the DOM and on canvas
 * (via Path2D), so the map, minimap, cards and menus all draw the same icon.
 */
export type CrewShape = 'diamond' | 'square' | 'circle' | 'triangle' | 'cross';

export interface Crew {
  id: string;
  name: string;
  colour: string;
  shape: CrewShape;
  /** One line about the crew, shown in the Jobs tab. */
  blurb: string;
}

export const CREWS: readonly Crew[] = [
  { id: 'glasshounds', name: 'Glasshounds', colour: '#21f0ff', shape: 'diamond', blurb: 'Car thieves and street racers' },
  { id: 'kurogane', name: 'Kurogane', colour: '#ff3b4e', shape: 'square', blurb: 'Corporate muscle with steel on the side' },
  { id: 'velvet_choir', name: 'Velvet Choir', colour: '#ff2bd6', shape: 'circle', blurb: 'Fixers, singers, information brokers' },
  { id: 'rustmouth', name: 'Rustmouth', colour: '#d7ff2b', shape: 'triangle', blurb: 'Scrapyard engineers from the docks' },
  { id: 'null_saints', name: 'Null Saints', colour: '#3bff8a', shape: 'cross', blurb: 'Netrunners who wipe what they touch' },
];

/** A crew by id; unknown ids get a neutral crew so new content never crashes the UI. */
export function crewById(id: string | undefined): Crew {
  return CREWS.find((c) => c.id === id) ?? { id: id ?? 'unknown', name: prettyId(id ?? 'Unknown'), colour: '#e9e6ff', shape: 'diamond', blurb: '' };
}

function prettyId(id: string): string {
  return id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export const SHAPE_PATHS: Record<CrewShape, string> = {
  diamond: 'M12 1.5L22.5 12 12 22.5 1.5 12z',
  square: 'M3.5 3.5h17v17h-17z',
  circle: 'M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19z',
  triangle: 'M12 2.5l10.5 19h-21z',
  cross: 'M8.5 1.5h7v7h7v7h-7v7h-7v-7h-7v-7h7z',
};

export interface LandmarkStyle {
  colour: string;
  /** Glyph drawn inside a dark badge. */
  path: string;
  name: string;
}

export const LANDMARK_STYLES: Record<LandmarkKind, LandmarkStyle> = {
  clinic: { colour: '#ff5c7c', name: 'Clinic', path: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z' },
  precinct: { colour: '#4d8bff', name: 'Precinct', path: 'M12 2l8 3v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5z' },
  safehouse: { colour: '#d7ff2b', name: 'Safehouse', path: 'M12 2.5l9.5 8.5H18v10h-4.5v-6h-3v6H6V11H2.5z' },
  respray: { colour: '#21f0ff', name: 'Respray', path: 'M12 2c4.2 6 7 9.4 7 13a7 7 0 0 1-14 0c0-3.6 2.8-7 7-13z' },
  arms: {
    colour: '#ff9a3c',
    name: 'Arms dealer',
    path: 'M11 1h2v6h-2zM11 17h2v6h-2zM1 11h6v2H1zM17 11h6v2h-6zM12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z',
  },
  chopshop: {
    colour: '#b98cff',
    name: 'Chop shop',
    path: 'M21.5 6.5a5.5 5.5 0 0 1-7.2 5.2L6 20a2.1 2.1 0 0 1-3-3l8.3-8.3A5.5 5.5 0 0 1 17.5 1l-3.3 3.3.9 2.8 2.8.9z',
  },
  payphone: {
    colour: '#e9e6ff',
    name: 'Payphone',
    path: 'M6.5 2l4 1 1 5-2.6 1.6a11 11 0 0 0 5.5 5.5L16 12.5l5 1 1 4-2.2 3.3C10.5 20.8 3.2 13.5 3.2 4.2z',
  },
  landmark: { colour: '#e9e6ff', name: 'Landmark', path: 'M10 1.5h4l1.2 16.5H18v4.5H6V18h2.8z' },
};

/** Inline SVG for a crew mark: the crew's shape in its colour. */
export function crewSvg(crew: Crew, size = 18): string {
  return `<svg class="nh-crew-icon" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${SHAPE_PATHS[crew.shape]}" fill="${crew.colour}" stroke="#05060f" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

/** Inline SVG for a landmark badge. */
export function landmarkSvg(kind: LandmarkKind, size = 18): string {
  const s = LANDMARK_STYLES[kind];
  return `<svg class="nh-lm-icon" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${s.path}" fill="${s.colour}"/></svg>`;
}

const pathCache = new Map<string, Path2D>();
function path2d(d: string): Path2D {
  let p = pathCache.get(d);
  if (!p) {
    p = new Path2D(d);
    pathCache.set(d, p);
  }
  return p;
}

/** Draw a crew shape centred at (x, y), `size` px across. */
export function drawCrewMark(c: CanvasRenderingContext2D, crew: Crew, x: number, y: number, size: number): void {
  const k = size / 24;
  c.save();
  c.translate(x - 12 * k, y - 12 * k);
  c.scale(k, k);
  const p = path2d(SHAPE_PATHS[crew.shape]);
  c.lineJoin = 'round';
  c.lineWidth = 4;
  c.strokeStyle = '#05060f';
  c.stroke(p);
  c.fillStyle = crew.colour;
  c.fill(p);
  c.restore();
}

/** Draw a landmark badge (dark rounded square, coloured border and glyph) centred at (x, y). */
export function drawLandmark(c: CanvasRenderingContext2D, kind: LandmarkKind, x: number, y: number, size: number): void {
  const s = LANDMARK_STYLES[kind];
  const h = size / 2;
  c.save();
  c.fillStyle = 'rgba(6, 7, 18, 0.92)';
  c.strokeStyle = s.colour;
  c.lineWidth = Math.max(1, size / 14);
  c.beginPath();
  c.roundRect(x - h, y - h, size, size, size * 0.24);
  c.fill();
  c.stroke();
  const k = (size * 0.66) / 24;
  c.translate(x - 12 * k, y - 12 * k);
  c.scale(k, k);
  c.fillStyle = s.colour;
  c.fill(path2d(s.path));
  c.restore();
}
