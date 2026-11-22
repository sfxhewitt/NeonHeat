// Bundle-size budget for the static build. Fails CI when the gzipped JS grows past the budget.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = new URL('../apps/game/dist/', import.meta.url).pathname;
// Rapier's SIMD build embeds its WebAssembly as base64 inside the JS bundle, so the budget is generous.
const BUDGET_GZIP_KB = Number(process.env.SIZE_BUDGET_KB ?? 1600);

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

let raw = 0;
let gz = 0;
for (const file of walk(dist)) {
  if (!/\.(js|css|wasm)$/.test(file)) continue;
  const buf = readFileSync(file);
  raw += buf.length;
  gz += gzipSync(buf).length;
}
const kb = (n) => (n / 1024).toFixed(1);
console.info(`bundle: ${kb(raw)} KB raw, ${kb(gz)} KB gzip (budget ${BUDGET_GZIP_KB} KB gzip)`);
if (gz / 1024 > BUDGET_GZIP_KB) {
  console.error('Bundle size budget exceeded');
  process.exit(1);
}
