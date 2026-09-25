/**
 * Everything the CLI prints goes through here (SPEC.md §7.3).
 *
 * Two modes:
 *
 *   - **Human**: symbols (`✓ ⚠ ✗ →`), colour when stdout is a terminal and
 *     neither `--no-color` nor `NO_COLOR` says otherwise, spinners on stderr.
 *   - **JSON** (`--json`): nothing is printed while the command runs; at the end,
 *     exactly one `{ apiVersion, kind, data, meta }` document goes to stdout.
 *     Anything a person must still see (a login code) goes to stderr.
 *
 * `--quiet` keeps only errors; `--verbose` adds debug lines on stderr.
 */
import { JSON_API_VERSION } from '@yuzie/core'
import { exitCodeFor, fixFor } from './exit.js'

export interface Stream {
  write(chunk: string): unknown
  readonly isTTY?: boolean
}

export interface OutputOptions {
  readonly json: boolean
  readonly color: boolean
  readonly quiet: boolean
  readonly verbose: boolean
  readonly stdout: Stream
  readonly stderr: Stream
  /** Interactive terminals get spinners; everything else gets plain lines. */
  readonly interactive: boolean
}

const CODES = {
  green: [32, 39],
  yellow: [33, 39],
  red: [31, 39],
  cyan: [36, 39],
  dim: [2, 22],
  bold: [1, 22],
} as const
type Tone = keyof typeof CODES

export interface Spinner {
  update(text: string): void
  stop(): void
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Decide colour the way §7.1 says: `--no-color`, `NO_COLOR`, and not a terminal all turn it off. */
export function colorEnabled(
  flag: boolean | undefined,
  env: Readonly<Record<string, string | undefined>>,
  stdout: Stream,
): boolean {
  if (flag === false) return false
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true
  return stdout.isTTY === true
}

export class Output {
  constructor(private readonly options: OutputOptions) {}

  get json(): boolean {
    return this.options.json
  }

  get interactive(): boolean {
    return this.options.interactive && !this.options.json
  }

  paint(tone: Tone, text: string): string {
    if (!this.options.color || this.options.json) return text
    const [open, close] = CODES[tone]
    return `\u001b[${open}m${text}\u001b[${close}m`
  }

  /** A plain line of human output. Suppressed under `--json` and `--quiet`. */
  line(text = ''): void {
    if (this.options.json || this.options.quiet) return
    this.options.stdout.write(`${text}\n`)
  }

  success(text: string): void {
    this.line(`${this.paint('green', '✓')} ${text}`)
  }

  warn(text: string): void {
    this.line(`${this.paint('yellow', '⚠')} ${text}`)
  }

  fail(text: string): void {
    this.line(`${this.paint('red', '✗')} ${text}`)
  }

  step(text: string): void {
    this.line(`${this.paint('cyan', '→')} ${text}`)
  }

  /** Raw text for prompts: human mode only, no newline added. */
  prompt(text: string): void {
    if (this.options.json) return
    this.options.stdout.write(text)
  }

  /**
   * Something a person must see even in `--json` mode — a login code — sent to
   * stderr there so stdout stays pure JSON.
   */
  notice(text: string): void {
    if (this.options.json) this.options.stderr.write(`${text}\n`)
    else this.line(text)
  }

  debug(text: string): void {
    if (this.options.verbose) this.options.stderr.write(`${this.paint('dim', `[debug] ${text}`)}\n`)
  }

  /** The `--json` result. Exactly one per command. */
  result(kind: string, data: unknown, meta: Record<string, unknown> = {}): void {
    if (!this.options.json) return
    this.options.stdout.write(
      `${JSON.stringify({ apiVersion: JSON_API_VERSION, kind, data, meta })}\n`,
    )
  }

  /** Report a failure: one actionable line on stderr, or an Error document under `--json`. */
  error(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const fix = fixFor(error)
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'internal'
    if (this.options.json) {
      this.options.stdout.write(
        `${JSON.stringify({
          apiVersion: JSON_API_VERSION,
          kind: 'Error',
          error: {
            code,
            message,
            exitCode: exitCodeFor(error),
            ...(fix === undefined ? {} : { fix }),
          },
        })}\n`,
      )
      return
    }
    const hint = fix === undefined || message.includes(fix) ? '' : ` ${this.paint('dim', fix)}`
    this.options.stderr.write(`${this.paint('red', '✗')} ${message}${hint}\n`)
  }

  /** A spinner on stderr in an interactive terminal; a no-op everywhere else (§18 Session 6). */
  spinner(text: string): Spinner {
    if (!this.interactive || this.options.quiet) return { update: () => {}, stop: () => {} }
    let frame = 0
    let label = text
    const render = () => {
      this.options.stderr.write(
        `\r${this.paint('cyan', FRAMES[frame % FRAMES.length] ?? '')} ${label}\u001b[K`,
      )
      frame += 1
    }
    render()
    const timer = setInterval(render, 80)
    return {
      update: (next) => {
        label = next
      },
      stop: () => {
        clearInterval(timer)
        this.options.stderr.write('\r\u001b[K')
      },
    }
  }
}
