import { describeCacheConformance } from './__tests__/conformance.js'
import { isSqliteAvailable, openSqliteCache } from './sqlite-driver.js'

/**
 * The same suite the JSON driver runs. If better-sqlite3 is genuinely
 * unavailable the suite is skipped loudly rather than passing quietly — a silent
 * skip would let the primary driver rot.
 */
if (!isSqliteAvailable()) {
  throw new Error(
    'better-sqlite3 is not available, so the SQLite conformance suite cannot run. ' +
      'Install it or run with YUZIE_CACHE_DRIVER=json and accept the JSON driver only.',
  )
}

describeCacheConformance({
  kind: 'sqlite',
  open: (location, jitter) =>
    openSqliteCache(jitter === undefined ? { location } : { location, jitter }),
})
