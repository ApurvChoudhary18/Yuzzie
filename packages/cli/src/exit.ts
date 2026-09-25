/**
 * Exit codes (SPEC.md §7.4), decided in exactly one place.
 *
 * Every failure is either a `BoardError` from `@yuzie/core` — which already
 * knows its exit code — or a {@link UsageError}. Anything else is a bug, and
 * exits 1.
 */
import {
  BoardError,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  isBoardError,
} from '@yuzie/core'

export { EXIT_INTERRUPTED, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE }

/** Bad flags or arguments: exit 2, with a hint that fixes it. */
export class UsageError extends Error {
  readonly exitCode = EXIT_USAGE
  constructor(
    message: string,
    readonly fix = 'Run `yuzie --help`.',
  ) {
    super(message)
    this.name = 'UsageError'
  }
}

export function exitCodeFor(error: unknown): number {
  if (isBoardError(error)) return error.exitCode
  if (error instanceof UsageError) return error.exitCode
  return EXIT_RUNTIME
}

/** The one line of advice printed under an error. */
export function fixFor(error: unknown): string | undefined {
  if (error instanceof BoardError) return error.suggestedFix
  if (error instanceof UsageError) return error.fix
  return undefined
}
