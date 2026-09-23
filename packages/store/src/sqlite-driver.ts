/**
 * The SQLite cache driver (SPEC.md §11.3, §10.3).
 *
 * `better-sqlite3` is synchronous, which is exactly right for a CLI: no event
 * loop turn between "read the cache" and "paint the board". It is loaded through
 * `createRequire` rather than `await import` so opening the cache stays
 * synchronous, and so a missing or unbuildable native module is a catchable
 * error rather than an unhandled rejection.
 */

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type {
  Card,
  ChecklistItem,
  Column,
  ColumnSemantics,
  Comment,
  EventEnvelope,
  GitSummary,
  Priority,
} from '@yuzie/core'
import type DatabaseConstructor from 'better-sqlite3'
import type { Database, Statement } from 'better-sqlite3'
import { backoffDelayMs } from './backoff.js'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'
import { drainOutbox, matchesFilter } from './shared.js'
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

export interface SqliteCacheOptions {
  /** A file path, or `:memory:`. */
  readonly location: string
  /** Injected in tests; defaults to `Math.random`. */
  readonly jitter?: () => number
}

export class SqliteUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'better-sqlite3 is not available (it is an optional dependency). The JSON cache driver will be used instead.',
      { cause },
    )
    this.name = 'SqliteUnavailableError'
  }
}

let cachedCtor: typeof DatabaseConstructor | null = null

/** Load the native module, or throw {@link SqliteUnavailableError}. */
export function loadSqlite(): typeof DatabaseConstructor {
  if (cachedCtor !== null) return cachedCtor
  try {
    const require = createRequire(import.meta.url)
    cachedCtor = require('better-sqlite3') as typeof DatabaseConstructor
    return cachedCtor
  } catch (cause) {
    throw new SqliteUnavailableError(cause)
  }
}

