/**
 * Questions, in the style of Journey A (SPEC.md §6.1):
 *
 *     ? Sign in with GitHub? (Y/n) y
 *     ? Board name: (payments-api)
 *
 * Answers are read line by line from stdin, so a script can pipe them in. When
 * stdin is not a terminal the answer is echoed, so a piped transcript reads the
 * same as one typed by hand. Under `--json` or `--yes` nothing is asked: the
 * default is taken.
 */
import { createInterface, type Interface } from 'node:readline'
import { UsageError } from './exit.js'
import type { Output } from './output.js'

export interface Input {
  readonly isTTY?: boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export class Prompter {
  private reader: Interface | null = null
  private lines: AsyncIterator<string> | null = null

  constructor(
    private readonly output: Output,
    private readonly input: Input,
    /** `--yes` or `--json`: take every default without asking. */
    private readonly assumeDefaults: boolean,
  ) {}

  /** Ask for text; an empty answer (or end of input) takes the default. */
  async ask(question: string, fallback: string): Promise<string> {
    if (this.assumeDefaults) return fallback
    this.output.prompt(
      `${this.output.paint('cyan', '?')} ${question} ${this.output.paint('dim', `(${fallback})`)} `,
    )
    const answer = await this.readLine()
    this.echo(answer ?? '')
    const trimmed = (answer ?? '').trim()
    return trimmed.length === 0 ? fallback : trimmed
  }

  /** Ask yes/no; `(Y/n)` defaults to yes. */
  async confirm(question: string, fallback = true): Promise<boolean> {
    if (this.assumeDefaults) return fallback
    this.output.prompt(
      `${this.output.paint('cyan', '?')} ${question} ${this.output.paint('dim', fallback ? '(Y/n)' : '(y/N)')} `,
    )
    const answer = await this.readLine()
    this.echo(answer ?? '')
    const normalised = (answer ?? '').trim().toLowerCase()
    if (normalised.length === 0) return fallback
    return normalised === 'y' || normalised === 'yes'
  }

  /** Whether a question can be answered at all (not under `--json`/`--yes`). */
  get canAsk(): boolean {
    return !this.assumeDefaults
  }

  /**
   * Pick one of `options` by number. Callers check {@link canAsk} first: when
   * nobody can answer, guessing would act on the wrong thing.
   */
  async choose(question: string, options: readonly string[]): Promise<number> {
    this.output.prompt(`${this.output.paint('cyan', '?')} ${question}\n`)
    for (const [index, option] of options.entries()) {
      this.output.prompt(`  ${index + 1}) ${option}\n`)
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await this.ask(`Choose 1-${options.length}:`, '1')
      const index = Number(answer) - 1
      if (Number.isInteger(index) && index >= 0 && index < options.length) return index
    }
    throw new UsageError('No card chosen.', 'Use the card number instead, e.g. `yuzie card 18`.')
  }

  close(): void {
    this.reader?.close()
    this.reader = null
    this.lines = null
  }

  private async readLine(): Promise<string | undefined> {
    if (this.lines === null) {
      // One reader for the whole command, iterated rather than `question()`ed:
      // piped input can arrive all at once, and the iterator queues the lines
      // until each question is asked instead of dropping them.
      this.reader = createInterface({ input: this.input as NodeJS.ReadableStream, terminal: false })
      this.lines = this.reader[Symbol.asyncIterator]()
    }
    const next = await this.lines.next()
    return next.done === true ? undefined : next.value
  }

  private echo(answer: string): void {
    // A terminal already shows what was typed; piped input does not.
    if (this.input.isTTY === true) return
    this.output.prompt(`${answer}\n`)
  }
}
