import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './__tests__/harness.js'
import { loadMigrations, MIGRATIONS_TABLE, migratePostgres, migrateSqlite } from './db/migrate.js'

const require = createRequire(import.meta.url)

interface SqliteDatabase {
  exec(sql: string): unknown
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }
  close(): void
}

function openSqlite(): SqliteDatabase {
  const Database = require('better-sqlite3') as new (path: string) => SqliteDatabase
  return new Database(':memory:')
}

describe('migrations', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startTestServer()
  })

  afterAll(async () => {
    await server?.close()
  })

  it('ships the same versions for both dialects', () => {
    const postgres = loadMigrations('postgres')
    const sqlite = loadMigrations('sqlite')

    expect(postgres.length).toBeGreaterThan(0)
    expect(sqlite.map((file) => file.version)).toEqual(postgres.map((file) => file.version))
  })

  it('is idempotent: re-running applies nothing', async () => {
    const ran = await migratePostgres(server.handle.pool)
    expect(ran).toEqual([])

    const { rows } = await server.handle.pool.query<{ version: number }>(
      `SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version`,
    )
    expect(rows.map((row) => row.version)).toEqual(loadMigrations('postgres').map((f) => f.version))
  })

  it('applies the SQLite variant cleanly', () => {
    const db = openSqlite()
    try {
      const ran = migrateSqlite(db)
      expect(ran).toEqual(loadMigrations('sqlite').map((file) => file.version))
      // Second run is a no-op, same as Postgres.
      expect(migrateSqlite(db)).toEqual([])
    } finally {
      db.close()
    }
  })

  it('creates the same tables and columns in both dialects', async () => {
    const { rows } = await server.handle.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`,
    )

    const postgresShape = new Map<string, string[]>()
    for (const row of rows) {
      if (row.table_name === MIGRATIONS_TABLE) continue
      const columns = postgresShape.get(row.table_name) ?? []
      columns.push(row.column_name)
      postgresShape.set(row.table_name, columns)
    }

    const db = openSqlite()
    try {
      migrateSqlite(db)
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]

      const sqliteShape = new Map<string, string[]>()
      for (const { name } of tables) {
        if (name === MIGRATIONS_TABLE) continue
        const info = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]
        sqliteShape.set(
          name,
          info.map((column) => column.name),
        )
      }

      // Self-hosting on SQLite has to mean the same data model, not a subset.
      expect([...sqliteShape.keys()].sort()).toEqual([...postgresShape.keys()].sort())
      for (const [table, columns] of postgresShape) {
        expect(sqliteShape.get(table), `columns of ${table}`).toEqual(columns)
      }
    } finally {
      db.close()
    }
  })

  it('creates every table §11.2 names', async () => {
    const { rows } = await server.handle.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    )
    const tables = new Set(rows.map((row) => row.table_name))

    for (const table of [
      'users',
      'workspaces',
      'boards',
      'memberships',
      'columns',
      'cards',
      'card_assignees',
      'labels',
      'card_labels',
      'comments',
      'checklist_items',
      'watchers',
      'git_links',
      'commits',
      'anchors',
      'events',
      'api_tokens',
    ]) {
      expect(tables, table).toContain(table)
    }
  })

  it('enforces the constraints the data model relies on', async () => {
    const pool = server.handle.pool

    // Build the rows this test needs rather than relying on what other suites
    // happened to leave behind.
    const suffix = Math.random().toString(36).slice(2, 10)
    const { rows: seeded } = await pool.query<{
      board_id: string
      column_id: string
      user_id: string
    }>(
      `WITH ws AS (
         INSERT INTO workspaces (slug, name) VALUES ($1, $1) RETURNING id
       ), b AS (
         INSERT INTO boards (workspace_id, slug, name)
         SELECT id, $1, $1 FROM ws RETURNING id
       ), c AS (
         INSERT INTO columns (board_id, key, name, rank)
         SELECT id, 'todo', 'Todo', 'V' FROM b RETURNING id, board_id
       ), u AS (
         INSERT INTO users (handle) VALUES ($1) RETURNING id
       ), card AS (
         INSERT INTO cards (board_id, number, column_id, rank, title)
         SELECT c.board_id, 1, c.id, 'V', 'seed' FROM c RETURNING board_id
       ), ev AS (
         INSERT INTO events (board_id, seq, id, type, payload)
         SELECT board_id, 1, gen_random_uuid(), 'card.created', '{}'::jsonb FROM card
         RETURNING board_id
       ), tok AS (
         INSERT INTO api_tokens (user_id, name, token_hash, role)
         SELECT id, 'seed', $2, 'owner' FROM u RETURNING user_id
       )
       SELECT c.board_id, c.id AS column_id, u.id AS user_id FROM c, u`,
      [`constraints-${suffix}`, `hash-${suffix}`],
    )

    const seed = seeded[0]
    if (seed === undefined) throw new Error('could not seed constraint fixtures')

    // (board_id, number) is unique: the "#18" a user types means one card.
    await expect(
      pool.query(
        `INSERT INTO cards (board_id, number, column_id, rank, title)
         VALUES ($1, 1, $2, 'W', 'duplicate number')`,
        [seed.board_id, seed.column_id],
      ),
    ).rejects.toThrow(/duplicate key|unique/i)

    // (board_id, seq) is unique: two events cannot share a sequence number.
    await expect(
      pool.query(
        `INSERT INTO events (board_id, seq, id, type, payload)
         VALUES ($1, 1, gen_random_uuid(), 'card.moved', '{}'::jsonb)`,
        [seed.board_id],
      ),
    ).rejects.toThrow(/duplicate key|unique/i)

    // A token hash is unique, so two tokens cannot collide into one identity.
    await expect(
      pool.query(
        `INSERT INTO api_tokens (user_id, name, token_hash, role)
         VALUES ($1, 'clone', $2, 'owner')`,
        [seed.user_id, `hash-${suffix}`],
      ),
    ).rejects.toThrow(/duplicate key|unique/i)

    // A card must live in a column that exists.
    await expect(
      pool.query(
        `INSERT INTO cards (board_id, number, column_id, rank, title)
         VALUES ($1, 99, gen_random_uuid(), 'X', 'orphan')`,
        [seed.board_id],
      ),
    ).rejects.toThrow(/foreign key/i)
  })
})