export function isSqliteAvailable(): boolean {
  try {
    loadSqlite()
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface CardRow {
  number: number
  id: string
  board_id: string
  column_key: string
  rank: string
  title: string
  description: string | null
  priority: number | null
  due_at: string | null
  assignees: string
  labels: string
  watchers: string
  commits: string
  anchor: string | null
  created_by: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
  version: number
}

interface ColumnRow {
  key: string
  id: string
  board_id: string
  name: string
  rank: string
  semantics: string | null
  wip_limit: number | null
}

interface CommentRow {
  id: string
  card_number: number
  author: string
  body: string
  created_at: string
  edited_at: string | null
}

interface ChecklistRow {
  id: string
  card_number: number
  position: number
  text: string
  done_at: string | null
  done_by: string | null
}

interface GitRow {
  card_number: number
  branch: string | null
  base_branch: string | null
  commit_count: number
  files_changed: number
  additions: number
  deletions: number
  pushed: number
  pr_url: string | null
  pr_state: string | null
  last_activity_at: string | null
}

interface EventRow {
  envelope: string
}

interface SyncRow {
  board_slug: string
  last_seq: number
  synced_at: number | null
}

interface OutboxRow {
  id: number
  board_slug: string
  op: string
  idempotency_key: string
  created_at: number
  attempts: number
  last_error: string | null
  next_attempt_at: number | null
}

function parseJsonArray<T>(raw: string): T[] {
  // Most cards have no labels, no watchers and no attached commits. Recognising
  // the empty literal removes ~4 JSON.parse calls per card, which is most of the
  // cost of reading a 2,000-card board.
  if (raw === '[]' || raw.length === 0) return []
  const value: unknown = JSON.parse(raw)
  return Array.isArray(value) ? (value as T[]) : []
}

/**
 * The card column list, written once.
 *
 * `list()` reads rows in better-sqlite3's positional mode, which skips building
 * an object per row and is roughly half the cost of a 2,000-card read. The
 * indices are derived from this tuple rather than hard-coded, so the SQL and the
 * decoder cannot drift apart.
 */
/**
 * Child-row column orders, kept beside their SQL for the same reason the card
 * columns are: these are read positionally, which skips building an object per
 * row. A 2,000-card board carries several thousand child rows, so this is most
 * of what remains of the read budget.
 */
const COMMENT_COLUMNS = ['id', 'card_number', 'author', 'body', 'created_at', 'edited_at'] as const
const CHECKLIST_COLUMNS = ['id', 'card_number', 'position', 'text', 'done_at', 'done_by'] as const
const GIT_COLUMNS = [
  'card_number',
  'branch',
  'base_branch',
  'commit_count',
  'files_changed',
  'additions',
  'deletions',
  'pushed',
  'pr_url',
  'pr_state',
  'last_activity_at',
] as const

function commentFromRaw(row: readonly unknown[]): Comment {
  return {
    id: row[0] as string,
    cardNumber: row[1] as number,
    author: row[2] as string,
    body: row[3] as string,
    createdAt: row[4] as string,
    editedAt: row[5] as string | null,
  }
}

function checklistFromRaw(row: readonly unknown[]): ChecklistItem {
  return {
    id: row[0] as string,
    position: row[2] as number,
    text: row[3] as string,
    doneAt: row[4] as string | null,
    doneBy: row[5] as string | null,
  }
}

function gitFromRaw(row: readonly unknown[]): GitSummary {
  return {
    branch: row[1] as string | null,
    baseBranch: row[2] as string | null,
    commits: row[3] as number,
    filesChanged: row[4] as number,
    additions: row[5] as number,
    deletions: row[6] as number,
    pushed: (row[7] as number) !== 0,
    prUrl: row[8] as string | null,
    prState: row[9] as string | null,
    lastActivityAt: row[10] as string | null,
  }
}

const CARD_COLUMNS = [
  'number',
  'id',
  'board_id',
  'column_key',
  'rank',
  'title',
  'description',
  'priority',
  'due_at',
  'assignees',
  'labels',
  'watchers',
  'commits',
  'anchor',
  'created_by',
  'archived_at',
  'created_at',
  'updated_at',
  'version',
] as const

const CARD_SELECT = CARD_COLUMNS.join(', ')

const at = (name: (typeof CARD_COLUMNS)[number]): number => CARD_COLUMNS.indexOf(name)

const I_NUMBER = at('number')
const I_ID = at('id')
const I_BOARD_ID = at('board_id')
const I_COLUMN_KEY = at('column_key')
const I_RANK = at('rank')
const I_TITLE = at('title')
const I_DESCRIPTION = at('description')
const I_PRIORITY = at('priority')
const I_DUE_AT = at('due_at')
const I_ASSIGNEES = at('assignees')
const I_LABELS = at('labels')
const I_WATCHERS = at('watchers')
const I_COMMITS = at('commits')
const I_ANCHOR = at('anchor')
const I_CREATED_BY = at('created_by')
const I_ARCHIVED_AT = at('archived_at')
const I_CREATED_AT = at('created_at')
const I_UPDATED_AT = at('updated_at')
const I_VERSION = at('version')

/** Shared empty results; a card with no children allocates nothing. */
const EMPTY_COMMENTS: Comment[] = []
const EMPTY_CHECKLIST: ChecklistItem[] = []

function commentFromRow(row: CommentRow): Comment {
  return {
    id: row.id,
    cardNumber: row.card_number,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  }
}

function checklistFromRow(row: ChecklistRow): ChecklistItem {
  return {
    id: row.id,
    position: row.position,
    text: row.text,
    doneAt: row.done_at,
    doneBy: row.done_by,
  }
}

function gitFromRow(row: GitRow): GitSummary {
  return {
    branch: row.branch,
    baseBranch: row.base_branch,
    commits: row.commit_count,
    filesChanged: row.files_changed,
    additions: row.additions,
    deletions: row.deletions,
    pushed: row.pushed !== 0,
    prUrl: row.pr_url,
    prState: row.pr_state,
    lastActivityAt: row.last_activity_at,
  }
}

function columnFromRow(row: ColumnRow, boardId: string): Column {
  return {
    id: row.id,
    boardId: row.board_id === '' ? boardId : row.board_id,
    key: row.key,
    name: row.name,
    rank: row.rank,
    semantics: row.semantics as ColumnSemantics | null,
    wipLimit: row.wip_limit,
  }
}

function cardFromRawRow(
  row: readonly unknown[],
  comments: Comment[],
  checklist: ChecklistItem[],
  git: GitSummary | undefined,
): Card {
  const anchorJson = row[I_ANCHOR] as string | null
  return {
    id: row[I_ID] as string,
    boardId: row[I_BOARD_ID] as string,
    number: row[I_NUMBER] as number,
    column: row[I_COLUMN_KEY] as string,
    rank: row[I_RANK] as string,
    title: row[I_TITLE] as string,
    description: row[I_DESCRIPTION] as string | null,
    priority: row[I_PRIORITY] as Priority | null,
    dueAt: row[I_DUE_AT] as string | null,
    assignees: parseJsonArray<string>(row[I_ASSIGNEES] as string),
    labels: parseJsonArray<string>(row[I_LABELS] as string),
    watchers: parseJsonArray<string>(row[I_WATCHERS] as string),
    checklist,
    comments,
    commits: parseJsonArray<Card['commits'][number]>(row[I_COMMITS] as string),
    git: git ?? null,
    anchor: anchorJson === null ? null : (JSON.parse(anchorJson) as Card['anchor']),
    createdBy: row[I_CREATED_BY] as string | null,
    archivedAt: row[I_ARCHIVED_AT] as string | null,
    createdAt: row[I_CREATED_AT] as string,
    updatedAt: row[I_UPDATED_AT] as string,
    version: row[I_VERSION] as number,
  }
}

function cardFromRow(
  row: CardRow,
  comments: Comment[],
  checklist: ChecklistItem[],
  git: GitSummary | undefined,
): Card {
  return {
    id: row.id,
    boardId: row.board_id,
    number: row.number,
    column: row.column_key,
    rank: row.rank,
    title: row.title,
    description: row.description,
    priority: row.priority as Priority | null,
    dueAt: row.due_at,
    assignees: parseJsonArray<string>(row.assignees),
    labels: parseJsonArray<string>(row.labels),
    watchers: parseJsonArray<string>(row.watchers),
    checklist,
    comments,
    commits: parseJsonArray<Card['commits'][number]>(row.commits),
    git: git ?? null,
    anchor: row.anchor === null ? null : (JSON.parse(row.anchor) as Card['anchor']),
    createdBy: row.created_by,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> {
  const grouped = new Map<number, T[]>()
  for (const row of rows) {
    const id = key(row)
    const bucket = grouped.get(id)
    if (bucket === undefined) grouped.set(id, [row])
    else bucket.push(row)
  }
  return grouped
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export function openSqliteCache(options: SqliteCacheOptions): YuzieCache {
  const Ctor = loadSqlite()
  if (options.location !== ':memory:') {
    mkdirSync(dirname(options.location), { recursive: true })
  }
  const db: Database = new Ctor(options.location)
  const jitter = options.jitter ?? Math.random

  // WAL keeps readers from blocking writers and, with a rollback journal's
  // atomicity, is what makes a SIGKILL mid-write leave a readable file (§18 S2).
  if (options.location !== ':memory:') db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  migrate(db)

  const sql = {
    cardSelect: db.prepare(`SELECT ${CARD_SELECT} FROM cards WHERE board_slug = ? AND number = ?`),
    cardList: db
      .prepare(`SELECT ${CARD_SELECT} FROM cards WHERE board_slug = ? ORDER BY rank, number`)
      .raw(),
    cardListByColumn: db
      .prepare(
        `SELECT ${CARD_SELECT} FROM cards WHERE board_slug = ? AND column_key = ? ORDER BY rank, number`,
      )
      .raw(),
    cardUpsert: db.prepare(
      `INSERT INTO cards (board_slug, number, id, board_id, column_key, rank, title, description,
                          priority, due_at, assignees, labels, watchers, commits, anchor,
                          created_by, archived_at, created_at, updated_at, version)
       VALUES (@board_slug, @number, @id, @board_id, @column_key, @rank, @title, @description,
               @priority, @due_at, @assignees, @labels, @watchers, @commits, @anchor,
               @created_by, @archived_at, @created_at, @updated_at, @version)
       ON CONFLICT (board_slug, number) DO UPDATE SET
         id=excluded.id, board_id=excluded.board_id, column_key=excluded.column_key,
         rank=excluded.rank, title=excluded.title, description=excluded.description,
         priority=excluded.priority, due_at=excluded.due_at, assignees=excluded.assignees,
         labels=excluded.labels, watchers=excluded.watchers, commits=excluded.commits,
         anchor=excluded.anchor, created_by=excluded.created_by,
         archived_at=excluded.archived_at, created_at=excluded.created_at,
         updated_at=excluded.updated_at, version=excluded.version`,
    ),
    cardDelete: db.prepare('DELETE FROM cards WHERE board_slug = ? AND number = ?'),
    cardCount: db.prepare('SELECT count(*) AS n FROM cards WHERE board_slug = ?'),

    commentsAll: db
      .prepare(
        `SELECT ${COMMENT_COLUMNS.join(', ')} FROM comments WHERE board_slug = ? ORDER BY created_at, id`,
      )
      .raw(),
    commentsByCard: db.prepare(
      'SELECT id, card_number, author, body, created_at, edited_at FROM comments WHERE board_slug = ? AND card_number = ? ORDER BY created_at, id',
    ),
    commentUpsert: db.prepare(
      `INSERT INTO comments (board_slug, id, card_number, author, body, created_at, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (board_slug, id) DO UPDATE SET
         card_number=excluded.card_number, author=excluded.author, body=excluded.body,
         created_at=excluded.created_at, edited_at=excluded.edited_at`,
    ),
    commentDelete: db.prepare('DELETE FROM comments WHERE board_slug = ? AND id = ?'),
    commentDeleteByCard: db.prepare(
      'DELETE FROM comments WHERE board_slug = ? AND card_number = ?',
    ),

    checklistAll: db
      .prepare(
        `SELECT ${CHECKLIST_COLUMNS.join(', ')} FROM checklist_items WHERE board_slug = ? ORDER BY position, id`,
      )
      .raw(),
    checklistByCard: db.prepare(
      'SELECT id, card_number, position, text, done_at, done_by FROM checklist_items WHERE board_slug = ? AND card_number = ? ORDER BY position, id',
    ),
    checklistUpsert: db.prepare(
      `INSERT INTO checklist_items (board_slug, id, card_number, position, text, done_at, done_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (board_slug, id) DO UPDATE SET
         card_number=excluded.card_number, position=excluded.position, text=excluded.text,
         done_at=excluded.done_at, done_by=excluded.done_by`,
    ),
    checklistDelete: db.prepare('DELETE FROM checklist_items WHERE board_slug = ? AND id = ?'),
    checklistDeleteByCard: db.prepare(
      'DELETE FROM checklist_items WHERE board_slug = ? AND card_number = ?',
    ),

    gitAll: db
      .prepare(`SELECT ${GIT_COLUMNS.join(', ')} FROM git_links WHERE board_slug = ?`)
      .raw(),
    gitByCard: db.prepare(
      `SELECT card_number, branch, base_branch, commit_count, files_changed, additions, deletions,
              pushed, pr_url, pr_state, last_activity_at
       FROM git_links WHERE board_slug = ? AND card_number = ?`,
    ),
    gitUpsert: db.prepare(
      `INSERT INTO git_links (board_slug, card_number, branch, base_branch, commit_count,
                              files_changed, additions, deletions, pushed, pr_url, pr_state,
                              last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (board_slug, card_number) DO UPDATE SET
         branch=excluded.branch, base_branch=excluded.base_branch,
         commit_count=excluded.commit_count, files_changed=excluded.files_changed,
         additions=excluded.additions, deletions=excluded.deletions, pushed=excluded.pushed,
         pr_url=excluded.pr_url, pr_state=excluded.pr_state,
         last_activity_at=excluded.last_activity_at`,
    ),
    gitDelete: db.prepare('DELETE FROM git_links WHERE board_slug = ? AND card_number = ?'),

    columnList: db.prepare(
      'SELECT key, id, board_id, name, rank, semantics, wip_limit FROM columns WHERE board_slug = ? ORDER BY rank, key',
    ),
    columnUpsert: db.prepare(
      `INSERT INTO columns (board_slug, key, id, board_id, name, rank, semantics, wip_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (board_slug, key) DO UPDATE SET
         id=excluded.id, board_id=excluded.board_id, name=excluded.name, rank=excluded.rank,
         semantics=excluded.semantics, wip_limit=excluded.wip_limit`,
    ),
    columnDelete: db.prepare('DELETE FROM columns WHERE board_slug = ? AND key = ?'),

    eventUpsert: db.prepare(
      `INSERT INTO events (board_slug, seq, type, card_no, actor, ts, envelope)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (board_slug, seq) DO UPDATE SET
         type=excluded.type, card_no=excluded.card_no, actor=excluded.actor,
         ts=excluded.ts, envelope=excluded.envelope`,
    ),
    eventSince: db.prepare(
      'SELECT envelope FROM events WHERE board_slug = ? AND seq > ? ORDER BY seq LIMIT ?',
    ),
    eventLastSeq: db.prepare(
      'SELECT coalesce(max(seq), 0) AS seq FROM events WHERE board_slug = ?',
    ),
    eventCount: db.prepare('SELECT count(*) AS n FROM events WHERE board_slug = ?'),

    syncGet: db.prepare(
      'SELECT board_slug, last_seq, synced_at FROM sync_state WHERE board_slug = ?',
    ),
    syncAll: db.prepare(
      'SELECT board_slug, last_seq, synced_at FROM sync_state ORDER BY board_slug',
    ),
    syncUpsert: db.prepare(
      `INSERT INTO sync_state (board_slug, last_seq, synced_at) VALUES (?, ?, ?)
       ON CONFLICT (board_slug) DO UPDATE SET last_seq=excluded.last_seq, synced_at=excluded.synced_at`,
    ),

    outboxByKey: db.prepare('SELECT * FROM outbox WHERE board_slug = ? AND idempotency_key = ?'),
    outboxById: db.prepare('SELECT * FROM outbox WHERE id = ?'),
    outboxInsert: db.prepare(
      `INSERT INTO outbox (board_slug, op, idempotency_key, created_at, attempts, last_error, next_attempt_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL)`,
    ),
    outboxDelete: db.prepare('DELETE FROM outbox WHERE id = ?'),
    outboxFail: db.prepare(
      'UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?',
    ),
  }

  function allRows<T>(statement: Statement, ...params: readonly unknown[]): T[] {
    return statement.all(...params) as T[]
  }

  function oneRow<T>(statement: Statement, ...params: readonly unknown[]): T | undefined {
    return statement.get(...params) as T | undefined
  }

  function clearTable(table: string, boardSlug: string | undefined): void {
    if (boardSlug === undefined) db.prepare(`DELETE FROM ${table}`).run()
    else db.prepare(`DELETE FROM ${table} WHERE board_slug = ?`).run(boardSlug)
  }

  function outboxFromRow(row: OutboxRow): OutboxEntry {
    return {
      id: row.id,
      boardSlug: row.board_slug,
      op: JSON.parse(row.op) as OutboxOp,
      createdAt: row.created_at,
      attempts: row.attempts,
      lastError: row.last_error,
      nextAttemptAt: row.next_attempt_at,
    }
  }

  const transaction = <T>(fn: () => T): T => db.transaction(fn)()

  const cards: CardStore = {
    get(boardSlug, number) {
      const row = oneRow<CardRow>(sql.cardSelect, boardSlug, number)
      if (row === undefined) return undefined
      const comments = allRows<CommentRow>(sql.commentsByCard, boardSlug, number).map(
        commentFromRow,
      )
      const checklist = allRows<ChecklistRow>(sql.checklistByCard, boardSlug, number).map(
        checklistFromRow,
      )
      const gitRow = oneRow<GitRow>(sql.gitByCard, boardSlug, number)
      return cardFromRow(row, comments, checklist, gitRow && gitFromRow(gitRow))
    },

    list(boardSlug, filter) {
      // Four queries and a join in memory, never one query per card: the 2,000
      // card budget in §18 Session 2 is 20ms for the whole read.
      const rows =
        filter?.column === undefined
          ? allRows<unknown[]>(sql.cardList, boardSlug)
          : allRows<unknown[]>(sql.cardListByColumn, boardSlug, filter.column)

      const commentsByCard = groupBy(
        allRows<unknown[]>(sql.commentsAll, boardSlug),
        (row) => row[1] as number,
      )
      const checklistByCard = groupBy(
        allRows<unknown[]>(sql.checklistAll, boardSlug),
        (row) => row[1] as number,
      )
      const gitByCard = new Map(
        allRows<unknown[]>(sql.gitAll, boardSlug).map((row) => [row[0] as number, gitFromRaw(row)]),
      )

      const result: Card[] = []
      for (const row of rows) {
        const number = row[I_NUMBER] as number
        const commentRows = commentsByCard.get(number)
        const checklistRows = checklistByCard.get(number)
        const card = cardFromRawRow(
          row,
          commentRows === undefined ? EMPTY_COMMENTS : commentRows.map(commentFromRaw),
          checklistRows === undefined ? EMPTY_CHECKLIST : checklistRows.map(checklistFromRaw),
          gitByCard.get(number),
        )
        if (!matchesFilter(card, filter)) continue
        result.push(card)
        if (filter?.limit !== undefined && result.length >= filter.limit) break
      }
      return result
    },

    put(boardSlug, card) {
      transaction(() => {
        sql.cardUpsert.run({
          board_slug: boardSlug,
          number: card.number,
          id: card.id,
          board_id: card.boardId,
          column_key: card.column,
          rank: card.rank,
          title: card.title,
          description: card.description,
          priority: card.priority,
          due_at: card.dueAt,
          assignees: JSON.stringify(card.assignees),
          labels: JSON.stringify(card.labels),
          watchers: JSON.stringify(card.watchers),
          commits: JSON.stringify(card.commits),
          anchor: card.anchor === null ? null : JSON.stringify(card.anchor),
          created_by: card.createdBy,
          archived_at: card.archivedAt,
          created_at: card.createdAt,
          updated_at: card.updatedAt,
          version: card.version,
        })

        sql.commentDeleteByCard.run(boardSlug, card.number)
        for (const comment of card.comments) {
          sql.commentUpsert.run(
            boardSlug,
            comment.id,
            card.number,
            comment.author,
            comment.body,
            comment.createdAt,
            comment.editedAt,
          )
        }

        sql.checklistDeleteByCard.run(boardSlug, card.number)
        for (const item of card.checklist) {
          sql.checklistUpsert.run(
            boardSlug,
            item.id,
            card.number,
            item.position,
            item.text,
            item.doneAt,
            item.doneBy,
          )
        }

        if (card.git === null) sql.gitDelete.run(boardSlug, card.number)
        else putGit(boardSlug, card.number, card.git)
      })
    },

    putMany(boardSlug, list) {
      transaction(() => {
        for (const card of list) cards.put(boardSlug, card)
      })
    },

    delete(boardSlug, number) {
      return transaction(() => {
        sql.commentDeleteByCard.run(boardSlug, number)
        sql.checklistDeleteByCard.run(boardSlug, number)
        sql.gitDelete.run(boardSlug, number)
        return sql.cardDelete.run(boardSlug, number).changes > 0
      })
    },

    count(boardSlug) {
      return oneRow<{ n: number }>(sql.cardCount, boardSlug)?.n ?? 0
    },

    clear(boardSlug) {
      transaction(() => {
        for (const table of ['cards', 'comments', 'checklist_items', 'git_links']) {
          clearTable(table, boardSlug)
        }
      })
    },
  }

  function putGit(boardSlug: string, cardNumber: number, git: GitSummary): void {
    sql.gitUpsert.run(
      boardSlug,
      cardNumber,
      git.branch,
      git.baseBranch,
      git.commits,
      git.filesChanged,
      git.additions,
      git.deletions,
      git.pushed ? 1 : 0,
      git.prUrl,
      git.prState,
      git.lastActivityAt,
    )
  }

  const columns: ColumnStore = {
    list(boardSlug) {
      return allRows<ColumnRow>(sql.columnList, boardSlug).map((row) => columnFromRow(row, ''))
    },
    put(boardSlug, column) {
      sql.columnUpsert.run(
        boardSlug,
        column.key,
        column.id,
        column.boardId,
        column.name,
        column.rank,
        column.semantics,
        column.wipLimit,
      )
    },
    putMany(boardSlug, list) {
      transaction(() => {
        for (const column of list) columns.put(boardSlug, column)
      })
    },
    delete(boardSlug, key) {
      return sql.columnDelete.run(boardSlug, key).changes > 0
    },
    clear(boardSlug) {
      clearTable('columns', boardSlug)
    },
  }

  const comments: CommentStore = {
    listByCard(boardSlug, cardNumber) {
      return allRows<CommentRow>(sql.commentsByCard, boardSlug, cardNumber).map(commentFromRow)
    },
    put(boardSlug, comment) {
      sql.commentUpsert.run(
        boardSlug,
        comment.id,
        comment.cardNumber,
        comment.author,
        comment.body,
        comment.createdAt,
        comment.editedAt,
      )
    },
    delete(boardSlug, id) {
      return sql.commentDelete.run(boardSlug, id).changes > 0
    },
    clear(boardSlug) {
      clearTable('comments', boardSlug)
    },
  }

  const checklist: ChecklistStore = {
    listByCard(boardSlug, cardNumber) {
      return allRows<ChecklistRow>(sql.checklistByCard, boardSlug, cardNumber).map(checklistFromRow)
    },
    put(boardSlug, cardNumber, item) {
      sql.checklistUpsert.run(
        boardSlug,
        item.id,
        cardNumber,
        item.position,
        item.text,
        item.doneAt,
        item.doneBy,
      )
    },
    delete(boardSlug, id) {
      return sql.checklistDelete.run(boardSlug, id).changes > 0
    },
    clear(boardSlug) {
      clearTable('checklist_items', boardSlug)
    },
  }

  const git: GitStore = {
    get(boardSlug, cardNumber) {
      const row = oneRow<GitRow>(sql.gitByCard, boardSlug, cardNumber)
      return row === undefined ? undefined : gitFromRow(row)
    },
    put(boardSlug, cardNumber, summary) {
      putGit(boardSlug, cardNumber, summary)
    },
    delete(boardSlug, cardNumber) {
      return sql.gitDelete.run(boardSlug, cardNumber).changes > 0
    },
    clear(boardSlug) {
      clearTable('git_links', boardSlug)
    },
  }

  const events: EventStore = {
    append(boardSlug, event) {
      sql.eventUpsert.run(
        boardSlug,
        event.seq,
        event.type,
        event.cardNo ?? null,
        event.actor,
        event.ts,
        JSON.stringify(event),
      )
    },
    appendMany(boardSlug, list) {
      transaction(() => {
        for (const event of list) events.append(boardSlug, event)
      })
    },
    since(boardSlug, seq, limit) {
      return allRows<EventRow>(sql.eventSince, boardSlug, seq, limit ?? -1).map(
        (row) => JSON.parse(row.envelope) as EventEnvelope,
      )
    },
    lastSeq(boardSlug) {
      return oneRow<{ seq: number }>(sql.eventLastSeq, boardSlug)?.seq ?? 0
    },
    count(boardSlug) {
      return oneRow<{ n: number }>(sql.eventCount, boardSlug)?.n ?? 0
    },
    clear(boardSlug) {
      clearTable('events', boardSlug)
    },
  }

  const sync: SyncStateStore = {
    get(boardSlug) {
      const row = oneRow<SyncRow>(sql.syncGet, boardSlug)
      if (row === undefined) return { boardSlug, lastSeq: 0, syncedAt: null }
      return { boardSlug: row.board_slug, lastSeq: row.last_seq, syncedAt: row.synced_at }
    },
    set(state) {
      sql.syncUpsert.run(state.boardSlug, state.lastSeq, state.syncedAt)
    },
    advance(boardSlug, seq, syncedAt) {
      return transaction(() => {
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
      return allRows<SyncRow>(sql.syncAll).map((row) => ({
        boardSlug: row.board_slug,
        lastSeq: row.last_seq,
        syncedAt: row.synced_at,
      }))
    },
    clear(boardSlug) {
      clearTable('sync_state', boardSlug)
    },
  }

  const outbox: Outbox = {
    enqueue(boardSlug, op) {
      return transaction(() => {
        const existing = oneRow<OutboxRow>(sql.outboxByKey, boardSlug, op.idempotencyKey)
        if (existing !== undefined) return outboxFromRow(existing)
        const info = sql.outboxInsert.run(
          boardSlug,
          JSON.stringify(op),
          op.idempotencyKey,
          Date.now(),
        )
        const row = oneRow<OutboxRow>(sql.outboxById, Number(info.lastInsertRowid))
        if (row === undefined) throw new Error('Outbox insert did not produce a row')
        return outboxFromRow(row)
      })
    },

    list(boardSlug) {
      const rows =
        boardSlug === undefined
          ? allRows<OutboxRow>(db.prepare('SELECT * FROM outbox ORDER BY id'))
          : allRows<OutboxRow>(
              db.prepare('SELECT * FROM outbox WHERE board_slug = ? ORDER BY id'),
              boardSlug,
            )
      return rows.map(outboxFromRow)
    },

    due(now = Date.now(), boardSlug) {
      return outbox
        .list(boardSlug)
        .filter((entry) => entry.nextAttemptAt === null || entry.nextAttemptAt <= now)
    },

    size(boardSlug) {
      return outbox.list(boardSlug).length
    },

    async drain(handler, options = {}) {
      return drainOutbox(outbox, handler, options)
    },

    recordFailure(id, error, now = Date.now()) {
      const row = oneRow<OutboxRow>(sql.outboxById, id)
      if (row === undefined) return
      const delay = backoffDelayMs(row.attempts + 1, jitter())
      sql.outboxFail.run(error, now + delay, id)
    },

    remove(id) {
      return sql.outboxDelete.run(id).changes > 0
    },

    clear(boardSlug) {
      clearTable('outbox', boardSlug)
    },
  }

  return {
    kind: 'sqlite',
    location: options.location,
    schemaVersion: SCHEMA_VERSION,
    cards,
    columns,
    comments,
    checklist,
    git,
    events,
    sync,
    outbox,
    transaction,
    close() {
      db.close()
    },
  }
}

function migrate(db: Database): void {
  const [current] = db.pragma('user_version') as [{ user_version: number }]
  let version = current?.user_version ?? 0

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue
    db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement)
    })()
    version = migration.version
    db.pragma(`user_version = ${version}`)
  }
}
