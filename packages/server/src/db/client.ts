/**
 * The Postgres connection and Drizzle handle.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { schema } from './schema.js'

export type Database = NodePgDatabase<typeof schema>
export type Pool = pg.Pool

export interface DatabaseHandle {
  readonly pool: Pool
  readonly db: Database
  close(): Promise<void>
}

export function createDatabase(databaseUrl: string, max = 10): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl, max })
  const db = drizzle(pool, { schema })
  return {
    pool,
    db,
    async close() {
      await pool.end()
    },
  }
}
