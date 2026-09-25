/**
 * @yuzie/cli — the `yuzie` (and `yz`) binary.
 */
import { pathToFileURL } from 'node:url'
import { EXIT_INTERRUPTED } from './exit.js'
import { run } from './program.js'
import { VERSION } from './version.js'

export { run, VERSION }

// Only self-execute as a binary, never when imported by a test.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.on('SIGINT', () => process.exit(EXIT_INTERRUPTED))
  run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
  }).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(`yuzie: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
