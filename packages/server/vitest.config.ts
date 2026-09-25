import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Pulling and booting a Postgres container is slow the first time.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    setupFiles: ['./src/__tests__/docker-env.ts'],
    globalSetup: ['./src/__tests__/global-setup.ts'],
    // One container per file would be wasteful; the suites share a database and
    // isolate themselves by creating their own workspaces and boards.
    fileParallelism: false,
    // Wall-clock budgets run alone in the `bench` task; see vitest.bench.config.ts.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/realtime-timing.test.ts'],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**', 'src/**/types.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
})
