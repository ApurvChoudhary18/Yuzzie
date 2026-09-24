import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Native, optional, and loaded through createRequire at runtime — bundling it
  // would defeat the fallback it exists to enable.
  external: ['better-sqlite3'],
})
