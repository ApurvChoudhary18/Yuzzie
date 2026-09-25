import { defineConfig } from 'vitest/config'

/**
 * Tests that assert wall-clock budgets (SPEC.md §18 Session 4: < 100 ms delivery,
 * 100 events/s), run on their own with `pnpm bench` — or from the root with
 * `pnpm turbo bench --concurrency=1` — so nothing else competes for the CPU.
 */
export default defineConfig({
  test: {
    include: ['src/realtime-timing.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    setupFiles: ['./src/__tests__/docker-env.ts'],
    globalSetup: ['./src/__tests__/global-setup.ts'],
    fileParallelism: false,
  },
})
