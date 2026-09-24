import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ['better-sqlite3'],
  // Migrations are read from disk at runtime, not bundled.
  publicDir: false,
})
