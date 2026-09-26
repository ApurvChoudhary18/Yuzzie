/**
 * `yuzie __hook <name>`: what the Git hooks do (SPEC.md §9.5, §9.6).
 *
 * The hard rule: a hook never fails, and never holds up, a Git operation.
 * Everything here is best effort, reads the card list from the local cache
 * rather than the network, and gives the server a fixed time budget — a write
 * that does not make it in time waits in the outbox for the next sync.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Card, Commit } from '@yuzie/core'
import {
  cardForCommit,
  cardFromBranch,
  commitAt,
  currentBranch,
  type ParsedCommit,
  type Repo,
  summarize,
} from '@yuzie/git'
import type { Board } from '@yuzie/sdk'
import { openCache, type YuzieCache } from '@yuzie/store'
import type { Context } from '../context.js'
import { knownHandle } from '../identity.js'

/** How long each hook waits for the server before queueing (§9.5). */
export const HOOK_BUDGET_MS = { 'post-commit': 300, 'pre-push': 2_000 } as const

/** Commits no card could be found for, kept for `yuzie sync` to attribute (§9.6 rule 5). */
export interface BufferedCommit {
  readonly sha: string
  readonly subject: string
  readonly branch: string | null
  readonly committedAt: string
}

const BUFFER_LIMIT = 500

export function unattributedPath(root: string): string {
  return join(root, '.yuzie', 'cache', 'unattributed.json')
}

export async function readUnattributed(root: string): Promise<BufferedCommit[]> {
  try {
    const parsed = JSON.parse(await readFile(unattributedPath(root), 'utf8')) as BufferedCommit[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function bufferCommit(root: string, commit: BufferedCommit): Promise<void> {
  const existing = await readUnattributed(root)
  if (existing.some((entry) => entry.sha === commit.sha)) return
  const next = [...existing, commit].slice(-BUFFER_LIMIT)
  await mkdir(dirname(unattributedPath(root)), { recursive: true })
  await writeFile(unattributedPath(root), `${JSON.stringify(next, null, 2)}\n`)
}

interface HookWorld {
  readonly repo: Repo
  readonly slug: string
  readonly template: string
  readonly baseBranch: string
  readonly me: string | null
  readonly cache: YuzieCache | null
  /** The cached cards: the hook never asks the network what they are. */
  readonly cards: readonly Card[]
}

/** Everything a hook needs, from disk; null when this is not a Yuzie repository. */
async function world(context: Context): Promise<HookWorld | null> {
  const repo = await context.repo()
  if (repo === null) return null
  const { config } = await context.config()
  if (config.board === undefined) return null
  let cache: YuzieCache | null = null
  try {
    cache = openCache({
      boardSlug: config.board,
      cwd: context.io.cwd,
      home: context.home,
      env: context.io.env,
    })
  } catch {
    cache = null
  }
  return {
    repo,
    slug: config.board,
    template: config.git.branchTemplate,
    baseBranch: config.git.baseBranch,
    me: await knownHandle(context.home, config.server),
    cache,
    cards: cache?.cards.list(config.board) ?? [],
  }
}

/**
 * A board that only writes: no loading, no stream, and the cache's outbox for
 * anything the server does not take within `budgetMs`.
 */
async function writer(context: Context, env: HookWorld, budgetMs: number): Promise<Board | null> {
  if (env.cache === null) return null
  let client: Awaited<ReturnType<Context['client']>>
  try {
    client = await context.client()
  } catch {
    return null
  }
  const timer = setTimeout(() => context.abortRequests(), budgetMs)
  timer.unref?.()
  return client.board(env.slug, { realtime: false, offline: 'queue', cache: env.cache })
}

function inProgress(env: HookWorld): number[] {
  if (env.me === null || env.cache === null) return []
  const active = new Set(
    env.cache.columns
      .list(env.slug)
      .filter((column) => column.semantics === 'in_progress')
      .map((column) => column.key),
  )
  const me = env.me
  return env.cards
    .filter((card) => active.has(card.column) && card.assignees.includes(me))
    .map((card) => card.number)
}

/** The card a branch belongs to: the one linked to it, else by the template. */
function cardForBranch(env: HookWorld, branch: string): number | null {
  return (
    env.cards.find((card) => card.git?.branch === branch)?.number ??
    cardFromBranch(branch, env.template)
  )
}

async function postCommit(context: Context, env: HookWorld): Promise<void> {
  const commit: ParsedCommit | null = await commitAt(env.repo.root)
  if (commit === null) return
  const branch = await currentBranch(env.repo.root)
  const resolution = cardForCommit({
    message: commit.message,
    branch,
    template: env.template,
    claimed: inProgress(env),
  })
  if (resolution === null) {
    await bufferCommit(env.repo.root, {
      sha: commit.sha,
      subject: commit.subject,
      branch,
      committedAt: commit.committedAt,
    })
    return
  }
  context.output.line(`[yuzie] linked commit ${commit.sha.slice(0, 7)} → #${resolution.cardNo}`)

  const board = await writer(context, env, HOOK_BUDGET_MS['post-commit'])
  if (board === null) return
  const attached: Commit = {
    sha: commit.sha,
    message: commit.message,
    author: env.me,
    committedAt: commit.committedAt,
  }
  try {
    await board.cards.attachCommits(resolution.cardNo, [attached])
  } finally {
    await board.close()
  }
}

async function postCheckout(
  context: Context,
  env: HookWorld,
  args: readonly string[],
): Promise<void> {
  // `post-checkout <previous> <new> <1 if a branch checkout>`: files are not our business.
  if (args[2] !== '1') return
  const branch = await currentBranch(env.repo.root)
  if (branch === null) return
  const cardNo = cardForBranch(env, branch)
  const card = cardNo === null ? undefined : env.cards.find((c) => c.number === cardNo)
  // Presence itself is carried by a running `yuzie` (TUI or feed), which follows HEAD.
  if (card !== undefined) context.output.line(`[yuzie] on #${card.number} ${card.title}`)
}

async function prePush(context: Context, env: HookWorld): Promise<void> {
  const branch = await currentBranch(env.repo.root)
  if (branch === null) return
  const cardNo = cardForBranch(env, branch)
  if (cardNo === null) return
  const card = env.cards.find((c) => c.number === cardNo)
  const summary = await summarize(env.repo.root, card?.git?.baseBranch ?? env.baseBranch, branch)
  if (summary === null) return
  const board = await writer(context, env, HOOK_BUDGET_MS['pre-push'])
  if (board === null) return
  // Not `pushed`: this runs before the push, which may yet fail.
  const { pushed: _pushed, ...counts } = summary
  try {
    await board.cards.updateGit(cardNo, counts)
  } finally {
    await board.close()
  }
}

/** Always 0, whatever happens: the caller swallows errors too. */
export async function hook(
  context: Context,
  name: string,
  args: readonly string[],
): Promise<number> {
  const env = await world(context)
  if (env === null) return 0
  try {
    if (name === 'post-commit') await postCommit(context, env)
    else if (name === 'post-checkout') await postCheckout(context, env, args)
    else if (name === 'pre-push') await prePush(context, env)
  } catch (error) {
    context.output.debug(`hook ${name}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    context.abortRequests()
    env.cache?.close()
  }
  return 0
}
