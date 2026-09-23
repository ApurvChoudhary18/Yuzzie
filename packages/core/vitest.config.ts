import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // `all` counts files no test imported, so a forgotten module cannot hide
      // behind a high percentage (SPEC.md §16 gates @yuzie/core at 90%).
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__fixtures__/**'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
})
