/**
 * The local cache contract (SPEC.md §11.3).
 *
 * Two drivers implement this: SQLite via `better-sqlite3`, and a pure-JSON
 * fallback for machines where the native module will not build. `npx yuzie` must
 * never fail because of a compiler (§17), so the fallback is not a toy — it is
 * held to the identical conformance suite.
 *
 * Every method is scoped by `boardSlug` because one cache file can hold several
 * boards: `sync_state` is keyed by board slug in §11.3.
 */
import type { Card, ChecklistItem, Column, Comment, EventEnvelope, GitSummary } from '@yuzie/core'

export type CacheDriverKind = 'sqlite' | 'json'

/** Mirrors the `sync_state` table in §11.3. */
export interface SyncState {
  readonly boardSlug: string
  /** The highest event seq folded into this cache. */
  readonly lastSeq: number
  /** Epoch milliseconds of the last successful reconcile, or null if never. */
  readonly syncedAt: number | null
}

export interface CardFilter {
  readonly column?: string
  readonly assignee?: string
  readonly label?: string
  readonly limit?: number
}

export interface CardStore {
  /** The full card, with its comments, checklist and git summary reattached. */
  get(boardSlug: string, number: number): Card | undefined
  list(boardSlug: string, filter?: CardFilter): Card[]
  /** Upsert a card and replace its children. */
  put(boardSlug: string, card: Card): void
  putMany(boardSlug: string, cards: readonly Card[]): void
  delete(boardSlug: string, number: number): boolean
  count(boardSlug: string): number
  clear(boardSlug?: string): void
}

export interface ColumnStore {
  list(boardSlug: string): Column[]
  put(boardSlug: string, column: Column): void
  putMany(boardSlug: string, columns: readonly Column[]): void
  delete(boardSlug: string, key: string): boolean
  clear(boardSlug?: string): void
}

export interface CommentStore {
  listByCard(boardSlug: string, cardNumber: number): Comment[]
  put(boardSlug: string, comment: Comment): void
  delete(boardSlug: string, id: string): boolean
  clear(boardSlug?: string): void
}

export interface ChecklistStore {
  listByCard(boardSlug: string, cardNumber: number): ChecklistItem[]
  put(boardSlug: string, cardNumber: number, item: ChecklistItem): void
  delete(boardSlug: string, id: string): boolean
  clear(boardSlug?: string): void
}

export interface GitStore {
  get(boardSlug: string, cardNumber: number): GitSummary | undefined
  put(boardSlug: string, cardNumber: number, git: GitSummary): void
  delete(boardSlug: string, cardNumber: number): boolean
  clear(boardSlug?: string): void
}

export interface EventStore {
  append(boardSlug: string, event: EventEnvelope): void
  appendMany(boardSlug: string, events: readonly EventEnvelope[]): void
  /** Events strictly after `seq`, in seq order — the shape `GET /events` returns. */
  since(boardSlug: string, seq: number, limit?: number): EventEnvelope[]
  lastSeq(boardSlug: string): number
  count(boardSlug: string): number
  clear(boardSlug?: string): void
}

export interface SyncStateStore {
  /** Always returns a row; an unknown board reads as seq 0, never synced. */
  get(boardSlug: string): SyncState
  set(state: SyncState): void
  /** Move the cursor forward. Never moves it backwards. */
  advance(boardSlug: string, seq: number, syncedAt?: number): SyncState
  all(): SyncState[]
  clear(boardSlug?: string): void
}

/** A queued write, stored as JSON in the `op` column (SPEC.md §11.3). */
export interface OutboxOp {
  readonly method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  readonly path: string
  readonly body?: unknown
  /** Sent as `Idempotency-Key`; what makes retrying the queue safe (§12.1). */
  readonly idempotencyKey: string
}

export interface OutboxEntry {
  readonly id: number
  readonly boardSlug: string
  readonly op: OutboxOp
  /** Epoch milliseconds. */
  readonly createdAt: number
  readonly attempts: number
  readonly lastError: string | null
  /** Epoch milliseconds before which this entry should not be retried. */
  readonly nextAttemptAt: number | null
}

export interface DrainReport {
  readonly sent: number
  readonly failed: number
  readonly remaining: number
  /** The entry that stopped the drain, if one did. */
  readonly stoppedAt: OutboxEntry | null
}

export interface DrainOptions {
  readonly boardSlug?: string
  /** Defaults to `Date.now()`; injected so tests need no fake timers. */
  readonly now?: number
  /** Process at most this many entries. */
  readonly limit?: number
}

export interface Outbox {
  /**
   * Queue a write. An op whose idempotency key is already queued returns the
   * existing entry instead of adding a second one.
   */
  enqueue(boardSlug: string, op: OutboxOp): OutboxEntry
  list(boardSlug?: string): OutboxEntry[]
  /** Entries whose backoff has elapsed, oldest first. */
  due(now?: number, boardSlug?: string): OutboxEntry[]
  size(boardSlug?: string): number
  /**
   * Send due entries in queue order. A handler that throws records the failure
   * with backoff and stops the drain, so writes never reach the server out of
   * order. Session 13 adds the poison-op quarantine that lets it skip ahead.
   */
  drain(
    handler: (entry: OutboxEntry) => void | Promise<void>,
    options?: DrainOptions,
  ): Promise<DrainReport>
  recordFailure(id: number, error: string, now?: number): void
  remove(id: number): boolean
  clear(boardSlug?: string): void
}

/** One open cache file. */
export interface YuzieCache {
  readonly kind: CacheDriverKind
  /** Absolute path to the database file, or `:memory:`. */
  readonly location: string
  readonly cards: CardStore
  readonly columns: ColumnStore
  readonly comments: CommentStore
  readonly checklist: ChecklistStore
  readonly git: GitStore
  readonly events: EventStore
  readonly sync: SyncStateStore
  readonly outbox: Outbox
  /** Schema version applied to this file. */
  readonly schemaVersion: number
  /** All-or-nothing. A throw rolls back every write made inside `fn`. */
  transaction<T>(fn: () => T): T
  close(): void
}
