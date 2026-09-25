import { defineConfig } from 'vitest/config'

/**
 * Tests that assert wall-clock budgets (SPEC.md §18 Session 8: first paint
 * under 400 ms), run on their own with `pnpm bench` — or from the root with
 * `pnpm turbo bench --concurrency=1` — against the built binary.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.bench.test.ts'],
    testTimeout: 60_000,
    fileParallelism: false,
  },
})
