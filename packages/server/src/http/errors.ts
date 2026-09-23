/**
 * The uniform error envelope (SPEC.md §12.1).
 *
 * Every failure leaves this server in the same shape, so the SDK can map it back
 * to a typed error class without special cases per route.
 */
import { BoardError, boardError, type ErrorEnvelope } from '@yuzie/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'

function fromZodError(error: ZodError): BoardError {
  const problems = error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }))
  const summary = problems
    .map((problem) =>
      problem.path === '' ? problem.message : `${problem.path}: ${problem.message}`,
    )
    .join('; ')
  return boardError('validation_failed', `Request body is not valid: ${summary}`, {
    details: { problems },
  })
}

/** Translate anything thrown by a route into a {@link BoardError}. */
export function toBoardError(error: unknown): BoardError {
  if (error instanceof BoardError) return error
  if (error instanceof ZodError) return fromZodError(error)

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { statusCode?: number; code?: string; message?: string }
    if (candidate.code === 'FST_ERR_VALIDATION' || candidate.statusCode === 400) {
      return boardError('validation_failed', candidate.message ?? 'Request is not valid')
    }
    if (candidate.statusCode === 429) {
      return boardError('rate_limited', candidate.message ?? 'Too many requests')
    }
    if (candidate.statusCode === 404) {
      return boardError('board_not_found', candidate.message ?? 'No such route')
    }
  }

  return boardError('internal', 'The server failed to handle this request', { cause: error })
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const boardErr = toBoardError(error)

    // Only genuine server faults deserve a stack trace in the log; a 404 or a
    // failed validation is normal traffic.
    if (boardErr.code === 'internal') {
      request.log.error({ err: error }, 'unhandled error')
    } else {
      request.log.debug({ code: boardErr.code, message: boardErr.message }, 'request rejected')
    }

    const envelope: ErrorEnvelope = boardErr.toEnvelope()
    return reply.status(boardErr.status === 0 ? 500 : boardErr.status).send(envelope)
  })

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const envelope: ErrorEnvelope = boardError(
      'board_not_found',
      `No route for ${request.method} ${request.url}`,
      { status: 404 },
    ).toEnvelope()
    return reply.status(404).send(envelope)
  })
}
