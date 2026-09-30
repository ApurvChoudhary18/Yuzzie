import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  // ES modules and CommonJS both (§18 Session 17: resolvable from ESM, CJS
  // and bundlers); `shims` gives the CJS build an `import.meta.url`.
  format: ['esm', 'cjs'],
  shims: true,
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Native, optional, and loaded through createRequire at runtime — bundling it
  // would defeat the fallback it exists to enable.
  external: ['better-sqlite3'],
})
