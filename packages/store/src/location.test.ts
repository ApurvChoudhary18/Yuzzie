import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CACHE_DIR_ENV,
  cacheFileNameFor,
  findRepoRoot,
  REPO_CACHE_FILE,
  resolveCacheLocation,
} from './location.js'

describe('findRepoRoot', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'yuzie-repo-'))
    mkdirSync(join(root, 'repo', 'packages', 'api', 'src'), { recursive: true })
    mkdirSync(join(root, 'repo', '.git'))
    mkdirSync(join(root, 'not-a-repo', 'deep'), { recursive: true })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('walks up from a nested directory', () => {
    expect(findRepoRoot(join(root, 'repo', 'packages', 'api', 'src'))).toBe(join(root, 'repo'))
  })

  it('finds the repo it is already at', () => {
    expect(findRepoRoot(join(root, 'repo'))).toBe(join(root, 'repo'))
  })

  it('returns null when there is no repo above', () => {
    expect(findRepoRoot(join(root, 'not-a-repo', 'deep'))).toBeNull()
  })

  it('accepts a .git file, as worktrees and submodules have', () => {
    const worktree = join(root, 'worktree')
    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n')
    expect(findRepoRoot(join(worktree, 'src'))).toBe(worktree)
  })
})

describe('cacheFileNameFor', () => {
  it('names the file after the board', () => {
    expect(cacheFileNameFor('payments-api')).toBe('payments-api.db')
  })

  it('sanitises anything that is not safe in a path', () => {
    expect(cacheFileNameFor('../../etc/passwd')).toBe('etc-passwd.db')
    expect(cacheFileNameFor('a/b')).toBe('a-b.db')
    expect(cacheFileNameFor('///')).toBe('board.db')
  })
})

describe('resolveCacheLocation', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'yuzie-loc-'))
    mkdirSync(join(root, 'repo', 'src'), { recursive: true })
    mkdirSync(join(root, 'repo', '.git'))
    mkdirSync(join(root, 'elsewhere'), { recursive: true })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('puts the cache in the repo when there is one', () => {
    const location = resolveCacheLocation({
      boardSlug: 'payments-api',
      cwd: join(root, 'repo', 'src'),
      env: {},
    })
    expect(location.scope).toBe('repo')
    expect(location.path).toBe(join(root, 'repo', '.yuzie', 'cache', REPO_CACHE_FILE))
  })

  it('falls back to the home directory outside a repo', () => {
    const location = resolveCacheLocation({
      boardSlug: 'payments-api',
      cwd: join(root, 'elsewhere'),
      home: join(root, 'home'),
      env: {},
    })
    expect(location.scope).toBe('home')
    expect(location.path).toBe(join(root, 'home', '.yuzie', 'cache', 'payments-api.db'))
  })

  it('honours an explicit override ahead of everything else', () => {
    const override = join(root, 'override')
    const location = resolveCacheLocation({
      boardSlug: 'payments-api',
      cwd: join(root, 'repo', 'src'),
      env: { [CACHE_DIR_ENV]: override },
    })
    expect(location.scope).toBe('override')
    expect(location.path).toBe(join(override, 'payments-api.db'))
  })

  it('ignores an empty override', () => {
    const location = resolveCacheLocation({
      boardSlug: 'payments-api',
      cwd: join(root, 'repo', 'src'),
      env: { [CACHE_DIR_ENV]: '' },
    })
    expect(location.scope).toBe('repo')
  })

  it('falls back to the real process and home when nothing is injected', () => {
    const location = resolveCacheLocation({ boardSlug: 'payments-api' })
    expect(location.path.startsWith('/')).toBe(true)
    expect(location.path.includes('.yuzie')).toBe(true)
  })

  it('always reports an absolute directory', () => {
    const location = resolveCacheLocation({
      boardSlug: 'payments-api',
      cwd: join(root, 'repo'),
      env: { [CACHE_DIR_ENV]: 'relative-cache' },
    })
    expect(location.directory.startsWith('/')).toBe(true)
  })
})
