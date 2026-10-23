import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // One in-memory MongoDB per file; files run sequentially to keep memory low in CI.
    fileParallelism: false,
  },
});
