import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Wall-clock budgets run alone in the `bench` task; see vitest.bench.config.ts.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.bench.test.ts'],
  },
})
