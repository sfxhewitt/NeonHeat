import { boot } from './boot';

boot().catch((err: unknown) => {
  console.error(err);
  const el = document.getElementById('overlay');
  if (el) el.textContent = `Failed to start: ${String(err)}`;
});
