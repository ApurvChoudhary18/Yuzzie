/**
 * @yuzie/cli — what the `yuzie` (and `yz`) binary runs, loaded by index.ts
 * once the compile cache is on.
 */
import { homedir } from 'node:os'
import { EXIT_INTERRUPTED } from './exit.js'
import { createLogger } from './log.js'
import { run } from './program.js'
import { screen, supervisor } from './screen.js'
import { VERSION } from './version.js'

export { run, VERSION }

/** Exit codes for signals: 128 + the signal number, as shells report them. */
const SIGNAL_EXIT = { SIGINT: EXIT_INTERRUPTED, SIGTERM: 143, SIGHUP: 129 } as const

/** The binary: run with the process's own argv and streams, then exit with the code. */
export function main(): void {
  // Interrupted or terminated: stop, quietly, with the conventional code. A
  // board on screen has its own handler that restores the terminal first.
  for (const [signal, code] of Object.entries(SIGNAL_EXIT)) {
    process.on(signal, () => {
      if (!screen.active && !supervisor.active) process.exit(code)
    })
  }
  // `yuzie list | head`: when the reader goes away, stop quietly, as `git log`
  // does — never a stack trace about a broken pipe.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0)
      throw error
    })
  }
  process.on('uncaughtException', crash)
  process.on('unhandledRejection', crash)

  run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
  }).then(
    (code) => exitWhenFlushed(code),
    (error: unknown) => crash(error),
  )
}

/**
 * A bug (§18 Session 16): the terminal is given back, the user gets one line
 * and what to do about it, the stack goes to the log — and to the screen only
 * with --verbose.
 */
function crash(error: unknown): void {
  try {
    screen.restore()
  } catch {
    // Restoring is best effort; the message matters more.
  }
  const message = error instanceof Error ? error.message : String(error)
  const env = process.env
  const home = env.HOME ?? homedir()
  createLogger(home, env).log('error', 'crash', {
    version: VERSION,
    argv: process.argv.slice(2),
    error: message,
    stack: error instanceof Error ? error.stack : undefined,
  })
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v')
  process.stderr.write(
    [
      `✗ yuzie hit an unexpected error: ${message}`,
      '  This is a bug. The details are in ~/.yuzie/logs/yuzie.log;',
      '  `yuzie doctor --bundle` writes a redacted report to attach to an issue.',
      ...(verbose && error instanceof Error && error.stack !== undefined ? ['', error.stack] : []),
      '',
    ].join('\n'),
  )
  exitWhenFlushed(1)
}

/**
 * The command is finished: once everything written has reached stdout and
 * stderr, exit — rather than waiting for idle HTTP connections and timers to
 * wind down, which kept a one-shot command alive ~20 ms longer (§18 Session 16).
 */
function exitWhenFlushed(code: number): void {
  process.exitCode = code
  let pending = 2
  const flushed = () => {
    pending -= 1
    if (pending === 0) process.exit(code)
  }
  process.stdout.write('', flushed)
  process.stderr.write('', flushed)
}
