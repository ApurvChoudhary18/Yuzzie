/**
 * SQLite from Node itself (`node:sqlite`, Node 22.13+), shaped like the small
 * part of better-sqlite3 the cache driver uses (SPEC.md §18 Session 16).
 *
 * Built in means no native module to download or compile: the CLI installs in a
 * fraction of the size, and `npx yuzie` never waits on a build. It is
 * synchronous, like better-sqlite3, so opening the cache and painting the board
 * still happen without an event-loop turn in between.
 *
 * Loaded through `createRequire` so opening stays synchronous and a Node without
 * it is a catchable error (the JSON driver takes over). Node 22 marks the module
 * experimental and says so on stderr; that one warning is swallowed, because a
 * person running `yuzie list` did not ask about it.
 */
import { createRequire } from 'node:module'

export interface RunResult {
  readonly changes: number | bigint
  readonly lastInsertRowid: number | bigint
}

export interface Statement {
  run(...params: readonly unknown[]): RunResult
  get(...params: readonly unknown[]): unknown
  all(...params: readonly unknown[]): unknown[]
  /** Rows as arrays in column order, not objects: cheaper for big reads. */
  raw(): Statement
}

export interface Database {
  prepare(sql: string): Statement
  exec(sql: string): void
  /** `pragma('user_version')` reads; `pragma('journal_mode = WAL')` sets. */
  pragma(source: string): unknown[]
  /** Wrap `fn` in a transaction; nested calls become savepoints. */
  transaction<T>(fn: () => T): () => T
  close(): void
}

interface NodeStatement {
  run(...params: unknown[]): RunResult
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  setReturnArrays(enabled: boolean): void
}

interface NodeDatabase {
  prepare(sql: string): NodeStatement
  exec(sql: string): void
  close(): void
  readonly isTransaction: boolean
}

type NodeSqlite = {
  DatabaseSync: new (location: string, options?: { timeout?: number }) => NodeDatabase
}

/**
 * How long a write waits for another process's (the board, `yuzie feed`, a
 * hook) — better-sqlite3's default, which node:sqlite does not have: without it
 * a second process fails at once with "database is locked".
 */
export const BUSY_TIMEOUT_MS = 5_000

let loaded: NodeSqlite | null = null

/** `node:sqlite`, without its experimental-feature warning. Throws when this Node has none. */
export function loadNodeSqlite(): NodeSqlite {
  if (loaded !== null) return loaded
  const emit = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string })?.type
    if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    loaded = createRequire(import.meta.url)('node:sqlite') as NodeSqlite
    return loaded
  } finally {
    process.emitWarning = emit
  }
}

function wrap(statement: NodeStatement): Statement {
  const wrapped: Statement = {
    run: (...params) => statement.run(...params),
    get: (...params) => statement.get(...params),
    all: (...params) => statement.all(...params),
    raw: () => {
      statement.setReturnArrays(true)
      return wrapped
    },
  }
  return wrapped
}

export function openNodeSqlite(location: string): Database {
  const { DatabaseSync } = loadNodeSqlite()
  const db = new DatabaseSync(location, { timeout: BUSY_TIMEOUT_MS })
  let depth = 0
  return {
    prepare: (sql) => wrap(db.prepare(sql)),
    exec: (sql) => db.exec(sql),
    pragma(source) {
      const statement = db.prepare(`PRAGMA ${source}`)
      if (!source.includes('=')) return statement.all()
      statement.run()
      return []
    },
    transaction<T>(fn: () => T): () => T {
      return () => {
        const savepoint = depth > 0 || db.isTransaction ? `yuzie_${depth}` : null
        // IMMEDIATE: take the write lock at the start, where the busy timeout
        // applies. A deferred BEGIN that reads, then writes, cannot wait for
        // another process's lock — SQLite refuses the upgrade at once.
        db.exec(savepoint === null ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
        depth += 1
        try {
          const result = fn()
          db.exec(savepoint === null ? 'COMMIT' : `RELEASE ${savepoint}`)
          return result
        } catch (error) {
          if (savepoint === null) {
            if (db.isTransaction) db.exec('ROLLBACK')
          } else {
            db.exec(`ROLLBACK TO ${savepoint}`)
            db.exec(`RELEASE ${savepoint}`)
          }
          throw error
        } finally {
          depth -= 1
        }
      }
    },
    close: () => db.close(),
  }
}
