import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Content files the debug panel is allowed to write back to. */
const WRITABLE = new Set(['vehicles', 'camera', 'feel', 'heat', 'traffic', 'peds', 'weapons']);

/**
 * Dev-server endpoint used by the debug panel: POST /__neon/tune?file=vehicles
 * with a JSON body writes content/data/<file>.json. Writes made this way do not
 * trigger a page reload, so tuning stays live.
 */
export function tuningPlugin(): Plugin {
  const recent = new Map<string, number>();
  const dataDir = resolve(__dirname, '../../content/data');
  return {
    name: 'neonheat-tuning',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__neon/tune', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const url = new URL(req.url ?? '', 'http://localhost');
        const file = url.searchParams.get('file') ?? '';
        if (!WRITABLE.has(file)) {
          res.statusCode = 400;
          res.end('unknown file');
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          try {
            const parsed: unknown = JSON.parse(body);
            const path = resolve(dataDir, `${file}.json`);
            recent.set(path, Date.now());
            writeFileSync(path, JSON.stringify(parsed, null, 2) + '\n');
            res.statusCode = 200;
            res.end('ok');
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
    handleHotUpdate(ctx) {
      const at = recent.get(ctx.file);
      if (at !== undefined && Date.now() - at < 2000) return [];
      return undefined;
    },
  };
}
