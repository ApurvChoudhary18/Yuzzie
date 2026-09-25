import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The TUI tests drive a real Ink app key by key; slow CI runners need room.
    testTimeout: 20_000,
    // Wall-clock budgets run alone in the `bench` task; see vitest.bench.config.ts.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.bench.test.ts'],
  },
})
