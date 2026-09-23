import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BOARD, makeCard } from './__fixtures__/cards.js'
import { CACHE_DIR_ENV } from './location.js'
import { CACHE_DRIVER_ENV, defaultDriverKind, openCache } from './open.js'
import { isSqliteAvailable, SqliteUnavailableError } from './sqlite-driver.js'

describe('openCache', () => {
  let workspace: string

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'yuzie-open-'))
  })

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('opens the driver it is told to', () => {
    for (const driver of ['sqlite', 'json'] as const) {
      const cache = openCache({ boardSlug: BOARD, location: ':memory:', driver })
      try {
        expect(cache.kind).toBe(driver)
      } finally {
        cache.close()
      }
    }
  })

  it('reads the driver from the environment', () => {
    const cache = openCache({
      boardSlug: BOARD,
      location: ':memory:',
      env: { [CACHE_DRIVER_ENV]: 'json' },
    })
    try {
      expect(cache.kind).toBe('json')
    } finally {
      cache.close()
    }
  })

  it('ignores an unrecognised driver name and decides for itself', () => {
    const cache = openCache({
      boardSlug: BOARD,
      location: ':memory:',
      env: { [CACHE_DRIVER_ENV]: 'postgres' },
    })
    try {
      expect(cache.kind).toBe(defaultDriverKind())
    } finally {
      cache.close()
    }
  })

  it('prefers SQLite when it is available', () => {
    expect(isSqliteAvailable()).toBe(true)
    expect(defaultDriverKind()).toBe('sqlite')

    const cache = openCache({ boardSlug: BOARD, location: ':memory:', driver: 'auto' })
    try {
      expect(cache.kind).toBe('sqlite')
    } finally {
      cache.close()
    }
  })

  it('creates the cache directory rather than failing on a missing path', () => {
    const nested = join(workspace, 'a', 'b', 'c')
    const cache = openCache({
      boardSlug: BOARD,
      driver: 'sqlite',
      env: { [CACHE_DIR_ENV]: nested },
    })
    try {
      cache.cards.put(BOARD, makeCard(1))
      expect(cache.location).toBe(join(nested, 'payments-api.db'))
      expect(cache.cards.count(BOARD)).toBe(1)
    } finally {
      cache.close()
    }
  })

  it('resolves a location from the environment when none is given', () => {
    const directory = join(workspace, 'from-env')
    const cache = openCache({
      boardSlug: 'payments-api',
      driver: 'json',
      env: { [CACHE_DIR_ENV]: directory },
    })
    try {
      expect(cache.location).toBe(join(directory, 'payments-api.db'))
    } finally {
      cache.close()
    }
  })

  it('propagates a real open failure instead of quietly downgrading', () => {
    // A directory is not a database. Only a *missing module* is grounds for the
    // JSON fallback; anything else must surface.
    expect(() => openCache({ boardSlug: BOARD, location: workspace, driver: 'auto' })).toThrow()
  })

  it('reports the schema version it applied', () => {
    const cache = openCache({ boardSlug: BOARD, location: ':memory:', driver: 'sqlite' })
    try {
      expect(cache.schemaVersion).toBeGreaterThan(0)
    } finally {
      cache.close()
    }
  })
})

describe('SqliteUnavailableError', () => {
  it('explains the fallback rather than just failing', () => {
    const error = new SqliteUnavailableError(new Error('no prebuilt binary'))
    expect(error.name).toBe('SqliteUnavailableError')
    expect(error.message).toContain('optional dependency')
    expect(error.message).toContain('JSON cache driver')
    expect(error.cause).toBeInstanceOf(Error)
  })
})
