/**
 * SPEC.md §10.4 / §18 Session 16: the CLI installs in under 4 MB.
 *
 * Everything the CLI needs is bundled into dist/, so the published package
 * declares no runtime dependencies and its unpacked size *is* its installed
 * size. Both are checked: a new dependency would dodge the size check, so it
 * is refused by name.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUDGET_BYTES = 4 * 1024 * 1024
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const problems = []
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  const names = Object.keys(pkg[field] ?? {})
  if (names.length > 0)
    problems.push(`${field} must be empty (bundle them instead): ${names.join(', ')}`)
}

const [packed] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
)
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`
console.log(
  `@yuzie/cli: ${packed.entryCount} files, ${mb(packed.size)} download, ${mb(packed.unpackedSize)} installed (budget ${mb(BUDGET_BYTES)})`,
)
if (packed.unpackedSize >= BUDGET_BYTES)
  problems.push(`installed size ${mb(packed.unpackedSize)} is over the ${mb(BUDGET_BYTES)} budget`)
if (packed.files.some((file) => file.path.endsWith('.map')))
  problems.push('source maps are in the package (build without YUZIE_SOURCEMAPS)')

for (const problem of problems) console.error(`✗ ${problem}`)
if (problems.length > 0) process.exitCode = 1
