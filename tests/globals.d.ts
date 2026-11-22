// Playwright tests reach into the running game through window.__neon (see apps/game/src/test-hooks.ts).
// Typed loosely here so the test project does not have to compile the app.
/* eslint-disable @typescript-eslint/no-explicit-any */
export {};
declare global {
  interface Window {
    __neon?: any;
  }
}
