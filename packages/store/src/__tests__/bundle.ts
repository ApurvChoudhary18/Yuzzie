/**
 * A runnable build of the package, for tests that need a *separate process*.
 *
 * Vitest executes TypeScript in-process; a child that must be SIGKILLed, or that
 * must resolve modules from somewhere else entirely, cannot. So the package is
 * compiled once into `.crash-test/` (inside the package, so `@yuzie/core` and
 * `better-sqlite3` still resolve the way they would for a real dependant) and
 * the suites spawn plain `node` against it.
 *
 * The build happens in `global-setup.ts`, before any test file runs. Building it
 * per-suite meant two `tsup` processes competing with the 2,000-card benchmark
 * for CPU, which is enough to blow its 20ms budget on a busy machine.
 */
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const BUNDLE_DIR = join(packageRoot, '.crash-test')
export const BUNDLE_ENTRY = join(BUNDLE_DIR, 'index.js')

/** Called once by the global setup. */
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
      'node22',
      '--external',
      'better-sqlite3',
    ],
    { cwd: packageRoot, stdio: 'pipe' },
  )
}

export function removeRunnableBundle(): void {
  rmSync(BUNDLE_DIR, { recursive: true, force: true })
}
