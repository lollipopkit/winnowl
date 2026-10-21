import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Component tests use `*.spec.ts` so the root unit project (`*.test.ts`, no svelte plugin) skips them.
const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    alias: { $lib: resolve(here, 'src/lib') },
    // Resolve Svelte's client build for @testing-library/svelte.
    conditions: ['browser'],
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
