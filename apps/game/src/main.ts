import { boot } from './boot';
import { blockPageZoom } from './no-zoom';

blockPageZoom();
boot().catch((err: unknown) => {
  console.error(err);
  const el = document.getElementById('overlay');
  if (el) el.textContent = `Failed to start: ${String(err)}`;
});
