import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    setupFiles: ['./src/__support__/docker-env.ts'],
    globalSetup: ['./src/__support__/global-setup.ts'],
    fileParallelism: false,
  },
})
