import { defineConfig } from 'vite';
import { tuningPlugin } from './tuning-plugin';

export default defineConfig({
  // GitHub Pages serves from /<repo>/; set BASE_PATH in CI.
  base: process.env.BASE_PATH ?? '/',
  plugins: [tuningPlugin()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-simd-compat'],
  },
});
