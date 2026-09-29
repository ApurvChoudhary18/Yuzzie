import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts'],
  format: ['esm'],
  target: 'node22',
  // The TUI (Ink, React) is a separate chunk, loaded only when the board opens,
  // so every other command starts without it.
  bundle: true,
  splitting: true,
  dts: false,
  // Maps would triple the install; set YUZIE_SOURCEMAPS=1 to debug a build.
  sourcemap: process.env.YUZIE_SOURCEMAPS === '1',
  clean: true,
  // Ink's devtools (and the websocket library they use) load only under
  // DEV=true, so they are never shipped.
  external: ['react-devtools-core', 'ws'],
  // Everything is bundled (§10.4: < 4 MB installed): the published CLI has no
  // runtime dependencies to download, only this code, tree-shaken. CommonJS
  // dependencies inside an ES module bundle need a real `require`.
  noExternal: [/^(?!react-devtools-core$|ws$).*/],
  minify: true,
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __yuzieCreateRequire } from 'node:module'",
      'const require = __yuzieCreateRequire(import.meta.url)',
    ].join('\n'),
  },
  define: {
    __YUZIE_VERSION__: JSON.stringify(pkg.version),
    // React and its reconciler pick their production build from this.
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})
