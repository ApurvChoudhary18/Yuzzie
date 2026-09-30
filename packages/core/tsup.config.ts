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
})
