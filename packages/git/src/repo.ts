/**
 * Repository facts the CLI needs to set a repo up (SPEC.md §6.1, §9).
 *
 * Everything shells out to the user's own `git`, so the answers are exactly the
 * ones `git` itself would give — including worktrees, `core.hooksPath`, and
 * whatever the user has configured.
 */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { parseRemote, type Remote } from './remote.js'

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run git in `cwd`; never throws, so callers decide what a failure means. */
export function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', timeout: 10_000 },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 127
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
      },
    )
  })
}

export interface Repo {
  /** Absolute path of the working tree's top level. */
  readonly root: string
  /** The repository's name: from the remote when there is one, else the directory. */
  readonly name: string
  /** `origin` if present, else the first remote, parsed. */
  readonly remote: Remote | null
  /** The branch new work is based on (§9.2). */
  readonly defaultBranch: string
}

/** The installed git's version, e.g. `2.45.1`, or null when git is missing. */
export async function gitVersion(cwd: string = process.cwd()): Promise<string | null> {
  const result = await git(cwd, ['--version'])
  if (result.code !== 0) return null
  return /(\d+\.\d+(?:\.\d+)?)/.exec(result.stdout)?.[1] ?? null
}

/**
 * The branch to treat as the base. In order: what `origin/HEAD` points at, the
 * current branch, `init.defaultBranch`, then `main`.
 */
export async function defaultBranch(root: string): Promise<string> {
  const originHead = await git(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
  if (originHead.code === 0 && originHead.stdout.startsWith('origin/')) {
    return originHead.stdout.slice('origin/'.length)
  }
  const current = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (current.code === 0 && current.stdout.length > 0) return current.stdout
  const configured = await git(root, ['config', '--get', 'init.defaultBranch'])
  if (configured.code === 0 && configured.stdout.length > 0) return configured.stdout
  return 'main'
}

/** Find the repository containing `cwd`, or null when there is none (or no git). */
export async function findRepo(cwd: string = process.cwd()): Promise<Repo | null> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0 || top.stdout.length === 0) return null
  const root = top.stdout

  const remotes = await git(root, ['remote'])
  const names = remotes.code === 0 ? remotes.stdout.split('\n').filter(Boolean) : []
  const chosen = names.includes('origin') ? 'origin' : names[0]
  let remote: Remote | null = null
  if (chosen !== undefined) {
    const url = await git(root, ['remote', 'get-url', chosen])
    if (url.code === 0) remote = parseRemote(url.stdout)
  }

  return {
    root,
    name: remote?.name ?? basename(root),
    remote,
    defaultBranch: await defaultBranch(root),
  }
}

/** Where this repository's hooks live, honouring `core.hooksPath` and worktrees. */
export async function hooksDirectory(root: string): Promise<string> {
  const result = await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'])
  if (result.code !== 0 || result.stdout.length === 0) {
    throw new Error(`Could not locate the hooks directory for ${root}: ${result.stderr}`)
  }
  return result.stdout
}
