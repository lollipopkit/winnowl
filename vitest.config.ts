import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Root-only option (not allowed in projects[]). Each integration test file starts its own
    // postgres container, so this also caps live containers.
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 4),
    minWorkers: 1,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
          setupFiles: ['./vitest.setup.ts'],
          // RSA keygen / fake HTTP server tests occasionally exceed 5s under parallel load.
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'packages/*/test/**/*.integration.test.ts',
            'apps/*/test/**/*.integration.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
          setupFiles: ['./vitest.setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
