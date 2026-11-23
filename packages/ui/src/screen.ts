/**
 * Landscape everywhere. iPhones cannot lock orientation from a web page, and a
 * phone with rotation lock on never reports landscape, so when a touch device
 * is in portrait the whole app (#app) is drawn rotated 90° clockwise and the
 * player simply holds the phone on its side. These helpers map screen
 * coordinates into the app's landscape coordinates.
 */
const PORTRAIT_QUERY = '(orientation: portrait) and (pointer: coarse)';

let mq: MediaQueryList | null = null;

/** True when the app is being drawn rotated (portrait touch screen). */
export function isRotated(): boolean {
  if (typeof matchMedia !== 'function') return false;
  mq ??= matchMedia(PORTRAIT_QUERY);
  return mq.matches;
}

/** The app's landscape size in CSS pixels. */
export function appSize(): { width: number; height: number } {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return isRotated() ? { width: h, height: w } : { width: w, height: h };
}

/** Map a pointer's client position to app (landscape) coordinates. */
export function appPoint(clientX: number, clientY: number): { x: number; y: number } {
  if (!isRotated()) return { x: clientX, y: clientY };
  // rotate(90deg) then translateX(100vw): screen = (W - y, x), so x = screenY, y = W - screenX.
  return { x: clientY, y: window.innerWidth - clientX };
}

/** An element's box in app (landscape) coordinates. */
export function appRect(el: Element): { x: number; y: number; width: number; height: number } {
  const r = el.getBoundingClientRect();
  if (!isRotated()) return { x: r.left, y: r.top, width: r.width, height: r.height };
  return { x: r.top, y: window.innerWidth - r.right, width: r.height, height: r.width };
}
