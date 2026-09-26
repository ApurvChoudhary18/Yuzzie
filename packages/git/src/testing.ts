/**
 * Throwaway Git repositories for tests (§18 Session 11): each in its own temp
 * directory, in exactly the state a test asks for. `@yuzie/git/testing`.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface FixtureRepo {
  readonly root: string
  /** Run git here and return its trimmed stdout; throws on failure. */
  git(...args: string[]): string
  /** Write a file (relative to the root) and return its path. */
  write(path: string, content?: string): string
  /** Stage everything and commit; returns the new sha. */
  commit(message: string, files?: Record<string, string>): string
  /** Delete the repository and anything it created (a bare remote too). */
  remove(): void
}

export interface FixtureOptions {
  /** Default branch name. */
  readonly branch?: string
  /** Make a first commit so HEAD is born. Default true. */
  readonly initialCommit?: boolean
  /** Give it an `origin`: a bare repository in another temp dir, pushed to. */
  readonly remote?: boolean
}

const IDENTITY = [
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.test',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
]

function temp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

export function fixtureRepo(options: FixtureOptions = {}): FixtureRepo {
  const root = temp('yuzie-git-')
  const cleanup = [root]
  const run = (cwd: string, args: string[]) =>
    execFileSync('git', [...IDENTITY, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim()

  run(root, ['init', '-q', '-b', options.branch ?? 'main'])
  const repo: FixtureRepo = {
    root,
    git: (...args) => run(root, args),
    write(path, content = `${path}\n`) {
      const full = join(root, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
      return full
    },
    commit(message, files = {}) {
      for (const [path, content] of Object.entries(files)) repo.write(path, content)
      run(root, ['add', '--all'])
      run(root, ['commit', '-q', '--allow-empty', '-m', message])
      return run(root, ['rev-parse', 'HEAD'])
    },
    remove() {
      for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
    },
  }

  if (options.initialCommit !== false) repo.commit('initial commit', { 'README.md': '# fixture\n' })

  if (options.remote === true) {
    const bare = temp('yuzie-remote-')
    cleanup.push(bare)
    run(bare, ['init', '-q', '--bare', '-b', options.branch ?? 'main'])
    run(root, ['remote', 'add', 'origin', bare])
    if (options.initialCommit !== false)
      run(root, ['push', '-q', '-u', 'origin', options.branch ?? 'main'])
  }
  return repo
}

/** A directory that is not a repository, for the "not in a repo" cases. */
export function plainDirectory(): { root: string; remove(): void } {
  const root = temp('yuzie-plain-')
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) }
}
