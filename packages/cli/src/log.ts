/**
 * The client log (SPEC.md §15): structured JSON lines in
 * `~/.yuzie/logs/yuzie.log`, rotated at 5 MB (three old files kept), and read
 * back by `yuzie doctor --bundle`. `--verbose` mirrors to stderr (Output does
 * that); this is the record that survives the terminal.
 *
 * Logging never fails a command: a read-only or full disk just means no log.
 * Every line is redacted before it is written. `YUZIE_LOG=off` turns it off.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { redact } from './redact.js'

export const LOG_MAX_BYTES = 5 * 1024 * 1024
export const LOG_KEEP = 3

type Env = Readonly<Record<string, string | undefined>>

export function logPath(home: string): string {
  return join(home, '.yuzie', 'logs', 'yuzie.log')
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void
}

/** `yuzie.log` → `.1` → `.2` → `.3`, dropping the oldest. */
function rotate(path: string, keep: number): void {
  for (let index = keep; index >= 1; index -= 1) {
    const from = index === 1 ? path : `${path}.${index - 1}`
    try {
      renameSync(from, `${path}.${index}`)
    } catch {
      // Nothing to move at this position.
    }
  }
}

export function createLogger(
  home: string,
  env: Env,
  options: { maxBytes?: number; keep?: number; now?: () => Date } = {},
): Logger {
  if (env.YUZIE_LOG === 'off') return { log() {} }
  const path = logPath(home)
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES
  const keep = options.keep ?? LOG_KEEP
  const now = options.now ?? (() => new Date())
  let ready = false
  return {
    log(level, message, fields = {}) {
      try {
        if (!ready) {
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
          ready = true
        }
        const line = redact(
          JSON.stringify({ ts: now().toISOString(), level, pid: process.pid, message, ...fields }),
          home,
        )
        let size = 0
        try {
          size = statSync(path).size
        } catch {
          // No log yet.
        }
        if (size + line.length + 1 > maxBytes) rotate(path, keep)
        appendFileSync(path, `${line}\n`, { mode: 0o600 })
      } catch {
        // A log that cannot be written is not a reason to fail the command.
      }
    },
  }
}

/** The last `count` lines of the log, oldest first, reaching into the rotated file if needed. */
export function tailLog(home: string, count: number): string[] {
  const path = logPath(home)
  const read = (file: string) => {
    try {
      return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  const current = read(path)
  if (current.length >= count) return current.slice(-count)
  return [...read(`${path}.1`), ...current].slice(-count)
}
