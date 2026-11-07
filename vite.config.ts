import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  base: './',
  // The menu shows the real version, so it can't drift from package.json.
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 5199, strictPort: true },
  build: { outDir: 'dist', assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
});
