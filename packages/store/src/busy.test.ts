import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openSqliteCache } from './sqlite-driver.js'

/**
 * Two processes on one cache (§18 Session 16): the board open while a command
 * runs, `yuzie feed`, a hook. A write that finds the other one mid-write waits
 * for it, as better-sqlite3 did, instead of failing with "database is locked".
 */
describe('a cache shared by two processes', () => {
  it('waits for the other writer instead of failing', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-busy-')))
    const location = join(dir, 'yuzie.db')
    openSqliteCache({ location }).close()

    // Another process takes the write lock and holds it for 400 ms.
    const holder = spawn(
      process.execPath,
      [
        '--no-warnings',
        '-e',
        `const { DatabaseSync } = require('node:sqlite')
         const db = new DatabaseSync(${JSON.stringify(location)})
         db.exec('BEGIN IMMEDIATE')
         process.stdout.write('locked')
         setTimeout(() => { db.exec('COMMIT'); db.close() }, 400)`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()))

    const started = performance.now()
    const cache = openSqliteCache({ location })
    cache.outbox.enqueue('b', { method: 'POST', path: '/x', idempotencyKey: 'k' })
    const waited = performance.now() - started
    expect(cache.outbox.size('b')).toBe(1)
    cache.close()
    expect(waited).toBeGreaterThan(200)
    await new Promise((resolve) => holder.on('close', resolve))
  })
})
