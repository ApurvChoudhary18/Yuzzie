/**
 * A cache written by schema 1 opens under schema 2 with its outbox intact
 * (§18 Session 13 adds the poison-op quarantine column).
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'
import { openSqliteCache } from './sqlite-driver.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('schema 1 → 2', () => {
  it('adds the quarantine column and keeps queued writes', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-migrate-')))
    dirs.push(dir)
    const location = join(dir, 'yuzie.db')

    const old = new Database(location)
    const first = MIGRATIONS.find((migration) => migration.version === 1)
    for (const statement of first?.statements ?? []) old.exec(statement)
    old.pragma('user_version = 1')
    old
      .prepare(
        'INSERT INTO outbox (board_slug, op, idempotency_key, created_at, attempts) VALUES (?, ?, ?, ?, 0)',
      )
      .run('b', JSON.stringify({ method: 'POST', path: '/x', idempotencyKey: 'k1' }), 'k1', 1)
    old.close()

    const cache = openSqliteCache({ location })
    try {
      expect(SCHEMA_VERSION).toBe(2)
      expect(cache.outbox.list('b')).toMatchObject([
        { op: { idempotencyKey: 'k1' }, quarantinedAt: null },
      ])
      const [entry] = cache.outbox.list('b')
      cache.outbox.quarantine(entry?.id ?? 0, 'gone')
      expect(cache.outbox.quarantined('b')).toHaveLength(1)
    } finally {
      cache.close()
    }
    const reopened = new Database(location)
    expect(reopened.pragma('user_version', { simple: true })).toBe(2)
    reopened.close()
  })
})
