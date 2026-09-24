import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  // A single shebanged file so `npx yuzie` is one fetch and one process.
  bundle: true,
  splitting: false,
  dts: false,
  sourcemap: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  define: { __YUZIE_VERSION__: JSON.stringify(pkg.version) },
})
