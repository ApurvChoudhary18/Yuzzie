/**
 * What the SDK needs from a local cache, described structurally.
 *
 * `@yuzie/store`'s `YuzieCache` satisfies this (a type test holds it to that),
 * but the SDK never imports the store at runtime: the store opens SQLite files,
 * and the SDK's core entry must load in a browser. The CLI passes a store cache
 * in; a browser passes nothing and gets memory-only state and queue.
 */
import type { Card, Column } from '@yuzie/core'

export interface SyncStateLike {
  readonly boardSlug: string
  readonly lastSeq: number
  readonly syncedAt: number | null
}

/** A queued write. `ifMatch` rides along so an offline edit still conflicts correctly. */
export interface OutboxOpLike {
  readonly method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  readonly path: string
  readonly body?: unknown
  readonly idempotencyKey: string
  readonly ifMatch?: number
}

export interface OutboxEntryLike {
  readonly id: number
  readonly boardSlug: string
  readonly op: OutboxOpLike
  readonly createdAt: number
  readonly attempts: number
  readonly lastError: string | null
}

export interface OutboxLike {
  enqueue(boardSlug: string, op: OutboxOpLike): OutboxEntryLike
  list(boardSlug?: string): OutboxEntryLike[]
  size(boardSlug?: string): number
  remove(id: number): boolean
  recordFailure(id: number, error: string, now?: number): void
}

export interface CacheLike {
  readonly cards: {
    list(boardSlug: string): Card[]
    putMany(boardSlug: string, cards: readonly Card[]): void
    put(boardSlug: string, card: Card): void
    delete(boardSlug: string, number: number): boolean
    clear(boardSlug?: string): void
  }
  readonly columns: {
    list(boardSlug: string): Column[]
    putMany(boardSlug: string, columns: readonly Column[]): void
    clear(boardSlug?: string): void
  }
  readonly sync: {
    get(boardSlug: string): SyncStateLike
    set(state: SyncStateLike): void
  }
  readonly outbox: OutboxLike
  transaction<T>(fn: () => T): T
}

/** The queue used when no cache is supplied. Lost on reload, which a browser tab accepts. */
export function createMemoryOutbox(now: () => number = Date.now): OutboxLike {
  let entries: OutboxEntryLike[] = []
  let nextId = 1

  return {
    enqueue(boardSlug, op) {
      const existing = entries.find((entry) => entry.op.idempotencyKey === op.idempotencyKey)
      if (existing !== undefined) return existing
      const entry: OutboxEntryLike = {
        id: nextId,
        boardSlug,
        op,
        createdAt: now(),
        attempts: 0,
        lastError: null,
      }
      nextId += 1
      entries.push(entry)
      return entry
    },
    list(boardSlug) {
      return entries.filter((entry) => boardSlug === undefined || entry.boardSlug === boardSlug)
    },
    size(boardSlug) {
      return this.list(boardSlug).length
    },
    remove(id) {
      const before = entries.length
      entries = entries.filter((entry) => entry.id !== id)
      return entries.length < before
    },
    recordFailure(id, error) {
      entries = entries.map((entry) =>
        entry.id === id ? { ...entry, attempts: entry.attempts + 1, lastError: error } : entry,
      )
    },
  }
}
