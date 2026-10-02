import { defineConfig } from 'vitest/config'

/**
 * `pnpm --filter @yuzie/server load` (SPEC.md §10.4, §18 Session 16): 25
 * clients, a 2,000-card board, 100 events a second — alone, so it measures the
 * server rather than whatever else the machine is doing. `--expose-gc` lets it
 * measure the heap after collection rather than before.
 */
export default defineConfig({
  test: {
    include: ['src/load.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    setupFiles: ['./src/__tests__/docker-env.ts'],
    globalSetup: ['./src/__tests__/global-setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    execArgv: ['--expose-gc'],
  },
})
