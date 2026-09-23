import { describe, expect, it } from 'vitest'
import * as store from './index.js'

/**
 * The entry point is what the SDK and CLI import. A missing re-export is a build
 * break two sessions later, so the surface is asserted here.
 */
describe('@yuzie/store public surface', () => {
  it('exports the ways to open a cache', () => {
    expect(typeof store.openCache).toBe('function')
    expect(typeof store.openSqliteCache).toBe('function')
    expect(typeof store.openJsonCache).toBe('function')
    expect(typeof store.defaultDriverKind).toBe('function')
    expect(typeof store.isSqliteAvailable).toBe('function')
  })

  it('exports cache location resolution', () => {
    expect(typeof store.resolveCacheLocation).toBe('function')
    expect(typeof store.findRepoRoot).toBe('function')
    expect(typeof store.cacheFileNameFor).toBe('function')
    expect(store.REPO_CACHE_FILE).toBe('yuzie.db')
    expect(store.CACHE_DIR_ENV).toBe('YUZIE_CACHE_DIR')
    expect(store.CACHE_DRIVER_ENV).toBe('YUZIE_CACHE_DRIVER')
  })

  it('exports the event-folding entry points and the schema', () => {
    expect(typeof store.applyEventToCache).toBe('function')
    expect(typeof store.applyEventsToCache).toBe('function')
    expect(typeof store.backoffDelayMs).toBe('function')
    expect(store.SCHEMA_VERSION).toBeGreaterThan(0)
    expect(store.MIGRATIONS.length).toBeGreaterThan(0)
  })

  it('exports the errors a caller has to distinguish', () => {
    expect(typeof store.SqliteUnavailableError).toBe('function')
    expect(typeof store.CacheFileCorruptError).toBe('function')
  })
})
