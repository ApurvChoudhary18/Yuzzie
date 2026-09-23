/**
 * Choosing and opening a cache.
 *
 * SQLite is preferred and the JSON driver is the safety net, so a machine where
 * the native module will not build still gets a working `npx yuzie` (SPEC.md
 * §17, §20). Selection can be forced with `YUZIE_CACHE_DRIVER=sqlite|json`,
 * which is also how the conformance suite runs the same tests twice.
 */
import { openJsonCache } from './json-driver.js'
import { resolveCacheLocation } from './location.js'
import { isSqliteAvailable, openSqliteCache, SqliteUnavailableError } from './sqlite-driver.js'
import type { CacheDriverKind, YuzieCache } from './types.js'

export const CACHE_DRIVER_ENV = 'YUZIE_CACHE_DRIVER'

export interface OpenCacheOptions {
  readonly boardSlug: string
  /** An explicit path or `:memory:`. Defaults to {@link resolveCacheLocation}. */
  readonly location?: string
  /** `auto` prefers SQLite and falls back to JSON. */
  readonly driver?: CacheDriverKind | 'auto'
  readonly cwd?: string
  readonly home?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Injected in tests so backoff is deterministic. */
  readonly jitter?: () => number
}

function requestedDriver(options: OpenCacheOptions): CacheDriverKind | 'auto' {
  if (options.driver !== undefined) return options.driver
  const fromEnv = (options.env ?? process.env)[CACHE_DRIVER_ENV]
  if (fromEnv === 'sqlite' || fromEnv === 'json') return fromEnv
  return 'auto'
}

export function openCache(options: OpenCacheOptions): YuzieCache {
  const location =
    options.location ??
    resolveCacheLocation({
      boardSlug: options.boardSlug,
      cwd: options.cwd,
      home: options.home,
      env: options.env,
    }).path

  const driver = requestedDriver(options)
  const jitterOption = options.jitter === undefined ? {} : { jitter: options.jitter }

  if (driver === 'json') return openJsonCache({ location, ...jitterOption })
  if (driver === 'sqlite') return openSqliteCache({ location, ...jitterOption })

  try {
    return openSqliteCache({ location, ...jitterOption })
  } catch (error) {
    if (error instanceof SqliteUnavailableError) {
      return openJsonCache({ location, ...jitterOption })
    }
    throw error
  }
}

/** Which driver {@link openCache} would pick with `auto`. */
export function defaultDriverKind(): CacheDriverKind {
  return isSqliteAvailable() ? 'sqlite' : 'json'
}
