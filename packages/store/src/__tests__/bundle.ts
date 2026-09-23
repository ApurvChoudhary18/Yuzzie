/**
 * A runnable build of the package, for tests that need a *separate process*.
 *
 * Vitest executes TypeScript in-process; a child that must be SIGKILLed cannot.
 * So the durability test compiles the package once into `.crash-test/` (inside
 * the package, so `@yuzie/core` and `better-sqlite3` still resolve) and spawns
 * plain `node` against it. This exercises the real driver code, not a stand-in.
 */
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const BUNDLE_DIR = join(packageRoot, '.crash-test')
export const BUNDLE_ENTRY = join(BUNDLE_DIR, 'index.js')

export function buildRunnableBundle(): void {
  execFileSync(
    join(packageRoot, 'node_modules', '.bin', 'tsup'),
    [
      'src/index.ts',
      '--format',
      'esm',
      '--out-dir',
      '.crash-test',
      '--no-dts',
      '--target',
      'node20',
      '--external',
      'better-sqlite3',
    ],
    { cwd: packageRoot, stdio: 'pipe' },
  )
}

export function removeRunnableBundle(): void {
  rmSync(BUNDLE_DIR, { recursive: true, force: true })
}
