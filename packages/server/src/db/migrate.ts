/**
 * SQL-first migrations (SPEC.md §10.3).
 *
 * The `.sql` files are the source of truth: they can be read, reviewed, and piped
 * straight into `psql` or `sqlite3` by a self-hoster who would rather not run a
 * migration tool at all.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'

export type Dialect = 'postgres' | 'sqlite'

export const MIGRATIONS_TABLE = '_yuzie_migrations'

export interface MigrationFile {
  readonly version: number
  readonly name: string
  readonly sql: string
}

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Migrations ship as files, so the directory has to be found whether this module
 * is running from `src/db/` under vitest or from the published `dist/`.
 */
export function migrationsDirectory(dialect: Dialect): string {
  const candidates = [
    join(here, 'migrations', dialect),
    join(here, '..', 'src', 'db', 'migrations', dialect),
    join(here, '..', '..', 'src', 'db', 'migrations', dialect),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`Could not find ${dialect} migrations. Looked in:\n  ${candidates.join('\n  ')}`)
}

export function loadMigrations(dialect: Dialect): MigrationFile[] {
  const directory = migrationsDirectory(dialect)
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const version = Number.parseInt(name.split('_')[0] ?? '', 10)
      if (!Number.isInteger(version)) {
        throw new Error(`Migration ${name} must start with a numeric version, e.g. 0001_init.sql`)
      }
      return { version, name, sql: readFileSync(join(directory, name), 'utf8') }
    })
}

/** Apply every migration that has not been applied yet. Returns the versions run. */
export async function migratePostgres(pool: Pool): Promise<number[]> {
  const client = await pool.connect()
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         version    integer PRIMARY KEY,
         name       text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    const { rows } = await client.query<{ version: number }>(
      `SELECT version FROM ${MIGRATIONS_TABLE}`,
    )
    const applied = new Set(rows.map((row) => row.version))

    const ran: number[] = []
    for (const migration of loadMigrations('postgres')) {
      if (applied.has(migration.version)) continue
      // Each migration is its own transaction: a failure leaves the database at
      // the last complete version rather than half-way through this one.
      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (version, name) VALUES ($1, $2)`, [
          migration.version,
          migration.name,
        ])
        await client.query('COMMIT')
        ran.push(migration.version)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
    return ran
  } finally {
    client.release()
  }
}

/** The minimum surface {@link migrateSqlite} needs, so better-sqlite3 stays optional. */
export interface SqliteLike {
  exec(sql: string): unknown
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }
}

export function migrateSqlite(db: SqliteLike): number[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       version    integer PRIMARY KEY,
       name       text NOT NULL,
       applied_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     )`,
  )
  const rows = db.prepare(`SELECT version FROM ${MIGRATIONS_TABLE}`).all() as {
    version: number
  }[]
  const applied = new Set(rows.map((row) => row.version))

  const ran: number[] = []
  for (const migration of loadMigrations('sqlite')) {
    if (applied.has(migration.version)) continue
    db.exec('BEGIN')
    try {
      db.exec(migration.sql)
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (version, name) VALUES (?, ?)`).run(
        migration.version,
        migration.name,
      )
      db.exec('COMMIT')
      ran.push(migration.version)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return ran
}
