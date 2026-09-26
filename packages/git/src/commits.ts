/**
 * What a card derives from Git (SPEC.md §9.1): its commits, diff stats, push
 * state and last activity — computed on the client, which has the repo.
 */
import { baseRef } from './branch.js'
import { git, resolveRef } from './repo.js'

export interface ParsedCommit {
  readonly sha: string
  readonly subject: string
  /** Subject and body, as written. */
  readonly message: string
  readonly authorName: string
  readonly authorEmail: string
  /** ISO 8601, committer date. */
  readonly committedAt: string
}

const FIELD = '\u001f'
const RECORD = '\u001e'
const FORMAT = `${['%H', '%an', '%ae', '%cI', '%B'].join('%x1f')}%x1e`

function parseLog(stdout: string): ParsedCommit[] {
  return stdout
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = '', authorName = '', authorEmail = '', committedAt = '', ...rest] =
        record.split(FIELD)
      const message = rest.join(FIELD).trimEnd()
      return {
        sha,
        subject: message.split('\n')[0] ?? '',
        message,
        authorName,
        authorEmail,
        committedAt,
      }
    })
}

/** One commit, `HEAD` by default (the post-commit hook). */
export async function commitAt(root: string, rev = 'HEAD'): Promise<ParsedCommit | null> {
  const result = await git(root, ['log', '-1', `--format=${FORMAT}`, rev, '--'])
  if (result.code !== 0) return null
  return parseLog(result.stdout)[0] ?? null
}

/** `git log <base>..<branch>`, newest first. */
export async function commitsBetween(
  root: string,
  base: string,
  branch: string,
): Promise<ParsedCommit[]> {
  const from = await baseRef(root, base).catch(() => null)
  if (from === null) return []
  const result = await git(root, ['log', `--format=${FORMAT}`, `${from}..${branch}`, '--'])
  return result.code === 0 ? parseLog(result.stdout) : []
}

export interface DiffStats {
  readonly filesChanged: number
  readonly additions: number
  readonly deletions: number
}

/** `git diff --shortstat <merge-base> <branch>`. */
export async function diffStats(root: string, base: string, branch: string): Promise<DiffStats> {
  const none = { filesChanged: 0, additions: 0, deletions: 0 }
  const from = await baseRef(root, base).catch(() => null)
  if (from === null) return none
  const mergeBase = await git(root, ['merge-base', from, branch])
  if (mergeBase.code !== 0) return none
  const stat = await git(root, ['diff', '--shortstat', mergeBase.stdout, branch, '--'])
  if (stat.code !== 0) return none
  const number = (pattern: RegExp) => Number(pattern.exec(stat.stdout)?.[1] ?? 0)
  return {
    filesChanged: number(/(\d+) files? changed/),
    additions: number(/(\d+) insertions?\(\+\)/),
    deletions: number(/(\d+) deletions?\(-\)/),
  }
}

export interface UpstreamState {
  /** e.g. `origin/task/18-fix-oauth`, or null when the branch has none. */
  readonly upstream: string | null
  readonly ahead: number
  readonly behind: number
}

export async function upstreamState(root: string, branch: string): Promise<UpstreamState> {
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])
  if (upstream.code !== 0 || upstream.stdout.length === 0)
    return { upstream: null, ahead: 0, behind: 0 }
  const counts = await git(root, [
    'rev-list',
    '--left-right',
    '--count',
    `${upstream.stdout}...${branch}`,
  ])
  const [behind = 0, ahead = 0] = counts.stdout.split(/\s+/).map(Number)
  return { upstream: upstream.stdout, ahead, behind }
}

/** Everything §9.1 derives, for `card.git.updated`. */
export interface BranchSummary extends DiffStats {
  readonly branch: string
  readonly baseBranch: string
  readonly commits: number
  /** Has an upstream and is not ahead of it. */
  readonly pushed: boolean
  readonly lastActivityAt: string | null
}

export async function summarize(
  root: string,
  base: string,
  branch: string,
): Promise<BranchSummary | null> {
  if ((await resolveRef(root, branch)) === null) return null
  const [commits, stats, upstream] = await Promise.all([
    commitsBetween(root, base, branch),
    diffStats(root, base, branch),
    upstreamState(root, branch),
  ])
  const latest = commits
    .map((commit) => commit.committedAt)
    .sort()
    .at(-1)
  return {
    branch,
    baseBranch: base,
    commits: commits.length,
    ...stats,
    pushed: upstream.upstream !== null && upstream.ahead === 0,
    lastActivityAt: latest ?? null,
  }
}
