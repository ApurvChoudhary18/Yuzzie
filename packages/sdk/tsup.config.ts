import { defineConfig } from 'tsup'

export default defineConfig({
  // `index` is the browser-safe core; `node` adds credential resolution, which
  // needs the filesystem and the OS keychain (SPEC.md §13.1, §13.3).
  entry: ['src/index.ts', 'src/node.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
})
