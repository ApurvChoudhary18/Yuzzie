/**
 * Where the cache file lives (SPEC.md §18 Session 2).
 *
 *   inside a Git repo -> <repoRoot>/.yuzie/cache/yuzie.db
 *   anywhere else     -> ~/.yuzie/cache/<slug>.db
 *
 * The in-repo path is preferred because a board is usually one repo, and because
 * `yuzie init` gitignores `.yuzie/cache/` (§6.1), so the cache travels with the
 * checkout and disappears with it.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'

export const CACHE_DIR_ENV = 'YUZIE_CACHE_DIR'
export const REPO_CACHE_FILE = 'yuzie.db'

export type CacheScope = 'repo' | 'home' | 'override'

export interface CacheLocation {
  /** Absolute path to the database file. */
  readonly path: string
  /** Absolute path to the directory holding it. */
  readonly directory: string
  readonly scope: CacheScope
}

export interface CacheLocationOptions {
  readonly boardSlug: string
  /** Where to start looking for a repo. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Defaults to `os.homedir()`. */
  readonly home?: string
  /** Defaults to `process.env`. Read only for {@link CACHE_DIR_ENV}. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * The repository root containing `startDir`, or null.
 *
 * `.git` is a directory in a normal clone and a file in a worktree or submodule,
 * so its type is not checked.
 */
export function findRepoRoot(startDir: string): string | null {
  let current = resolve(startDir)
  const { root } = parse(current)

  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    if (current === root) return null
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** File name for a board's cache when it is not scoped to a repo. */
export function cacheFileNameFor(boardSlug: string): string {
  // Board slugs are already `[a-z0-9-]` (§12.1), but this becomes a file path, so
  // it is sanitised rather than trusted. Dots are dropped along with separators,
  // so no input can produce a name containing `..`.
  const safe = boardSlug.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safe.length > 0 ? safe : 'board'}.db`
}

export function resolveCacheLocation(options: CacheLocationOptions): CacheLocation {
  const env = options.env ?? process.env
  const override = env[CACHE_DIR_ENV]
  if (override !== undefined && override.length > 0) {
    const directory = isAbsolute(override) ? override : resolve(override)
    return {
      directory,
      path: join(directory, cacheFileNameFor(options.boardSlug)),
      scope: 'override',
    }
  }

  const repoRoot = findRepoRoot(options.cwd ?? process.cwd())
  if (repoRoot !== null) {
    const directory = join(repoRoot, '.yuzie', 'cache')
    return { directory, path: join(directory, REPO_CACHE_FILE), scope: 'repo' }
  }

  const directory = join(options.home ?? homedir(), '.yuzie', 'cache')
  return { directory, path: join(directory, cacheFileNameFor(options.boardSlug)), scope: 'home' }
}
