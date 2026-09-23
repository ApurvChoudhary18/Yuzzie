/**
 * The small amount of plumbing every route shares.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import {
  type Authenticated,
  authenticate,
  type BoardAccess,
  resolveBoard,
} from '../auth/context.js'
import type { ServerConfig } from '../config.js'
import type { Database } from '../db/client.js'
import { IDEMPOTENCY_HEADER, type StoredResponse, withIdempotency } from '../http/idempotency.js'
import type { Metrics } from '../http/metrics.js'
import type { EventBus } from '../services/event-bus.js'

export interface AppContext {
  readonly config: ServerConfig
  readonly db: Database
  readonly metrics: Metrics
  readonly bus: EventBus
}

/** Parse a request body, letting the error handler turn a ZodError into §12.1. */
export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value ?? {})
}

export async function requireAuth(
  context: AppContext,
  request: FastifyRequest,
): Promise<Authenticated> {
  return authenticate(context.db, request.headers.authorization)
}

export async function requireBoard(
  context: AppContext,
  request: FastifyRequest,
  slug: string,
): Promise<{ auth: Authenticated; access: BoardAccess }> {
  const auth = await requireAuth(context, request)
  const access = await resolveBoard(context.db, auth, slug)
  return { auth, access }
}

function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const header = request.headers[IDEMPOTENCY_HEADER]
  if (typeof header === 'string' && header.length > 0) return header
  return undefined
}

/**
 * Run a mutating handler behind the idempotency store and send its response.
 *
 * Handlers return `{ status, body }` rather than writing to the reply, because a
 * replayed request has to reproduce a response that was computed earlier.
 */
export async function mutation(
  context: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  auth: Authenticated,
  handler: (idempotencyKey: string | undefined) => Promise<StoredResponse>,
): Promise<FastifyReply> {
  const key = idempotencyKeyOf(request)
  const response = await withIdempotency(
    context.db,
    {
      key,
      userId: auth.user.id,
      method: request.method,
      path: request.url,
      body: request.body,
    },
    { ttlMs: context.config.idempotencyTtlMs },
    () => handler(key),
  )
  return reply.status(response.status).send(response.body)
}

export function ok(body: unknown): StoredResponse {
  return { status: 200, body }
}

export function created(body: unknown): StoredResponse {
  return { status: 201, body }
}
