import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The durability test spawns and kills child processes; give it room.
    testTimeout: 30_000,
    globalSetup: ['./src/__tests__/global-setup.ts'],
    // The benchmark asserts a 20ms budget, which cannot be measured honestly
    // while seven packages compile in parallel around it. It runs as its own
    // turbo task instead: `pnpm bench`. SPEC.md §16 treats the CLI's start-up
    // budget the same way, as a dedicated hyperfine check rather than a unit test.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/benchmark.test.ts'],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/__fixtures__/**',
        'src/__tests__/**',
        // Declarations only: it compiles to an empty module, so there is no
        // executable line for v8 to report on.
        'src/types.ts',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
})
