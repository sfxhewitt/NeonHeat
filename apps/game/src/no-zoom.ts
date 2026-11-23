/**
 * The game is an app, not a page: no pinch zoom and no double-tap zoom anywhere.
 * iOS ignores `user-scalable=no` in the viewport tag, and its double-tap zoom can still
 * fire on overlays (menus, cards, the shop), so this blocks both in script as well.
 * In-game gestures are untouched: the touch controls and the full map read pointer
 * events, which still arrive.
 */
const DOUBLE_TAP_MS = 350;

export function blockPageZoom(doc: Document = document): void {
  // Safari's pinch-to-zoom gesture events (iOS only; harmless elsewhere).
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    doc.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  // Two fingers anywhere never scale the page.
  doc.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1 || ((e as TouchEvent & { scale?: number }).scale ?? 1) !== 1) e.preventDefault();
    },
    { passive: false },
  );
  // A second tap soon after the first would zoom: cancel it, and hand the element its click
  // ourselves so quick taps on menu buttons still work.
  let last = 0;
  doc.addEventListener(
    'touchend',
    (e) => {
      const now = e.timeStamp || performance.now();
      const quick = now - last < DOUBLE_TAP_MS;
      last = now;
      if (!quick || e.touches.length > 0 || e.changedTouches.length !== 1) return;
      const t = e.target as Element | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      e.preventDefault();
      // A real click event (it reaches SVG icons inside buttons too, which have no .click()).
      if (t && !(t instanceof HTMLCanvasElement)) {
        const p = e.changedTouches[0]!;
        t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: p.clientX, clientY: p.clientY, screenX: p.screenX, screenY: p.screenY }));
      }
    },
    { passive: false },
  );
  doc.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
}
