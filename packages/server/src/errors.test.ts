import { BoardError, boardError } from '@yuzie/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toBoardError } from './http/errors.js'

describe('toBoardError', () => {
  it('passes a BoardError through unchanged', () => {
    const original = boardError('card_not_found', 'gone')
    expect(toBoardError(original)).toBe(original)
  })

  it('turns a ZodError into validation_failed naming the offending field', () => {
    const schema = z.object({ title: z.string().min(1), priority: z.number() })
    const result = schema.safeParse({ title: '', priority: 'high' })
    if (result.success) throw new Error('expected a parse failure')

    const error = toBoardError(result.error)
    expect(error.code).toBe('validation_failed')
    expect(error.status).toBe(400)
    expect(error.exitCode).toBe(2)
    expect(error.message).toContain('title')
    expect(error.message).toContain('priority')
    expect(error.details.problems).toBeDefined()
  })

  it('maps a root-level ZodError issue without a path', () => {
    const schema = z.object({ a: z.string() }).refine(() => false, { message: 'nope' })
    const result = schema.safeParse({ a: 'x' })
    if (result.success) throw new Error('expected a parse failure')
    expect(toBoardError(result.error).message).toContain('nope')
  })

  it('maps Fastify validation failures', () => {
    const error = toBoardError({ code: 'FST_ERR_VALIDATION', message: 'body must be object' })
    expect(error.code).toBe('validation_failed')
  })

  it('maps transport statuses it recognises', () => {
    expect(toBoardError({ statusCode: 429, message: 'slow down' }).code).toBe('rate_limited')
    expect(toBoardError({ statusCode: 404, message: 'nope' }).code).toBe('board_not_found')
    expect(toBoardError({ statusCode: 400, message: 'bad' }).code).toBe('validation_failed')
  })

  it('treats anything else as internal and keeps the cause', () => {
    const cause = new Error('socket hang up')
    const error = toBoardError(cause)
    expect(error).toBeInstanceOf(BoardError)
    expect(error.code).toBe('internal')
    expect(error.status).toBe(500)
    expect(error.cause).toBe(cause)
  })

  it('handles a thrown non-object', () => {
    expect(toBoardError('just a string').code).toBe('internal')
    expect(toBoardError(null).code).toBe('internal')
    expect(toBoardError(undefined).code).toBe('internal')
  })

  it('always produces the §12.1 envelope shape', () => {
    const envelope = toBoardError(new Error('boom')).toEnvelope()
    expect(envelope.error.code).toBe('internal')
    expect(envelope.error.status).toBe(500)
    expect(typeof envelope.error.message).toBe('string')
  })
})
