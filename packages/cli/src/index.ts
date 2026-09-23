/**
 * @yuzie/cli — the `yuzie` binary.
 *
 * Session 0 deliberately ships no product logic: the commander program, config
 * layering, and command surface arrive in Session 6 (SPEC.md §18). All this does
 * is prove the toolchain produces a working executable.
 */
import { pathToFileURL } from 'node:url'
import { VERSION } from './version.js'

export { VERSION }

export function run(argv: readonly string[]): number {
  if (argv.includes('--version') || argv.includes('-V')) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  process.stdout.write(
    [
      'yuzie · collaborative git-aware kanban',
      '',
      `  version ${VERSION}`,
      '',
      '  The command surface is not implemented yet (SPEC.md §18, Session 6).',
      '',
    ].join('\n'),
  )
  return 0
}

// Only self-execute as a binary, never when imported by a test.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exit(run(process.argv.slice(2)))
}
