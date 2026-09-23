import { describe, expect, it } from 'vitest'
import {
  AuthenticationError,
  BoardError,
  boardError,
  boardNotFound,
  ConflictError,
  cardNotFound,
  columnNotFound,
  ERROR_CODES,
  type ErrorCode,
  type ErrorEnvelope,
  exitCodeForCode,
  GitPreconditionError,
  InternalError,
  isBoardError,
  isErrorCode,
  NotFoundError,
  OfflineError,
  PermissionError,
  RateLimitError,
  statusForCode,
  suggestedFixForCode,
  ValidationError,
  versionConflict,
  WipLimitError,
} from './errors.js'

/** SPEC.md Appendix C, transcribed. */
const APPENDIX_C: ReadonlyArray<[ErrorCode, number]> = [
  ['unauthenticated', 3],
  ['forbidden', 5],
  ['card_not_found', 4],
  ['board_not_found', 4],
  ['column_not_found', 4],
  ['version_conflict', 6],
  ['validation_failed', 2],
  ['wip_limit_exceeded', 1],
  ['rate_limited', 1],
  ['offline_network_required', 7],
  ['git_precondition_failed', 8],
]

describe('the error code table', () => {
  it('matches the exit codes in Appendix C', () => {
    for (const [code, exitCode] of APPENDIX_C) {
      expect(exitCodeForCode(code)).toBe(exitCode)
    }
  })

  it('covers every code in §12.1 plus the two client-side codes', () => {
    expect(ERROR_CODES).toHaveLength(12)
    for (const [code] of APPENDIX_C) {
      expect(ERROR_CODES).toContain(code)
    }
    expect(ERROR_CODES).toContain('internal')
  })

  it('maps codes to the HTTP statuses the server returns', () => {
    expect(statusForCode('unauthenticated')).toBe(401)
    expect(statusForCode('forbidden')).toBe(403)
    expect(statusForCode('card_not_found')).toBe(404)
    expect(statusForCode('version_conflict')).toBe(409)
    expect(statusForCode('validation_failed')).toBe(400)
    expect(statusForCode('rate_limited')).toBe(429)
    expect(statusForCode('internal')).toBe(500)
  })

  it('gives the two client-side codes no HTTP status', () => {
    expect(statusForCode('offline_network_required')).toBe(0)
    expect(statusForCode('git_precondition_failed')).toBe(0)
  })

  it('offers an actionable fix for every code (Appendix E rule 5)', () => {
    for (const code of ERROR_CODES) {
      const fix = suggestedFixForCode(code)
      expect(fix.length).toBeGreaterThan(0)
      expect(fix).toMatch(/[.!]$/)
    }
  })

  it('recognises its own codes and nothing else', () => {
    expect(isErrorCode('card_not_found')).toBe(true)
    expect(isErrorCode('nope')).toBe(false)
    expect(isErrorCode(404)).toBe(false)
    expect(isErrorCode(undefined)).toBe(false)
  })
})

describe('boardError', () => {
  const expected: ReadonlyArray<[ErrorCode, new (...args: never[]) => BoardError]> = [
    ['unauthenticated', AuthenticationError],
    ['forbidden', PermissionError],
    ['card_not_found', NotFoundError],
    ['board_not_found', NotFoundError],
    ['column_not_found', NotFoundError],
    ['version_conflict', ConflictError],
    ['validation_failed', ValidationError],
    ['rate_limited', RateLimitError],
    ['wip_limit_exceeded', WipLimitError],
    ['offline_network_required', OfflineError],
    ['git_precondition_failed', GitPreconditionError],
    ['internal', InternalError],
  ]

  it('constructs the subclass that belongs to each code', () => {
    for (const [code, Ctor] of expected) {
      const error = boardError(code, 'boom')
      expect(error).toBeInstanceOf(Ctor)
      expect(error).toBeInstanceOf(BoardError)
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe(Ctor.name)
    }
  })

  it('carries the exit code and suggested fix for its code', () => {
    const error = boardError('git_precondition_failed', 'Working tree is dirty')
    expect(error.exitCode).toBe(8)
    expect(error.suggestedFix).toMatch(/--force/)
  })

  it('keeps a cause when one is supplied', () => {
    const cause = new Error('socket hang up')
    const error = boardError('internal', 'Request failed', { cause })
    expect(error.cause).toBe(cause)
  })

  it('defaults details to an empty object rather than undefined', () => {
    expect(boardError('internal', 'boom').details).toEqual({})
  })
})

describe('the wire envelope', () => {
  it('round-trips through toEnvelope and fromEnvelope, keeping the subclass', () => {
    const original = cardNotFound(99, 'payments-api')
    const restored = BoardError.fromEnvelope(original.toEnvelope())

    expect(restored).toBeInstanceOf(NotFoundError)
    expect(restored.code).toBe('card_not_found')
    expect(restored.message).toBe(original.message)
    expect(restored.status).toBe(404)
    expect(restored.details).toEqual({ boardSlug: 'payments-api', number: 99 })
  })

  it('serialises exactly the shape in §12.1', () => {
    const envelope: ErrorEnvelope = cardNotFound(99, 'payments-api').toEnvelope()
    expect(envelope).toEqual({
      error: {
        code: 'card_not_found',
        message: 'Card #99 does not exist on board payments-api',
        status: 404,
        details: { boardSlug: 'payments-api', number: 99 },
      },
    })
  })

  it('honours a status the server sent that differs from the default', () => {
    const restored = BoardError.fromEnvelope({
      error: { code: 'internal', message: 'Upstream failed', status: 502 },
    })
    expect(restored.status).toBe(502)
    expect(restored.exitCode).toBe(1)
  })
})

describe('the named constructors', () => {
  it('name the board and the card in the message, not just the code', () => {
    expect(cardNotFound(99, 'payments-api').message).toContain('#99')
    expect(boardNotFound('nope').message).toContain('nope')
    expect(columnNotFound('shipped', 'payments-api').message).toContain('shipped')
  })

  it('explains a version conflict in terms the user can act on', () => {
    const error = versionConflict(18, 3, 5)
    expect(error).toBeInstanceOf(ConflictError)
    expect(error.exitCode).toBe(6)
    expect(error.message).toContain('version 3')
    expect(error.message).toContain('has 5')
    expect(error.details).toEqual({ number: 18, expected: 3, actual: 5 })
  })
})

describe('isBoardError', () => {
  it('distinguishes our errors from ordinary ones', () => {
    expect(isBoardError(cardNotFound(1, 'b'))).toBe(true)
    expect(isBoardError(new Error('nope'))).toBe(false)
    expect(isBoardError(null)).toBe(false)
    expect(isBoardError('card_not_found')).toBe(false)
  })
})
