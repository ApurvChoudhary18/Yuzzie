/**
 * The JSON fallback cache driver.
 *
 * `better-sqlite3` is a native module, and SPEC.md §17 and §20 are explicit that
 * a failed native build must never break `npx yuzie`. So this driver is held to
 * the identical conformance suite as the SQLite one — it is the reason the
 * dependency can be optional at all.
 *
 * Durability comes from writing a temporary file and renaming it over the real
 * one. `rename` is atomic on POSIX, so a process killed mid-write leaves either
 * the previous complete file or the new complete file, never a half-written one.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Card, ChecklistItem, Column, Comment, EventEnvelope, GitSummary } from '@yuzie/core'
import { backoffDelayMs } from './backoff.js'
import { SCHEMA_VERSION } from './schema.js'
import { byBoardOrder, drainOutbox, matchesFilter } from './shared.js'
import type {
  CardStore,
  ChecklistStore,
  ColumnStore,
  CommentStore,
  EventStore,
  GitStore,
  Outbox,
  OutboxEntry,
  OutboxOp,
  SyncState,
  SyncStateStore,
  YuzieCache,
} from './types.js'

export interface JsonCacheOptions {
  readonly location: string
  readonly jitter?: () => number
}

export class CacheFileCorruptError extends Error {
  constructor(location: string, cause: unknown) {
    super(`The cache file at ${location} could not be read. Run \`yuzie sync --rebuild\`.`, {
      cause,
    })
    this.name = 'CacheFileCorruptError'
  }
}

interface BoardModel {
  cards: Record<string, Card>
  columns: Record<string, Column>
  events: Record<string, EventEnvelope>
  sync: SyncState
}

interface OutboxRecord {
  id: number
  boardSlug: string
  op: OutboxOp
  createdAt: number
  attempts: number
  lastError: string | null
  nextAttemptAt: number | null
}

interface CacheModel {
  schemaVersion: number
  boards: Record<string, BoardModel>
  outbox: OutboxRecord[]
  nextOutboxId: number
}

function emptyModel(): CacheModel {
  return { schemaVersion: SCHEMA_VERSION, boards: {}, outbox: [], nextOutboxId: 1 }
}

function emptyBoard(boardSlug: string): BoardModel {
  return {
    cards: {},
    columns: {},
    events: {},
    sync: { boardSlug, lastSeq: 0, syncedAt: null },
  }
}

function readModel(location: string): CacheModel {
  if (location === ':memory:') return emptyModel()
  let raw: string
  try {
    raw = readFileSync(location, 'utf8')
  } catch {
    // No file yet is the normal first run, not an error.
    return emptyModel()
  }
  try {
    const parsed = JSON.parse(raw) as CacheModel
    return {
      schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
      boards: parsed.boards ?? {},
      outbox: parsed.outbox ?? [],
      nextOutboxId: parsed.nextOutboxId ?? 1,
    }
  } catch (cause) {
    throw new CacheFileCorruptError(location, cause)
  }
}

export function openJsonCache(options: JsonCacheOptions): YuzieCache {
  const { location } = options
  const jitter = options.jitter ?? Math.random
  const model = readModel(location)
  let depth = 0
  let dirty = false

  if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true })

  function flush(): void {
    if (location === ':memory:' || !dirty) {
      dirty = false
      return
    }
    const temporary = `${location}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(model), 'utf8')
    renameSync(temporary, location)
    dirty = false
  }

  /** Every mutation goes through here, so nothing can forget to persist. */
  function write<T>(fn: () => T): T {
    depth += 1
    const snapshot = depth === 1 ? structuredClone(model) : null
    try {
      const result = fn()
      depth -= 1
      dirty = true
      if (depth === 0) flush()
      return result
    } catch (error) {
      depth -= 1
      if (snapshot !== null) {
        model.schemaVersion = snapshot.schemaVersion
        model.boards = snapshot.boards
        model.outbox = snapshot.outbox
        model.nextOutboxId = snapshot.nextOutboxId
        dirty = false
      }
      throw error
    }
  }

  function board(boardSlug: string): BoardModel {
    const existing = model.boards[boardSlug]
    if (existing !== undefined) return existing
    const created = emptyBoard(boardSlug)
    model.boards[boardSlug] = created
    return created
  }

  function peek(boardSlug: string): BoardModel | undefined {
    return model.boards[boardSlug]
  }

  function eachBoard(boardSlug: string | undefined, fn: (b: BoardModel) => void): void {
    if (boardSlug === undefined) {
      for (const value of Object.values(model.boards)) fn(value)
      return
    }
    const target = peek(boardSlug)
    if (target !== undefined) fn(target)
  }

  function mutateCard(boardSlug: string, cardNumber: number, fn: (card: Card) => Card): boolean {
    const target = peek(boardSlug)
    const card = target?.cards[String(cardNumber)]
    if (target === undefined || card === undefined) return false
    target.cards[String(cardNumber)] = fn(card)
    return true
  }

  const cards: CardStore = {
    get(boardSlug, number) {
      const card = peek(boardSlug)?.cards[String(number)]
      return card === undefined ? undefined : structuredClone(card)
    },

    list(boardSlug, filter) {
      const all = Object.values(peek(boardSlug)?.cards ?? {})
        .filter((card) => matchesFilter(card, filter))
        .sort(byBoardOrder)
      const limited = filter?.limit === undefined ? all : all.slice(0, filter.limit)
      return limited.map((card) => structuredClone(card))
    },

    put(boardSlug, card) {
      write(() => {
        board(boardSlug).cards[String(card.number)] = structuredClone(card)
      })
    },

    putMany(boardSlug, list) {
      write(() => {
        const target = board(boardSlug)
        for (const card of list) target.cards[String(card.number)] = structuredClone(card)
      })
    },

    delete(boardSlug, number) {
      return write(() => {
        const target = peek(boardSlug)
        if (target === undefined || target.cards[String(number)] === undefined) return false
        delete target.cards[String(number)]
        return true
      })
    },

    count(boardSlug) {
      return Object.keys(peek(boardSlug)?.cards ?? {}).length
    },

    clear(boardSlug) {
      write(() => {
        eachBoard(boardSlug, (target) => {
          target.cards = {}
        })
      })
    },
  }

  const columns: ColumnStore = {
    list(boardSlug) {
      return Object.values(peek(boardSlug)?.columns ?? {})
        .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.key.localeCompare(b.key)))
        .map((column) => structuredClone(column))
    },
    put(boardSlug, column) {
      write(() => {
        board(boardSlug).columns[column.key] = structuredClone(column)
      })
    },
    putMany(boardSlug, list) {
      write(() => {
        const target = board(boardSlug)
        for (const column of list) target.columns[column.key] = structuredClone(column)
      })
    },
    delete(boardSlug, key) {
      return write(() => {
        const target = peek(boardSlug)
        if (target === undefined || target.columns[key] === undefined) return false
        delete target.columns[key]
        return true
      })
    },
    clear(boardSlug) {
      write(() => {
        eachBoard(boardSlug, (target) => {
          target.columns = {}
        })
      })
    },
  }

  const comments: CommentStore = {
    listByCard(boardSlug, cardNumber) {
      const card = peek(boardSlug)?.cards[String(cardNumber)]
      return structuredClone(card?.comments ?? [])
    },
    put(boardSlug, comment) {
      write(() => {
        mutateCard(boardSlug, comment.cardNumber, (card) => {
          const rest = card.comments.filter((existing) => existing.id !== comment.id)
          const next: Comment[] = [...rest, structuredClone(comment)].sort((a, b) =>
            a.createdAt === b.createdAt
              ? a.id.localeCompare(b.id)
              : a.createdAt.localeCompare(b.createdAt),
          )
          return { ...card, comments: next }
        })
      })
    },
    delete(boardSlug, id) {
      return write(() => {
        const target = peek(boardSlug)
        if (target === undefined) return false
        for (const [key, card] of Object.entries(target.cards)) {
          if (!card.comments.some((comment) => comment.id === id)) continue
          target.cards[key] = {
            ...card,
            comments: card.comments.filter((comment) => comment.id !== id),
          }
          return true
        }
        return false
      })
    },
    clear(boardSlug) {
      write(() => {
        eachBoard(boardSlug, (target) => {
          for (const [key, card] of Object.entries(target.cards)) {
            target.cards[key] = { ...card, comments: [] }
          }
        })
      })
    },
  }

  const checklist: ChecklistStore = {
    listByCard(boardSlug, cardNumber) {
      const card = peek(boardSlug)?.cards[String(cardNumber)]
      return structuredClone(card?.checklist ?? [])
    },
    put(boardSlug, cardNumber, item) {
      write(() => {
        mutateCard(boardSlug, cardNumber, (card) => {
          const rest = card.checklist.filter((existing) => existing.id !== item.id)
          const next: ChecklistItem[] = [...rest, structuredClone(item)].sort((a, b) =>
            a.position === b.position ? a.id.localeCompare(b.id) : a.position - b.position,
          )
          return { ...card, checklist: next }
        })
      })
    },
    delete(boardSlug, id) {
      return write(() => {
        const target = peek(boardSlug)
        if (target === undefined) return false
        for (const [key, card] of Object.entries(target.cards)) {
          if (!card.checklist.some((item) => item.id === id)) continue
          target.cards[key] = {
            ...card,
            checklist: card.checklist.filter((item) => item.id !== id),
          }
          return true
        }
        return false
      })
    },
    clear(boardSlug) {
      write(() => {
        eachBoard(boardSlug, (target) => {
          for (const [key, card] of Object.entries(target.cards)) {
            target.cards[key] = { ...card, checklist: [] }
          }
        })
      })
    },
  }

  const git: GitStore = {
    get(boardSlug, cardNumber) {
      const summary = peek(boardSlug)?.cards[String(cardNumber)]?.git
      return summary === null || summary === undefined ? undefined : structuredClone(summary)
    },
    put(boardSlug, cardNumber, summary: GitSummary) {
      write(() => {
        mutateCard(boardSlug, cardNumber, (card) => ({ ...card, git: structuredClone(summary) }))
      })
    },
    delete(boardSlug, cardNumber) {
      return write(() => {
        const card = peek(boardSlug)?.cards[String(cardNumber)]
        if (card === undefined || card.git === null) return false
        return mutateCard(boardSlug, cardNumber, (existing) => ({ ...existing, git: null }))
      })
    },
    clear(boardSlug) {
      write(() => {
        eachBoard(boardSlug, (target) => {
          for (const [key, card] of Object.entries(target.cards)) {
            target.cards[key] = { ...card, git: null }
          }
        })
      })
    },
  }

  const events: EventStore = {
    append(boardSlug, event) {
      write(() => {
        board(boardSlug).events[String(event.seq)] = structuredClone(event)
      })
    },
    appendMany(boardSlug, list) {
      write(() => {
        const target = board(boardSlug)
        for (const event of list) target.events[String(event.seq)] = structuredClone(event)
      })
    },
    since(boardSlug, seq, limit) {
      const all = Object.values(peek(boardSlug)?.events ?? {})
        .filter((event) => event.seq > seq)
        .sort((a, b) => a.seq - b.seq)
      const limited = limit === undefined || limit < 0 ? all : all.slice(0, limit)
      return limited.map((event) => structuredClone(event))
    },
    lastSeq(boardSlug) {
      return Object.values(peek(boardSlug)?.events ?? {}).reduce(
        (highest, event) => Math.max(highest, event.seq),
        0,
      )
    },
    count(boardSlug) {
      return Object.keys(peek(boardSlug)?.events ?? {}).length
    },
    clear(boardSlug) {
      write(() => {
        eachBoard(boardSlug, (target) => {
          target.events = {}
        })
      })
    },
  }

  const sync: SyncStateStore = {
    get(boardSlug) {
      return structuredClone(peek(boardSlug)?.sync ?? { boardSlug, lastSeq: 0, syncedAt: null })
    },
    set(state) {
      write(() => {
        board(state.boardSlug).sync = structuredClone(state)
      })
    },
    advance(boardSlug, seq, syncedAt) {
      return write(() => {
        const current = sync.get(boardSlug)
        const next: SyncState = {
          boardSlug,
          lastSeq: Math.max(current.lastSeq, seq),
          syncedAt: syncedAt ?? current.syncedAt,
        }
        sync.set(next)
        return next
      })
    },
    all() {
      return Object.values(model.boards)
        .map((target) => structuredClone(target.sync))
        .sort((a, b) => a.boardSlug.localeCompare(b.boardSlug))
    },
    clear(boardSlug) {
      write(() => {
        eachBoard(boardSlug, (target) => {
          target.sync = { boardSlug: target.sync.boardSlug, lastSeq: 0, syncedAt: null }
        })
      })
    },
  }

  function toEntry(record: OutboxRecord): OutboxEntry {
    return structuredClone(record)
  }

  const outbox: Outbox = {
    enqueue(boardSlug, op) {
      return write(() => {
        const existing = model.outbox.find(
          (record) =>
            record.boardSlug === boardSlug && record.op.idempotencyKey === op.idempotencyKey,
        )
        if (existing !== undefined) return toEntry(existing)

        const record: OutboxRecord = {
          id: model.nextOutboxId,
          boardSlug,
          op: structuredClone(op),
          createdAt: Date.now(),
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
        }
        model.nextOutboxId += 1
        model.outbox.push(record)
        return toEntry(record)
      })
    },

    list(boardSlug) {
      return model.outbox
        .filter((record) => boardSlug === undefined || record.boardSlug === boardSlug)
        .sort((a, b) => a.id - b.id)
        .map(toEntry)
    },

    due(now = Date.now(), boardSlug) {
      return outbox
        .list(boardSlug)
        .filter((entry) => entry.nextAttemptAt === null || entry.nextAttemptAt <= now)
    },

    size(boardSlug) {
      return outbox.list(boardSlug).length
    },

    async drain(handler, drainOptions = {}) {
      return drainOutbox(outbox, handler, drainOptions)
    },

    recordFailure(id, error, now = Date.now()) {
      write(() => {
        const record = model.outbox.find((entry) => entry.id === id)
        if (record === undefined) return
        record.attempts += 1
        record.lastError = error
        record.nextAttemptAt = now + backoffDelayMs(record.attempts, jitter())
      })
    },

    remove(id) {
      return write(() => {
        const index = model.outbox.findIndex((record) => record.id === id)
        if (index === -1) return false
        model.outbox.splice(index, 1)
        return true
      })
    },

    clear(boardSlug) {
      write(() => {
        model.outbox = model.outbox.filter(
          (record) => boardSlug !== undefined && record.boardSlug !== boardSlug,
        )
      })
    },
  }

  return {
    kind: 'json',
    location,
    schemaVersion: model.schemaVersion,
    cards,
    columns,
    comments,
    checklist,
    git,
    events,
    sync,
    outbox,
    transaction: write,
    close() {
      flush()
      if (location !== ':memory:') {
        try {
          unlinkSync(`${location}.${process.pid}.tmp`)
        } catch {
          // Nothing to clean up; the rename already consumed it.
        }
      }
    },
  }
}
