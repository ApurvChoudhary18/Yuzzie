/**
 * SPEC.md §18 Session 17: every published export resolves and loads under
 * ES modules and CommonJS, and its types are right (arethetypeswrong).
 *
 *   node scripts/check-packages.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
const LIBRARIES = ['core', 'sdk', 'store', 'git', 'mcp', 'server']
let failed = 0

for (const name of LIBRARIES) {
  const dir = join(root, 'packages', name)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const require = createRequire(join(dir, 'package.json'))
  for (const [subpath, conditions] of Object.entries(pkg.exports)) {
    const specifier = `${pkg.name}${subpath === '.' ? '' : subpath.slice(1)}`
    for (const [kind, load] of [
      ['import', () => import(pathToFileURL(join(dir, conditions.import.default)).href)],
      ['require', () => require(join(dir, conditions.require.default))],
    ]) {
      try {
        const module = await load()
        const count = Object.keys(module).length
        if (count === 0) throw new Error('no exports')
        console.log(`✓ ${specifier} (${kind}): ${count} exports`)
      } catch (error) {
        failed += 1
        console.error(`✗ ${specifier} (${kind}): ${error instanceof Error ? error.message : error}`)
      }
    }
  }
  try {
    execFileSync('npx', ['-y', '@arethetypeswrong/cli@0.18', '--pack', '--profile', 'node16'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    console.log(`✓ ${pkg.name}: arethetypeswrong clean`)
  } catch (error) {
    failed += 1
    console.error(`✗ ${pkg.name}: arethetypeswrong\n${error.stdout ?? ''}`)
  }
}

// The two modules that read import.meta: loaded through CommonJS, they must still work.
const store = createRequire(join(root, 'packages/store/package.json'))(
  join(root, 'packages/store/dist/index.cjs'),
)
const cache = store.openCache({ boardSlug: 'check', location: ':memory:' })
console.log(`✓ @yuzie/store (require) opens a ${cache.kind} cache`)
cache.close()

if (failed > 0) {
  console.error(`${failed} problem(s)`)
  process.exitCode = 1
}
