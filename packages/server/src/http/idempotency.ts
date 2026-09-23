/**
 * `Idempotency-Key` handling (SPEC.md §12.1).
 *
 * This is what makes the offline outbox safe: a queued write can be retried
 * without the client having to know whether the first attempt reached the
 * server. The key is claimed with an insert, so two concurrent retries of the
 * same write cannot both execute — the loser waits for the winner's response
 * rather than creating a second card.
 */
import { createHash } from 'node:crypto'
import { boardError } from '@yuzie/core'
import { and, eq, lt } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { idempotencyKeys } from '../db/schema.js'

export const IDEMPOTENCY_HEADER = 'idempotency-key'

export interface StoredResponse {
  readonly status: number
  readonly body: unknown
}

export interface IdempotencyOptions {
  readonly ttlMs: number
  /** How long to wait for a concurrent holder of the same key to finish. */
  readonly waitForHolderMs?: number
}

export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${JSON.stringify(body ?? null)}`)
    .digest('hex')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `handler` at most once for `(key, user)`.
 *
 * Returns the stored response on a replay, so the caller cannot tell the
 * difference apart from the work not happening twice.
 */
export async function withIdempotency(
  db: Database,
  params: {
    key: string | undefined
    userId: string
    method: string
    path: string
    body: unknown
  },
  options: IdempotencyOptions,
  handler: () => Promise<StoredResponse>,
): Promise<StoredResponse> {
  const { key, userId, method, path, body } = params
  if (key === undefined || key.length === 0) return handler()

  const fingerprint = requestFingerprint(method, path, body)

  const claimed = await db
    .insert(idempotencyKeys)
    .values({ key, userId, method, path, requestHash: fingerprint })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key })

  if (claimed.length === 0) {
    return replay(db, { key, userId, fingerprint }, options)
  }

  try {
    const response = await handler()
    await db
      .update(idempotencyKeys)
      .set({ status: response.status, response: response.body as Record<string, unknown> })
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId)))
    return response
  } catch (error) {
    // A failed attempt must not poison the key: the client is entitled to retry
    // the same write once the cause is gone.
    await db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId)))
    throw error
  }
}

async function replay(
  db: Database,
  params: { key: string; userId: string; fingerprint: string },
  options: IdempotencyOptions,
): Promise<StoredResponse> {
  const deadline = Date.now() + (options.waitForHolderMs ?? 5_000)

  for (;;) {
    const [existing] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, params.key), eq(idempotencyKeys.userId, params.userId)))

    if (existing === undefined) {
      // The holder failed and released the key; the caller may retry.
      throw boardError(
        'internal',
        'A concurrent request with this Idempotency-Key failed. Retry the request.',
      )
    }

    if (existing.requestHash !== params.fingerprint) {
      throw boardError(
        'validation_failed',
        'This Idempotency-Key was already used for a different request. Use a new key.',
        { details: { key: params.key } },
      )
    }

    if (existing.status !== null) {
      return { status: existing.status, body: existing.response }
    }

    if (Date.now() >= deadline) {
      throw boardError(
        'internal',
        'A request with this Idempotency-Key is still in flight. Retry shortly.',
      )
    }
    await sleep(25)
  }
}

/** Drop keys past their retention window (§12.1: 24 hours). */
export async function pruneIdempotencyKeys(db: Database, ttlMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMs)
  const removed = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, cutoff))
    .returning({ key: idempotencyKeys.key })
  return removed.length
}
