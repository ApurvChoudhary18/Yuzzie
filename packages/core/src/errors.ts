/**
 * Typed errors shared by the server, the SDK, and the CLI.
 *
 * One code table drives three things that SPEC.md specifies separately: the wire
 * envelope (§12.1), the process exit code (§7.4), and the suggested fix shown to a
 * user (Appendix C). Keeping them together is what stops them drifting apart.
 */

export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'card_not_found'
  | 'board_not_found'
  | 'column_not_found'
  | 'version_conflict'
  | 'validation_failed'
  | 'rate_limited'
  | 'wip_limit_exceeded'
  | 'offline_network_required'
  | 'git_precondition_failed'
  | 'internal'

export const ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'card_not_found',
  'board_not_found',
  'column_not_found',
  'version_conflict',
  'validation_failed',
  'rate_limited',
  'wip_limit_exceeded',
  'offline_network_required',
  'git_precondition_failed',
  'internal',
] as const satisfies readonly ErrorCode[]

/** SPEC.md §7.4. */
export const EXIT_OK = 0
export const EXIT_RUNTIME = 1
export const EXIT_USAGE = 2
export const EXIT_UNAUTHENTICATED = 3
export const EXIT_NOT_FOUND = 4
export const EXIT_FORBIDDEN = 5
export const EXIT_CONFLICT = 6
export const EXIT_OFFLINE = 7
export const EXIT_GIT_PRECONDITION = 8
export const EXIT_INTERRUPTED = 130

interface CodeFacts {
  /** HTTP status, or 0 for errors that never cross the wire. */
  readonly status: number
  readonly exitCode: number
  /** Appendix C "typical fix" — always actionable (Appendix E rule 5). */
  readonly fix: string
}

const CODE_TABLE: Readonly<Record<ErrorCode, CodeFacts>> = {
  unauthenticated: { status: 401, exitCode: EXIT_UNAUTHENTICATED, fix: 'Run `yuzie login`.' },
  forbidden: { status: 403, exitCode: EXIT_FORBIDDEN, fix: 'Ask a board owner for access.' },
  card_not_found: {
    status: 404,
    exitCode: EXIT_NOT_FOUND,
    fix: 'Run `yuzie list` to see card ids.',
  },
  board_not_found: {
    status: 404,
    exitCode: EXIT_NOT_FOUND,
    fix: 'Run `yuzie boards` to see your boards.',
  },
  column_not_found: {
    status: 404,
    exitCode: EXIT_NOT_FOUND,
    fix: 'Run `yuzie columns` to see column names.',
  },
  version_conflict: { status: 409, exitCode: EXIT_CONFLICT, fix: 'Re-read the card and retry.' },
  validation_failed: { status: 400, exitCode: EXIT_USAGE, fix: 'Check the command with `--help`.' },
  rate_limited: {
    status: 429,
    exitCode: EXIT_RUNTIME,
    fix: 'Wait for the Retry-After window, then retry.',
  },
  wip_limit_exceeded: {
    status: 422,
    exitCode: EXIT_RUNTIME,
    fix: 'Move a card out of that column first.',
  },
  offline_network_required: {
    status: 0,
    exitCode: EXIT_OFFLINE,
    fix: 'Reconnect, or run `yuzie sync` later.',
  },
  git_precondition_failed: {
    status: 0,
    exitCode: EXIT_GIT_PRECONDITION,
    fix: 'Commit or stash your changes, or pass --force.',
  },
  internal: {
    status: 500,
    exitCode: EXIT_RUNTIME,
    fix: 'Retry; if it persists run `yuzie doctor --bundle`.',
  },
}

export function statusForCode(code: ErrorCode): number {
  return CODE_TABLE[code].status
}

export function exitCodeForCode(code: ErrorCode): number {
  return CODE_TABLE[code].exitCode
}

export function suggestedFixForCode(code: ErrorCode): string {
  return CODE_TABLE[code].fix
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(CODE_TABLE, value)
}

/** The uniform wire envelope from SPEC.md §12.1. */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode
    readonly message: string
    readonly status: number
    readonly details?: Readonly<Record<string, unknown>>
  }
}

export interface BoardErrorOptions {
  readonly status?: number
  readonly details?: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

/** Base class for every error that crosses a Yuzie boundary. */
export class BoardError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly exitCode: number
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: ErrorCode, message: string, options: BoardErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = new.target.name
    this.code = code
    this.status = options.status ?? statusForCode(code)
    this.exitCode = exitCodeForCode(code)
    this.details = options.details ?? {}
  }

  /** What to tell the user to do next (Appendix C). */
  get suggestedFix(): string {
    return suggestedFixForCode(this.code)
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        status: this.status,
        details: this.details,
      },
    }
  }

  /** Rebuild the right subclass from a server response body. */
  static fromEnvelope(envelope: ErrorEnvelope): BoardError {
    const { code, message, status, details } = envelope.error
    const Ctor = CONSTRUCTORS[code]
    return new Ctor(code, message, { status, details })
  }
}

export class AuthenticationError extends BoardError {}
export class PermissionError extends BoardError {}
export class NotFoundError extends BoardError {}
export class ConflictError extends BoardError {}
export class ValidationError extends BoardError {}
export class RateLimitError extends BoardError {}
export class WipLimitError extends BoardError {}
export class OfflineError extends BoardError {}
export class GitPreconditionError extends BoardError {}
export class InternalError extends BoardError {}

type BoardErrorConstructor = new (
  code: ErrorCode,
  message: string,
  options?: BoardErrorOptions,
) => BoardError

const CONSTRUCTORS: Readonly<Record<ErrorCode, BoardErrorConstructor>> = {
  unauthenticated: AuthenticationError,
  forbidden: PermissionError,
  card_not_found: NotFoundError,
  board_not_found: NotFoundError,
  column_not_found: NotFoundError,
  version_conflict: ConflictError,
  validation_failed: ValidationError,
  rate_limited: RateLimitError,
  wip_limit_exceeded: WipLimitError,
  offline_network_required: OfflineError,
  git_precondition_failed: GitPreconditionError,
  internal: InternalError,
}

/** Construct the subclass that belongs to `code`. */
export function boardError(
  code: ErrorCode,
  message: string,
  options?: BoardErrorOptions,
): BoardError {
  const Ctor = CONSTRUCTORS[code]
  return new Ctor(code, message, options)
}

export function isBoardError(value: unknown): value is BoardError {
  return value instanceof BoardError
}

export function cardNotFound(number: number, boardSlug: string): NotFoundError {
  return new NotFoundError(
    'card_not_found',
    `Card #${number} does not exist on board ${boardSlug}`,
    { details: { boardSlug, number } },
  )
}

export function boardNotFound(boardSlug: string): NotFoundError {
  return new NotFoundError(
    'board_not_found',
    `Board ${boardSlug} does not exist or you are not a member`,
    {
      details: { boardSlug },
    },
  )
}

export function columnNotFound(key: string, boardSlug: string): NotFoundError {
  return new NotFoundError(
    'column_not_found',
    `Column "${key}" does not exist on board ${boardSlug}`,
    {
      details: { boardSlug, key },
    },
  )
}

export function versionConflict(number: number, expected: number, actual: number): ConflictError {
  return new ConflictError(
    'version_conflict',
    `Card #${number} changed since you read it (you have version ${expected}, the server has ${actual})`,
    { details: { number, expected, actual } },
  )
}
