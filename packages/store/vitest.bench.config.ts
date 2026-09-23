import { defineConfig } from 'vitest/config'

/**
 * The performance budget from SPEC.md §18 Session 2, run on its own.
 *
 * `pnpm bench` (or `pnpm turbo bench --concurrency=1` from the root) is the only
 * thing that should be running when this executes.
 */
export default defineConfig({
  test: {
    include: ['src/benchmark.test.ts'],
    globalSetup: ['./src/__tests__/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
