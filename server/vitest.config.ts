import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite drives a real Postgres, so files must not run in parallel -
    // they would contend on the same rows and produce flaky failures that have
    // nothing to do with the code under test.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
  },
});
