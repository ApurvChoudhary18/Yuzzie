/**
 * `yuzie sync` (§7.2, §18 Session 13): force a full reconcile.
 *
 * Push what is queued, in order and idempotently; pull the board so the
 * server's decisions replace what was assumed; re-scan Git for cards with a
 * local branch; attribute commits the hooks could not place (§9.6 rule 5);
 * and say exactly what happened.
 */
import type { Card, Commit } from '@yuzie/core'
import { OfflineError } from '@yuzie/core'
import { cardForCommit, localBranchExists, summarize } from '@yuzie/git'
import type { Board } from '@yuzie/sdk'
import { openCache } from '@yuzie/store'
import type { Context } from '../context.js'
import { printReconciliation, reconcile } from '../reconcile.js'
import { plural } from '../render/text.js'
import { currentSlug, withBoard } from '../session.js'
import { readUnattributed, writeUnattributed } from './hooks.js'

interface SyncOptions {
  readonly rebuild?: boolean
  readonly retrySetAside?: boolean
  readonly dropSetAside?: boolean
}

/** Empty the board's cached copy — never its queued writes — so the pull rebuilds it. */
function rebuildCache(context: Context, slug: string): void {
  const cache = openCache({
    boardSlug: slug,
    cwd: context.io.cwd,
    home: context.home,
    env: context.io.env,
  })
  try {
    cache.transaction(() => {
      cache.cards.clear(slug)
      cache.columns.clear(slug)
      cache.comments.clear(slug)
      cache.checklist.clear(slug)
      cache.git.clear(slug)
      cache.events.clear(slug)
      cache.sync.clear(slug)
    })
  } finally {
    cache.close()
  }
}

/** A card's git summary is out of date when the branch here says otherwise. */
function differs(card: Card, summary: NonNullable<Awaited<ReturnType<typeof summarize>>>): boolean {
  const git = card.git
  if (git === null) return true
  return (
    git.commits !== summary.commits ||
    git.filesChanged !== summary.filesChanged ||
    git.additions !== summary.additions ||
    git.deletions !== summary.deletions ||
    git.pushed !== summary.pushed ||
    git.lastActivityAt !== summary.lastActivityAt
  )
}

async function rescanGit(context: Context, board: Board, baseBranch: string): Promise<number[]> {
  const repo = await context.repo()
  if (repo === null) return []
  const refreshed: number[] = []
  for (const card of Object.values(board.state.cards)) {
    const branch = card.git?.branch
    if (!branch || card.number < 0 || !(await localBranchExists(repo.root, branch))) continue
    const summary = await summarize(repo.root, card.git?.baseBranch ?? baseBranch, branch)
    if (summary === null || !differs(card, summary)) continue
    await board.cards.updateGit(card.number, summary)
    refreshed.push(card.number)
  }
  return refreshed
}

/** Commits the post-commit hook could not place, tried again with what is known now. */
async function attributeBuffered(
  context: Context,
  board: Board,
  me: string | null,
  template: string,
): Promise<number> {
  const repo = await context.repo()
  if (repo === null) return 0
  const buffered = await readUnattributed(repo.root)
  if (buffered.length === 0) return 0
  const inProgress = new Set(
    board.state.columns.filter((c) => c.semantics === 'in_progress').map((c) => c.key),
  )
  const claimed =
    me === null
      ? []
      : Object.values(board.state.cards)
          .filter((card) => inProgress.has(card.column) && card.assignees.includes(me))
          .map((card) => card.number)

  const left = []
  let attributed = 0
  for (const entry of buffered) {
    const linked = Object.values(board.state.cards).find(
      (card) => entry.branch !== null && card.git?.branch === entry.branch,
    )
    const cardNo =
      linked?.number ??
      cardForCommit({ message: entry.subject, branch: entry.branch, template, claimed })?.cardNo
    if (cardNo === undefined || board.state.cards[cardNo] === undefined) {
      left.push(entry)
      continue
    }
    const commit: Commit = {
      sha: entry.sha,
      message: entry.subject,
      author: me,
      committedAt: entry.committedAt,
    }
    await board.cards.attachCommits(cardNo, [commit])
    attributed += 1
  }
  await writeUnattributed(repo.root, left)
  return attributed
}

export async function sync(context: Context, options: SyncOptions): Promise<void> {
  if (context.options.offline === true) {
    throw new OfflineError(
      'offline_network_required',
      'Syncing needs the server, and --offline is set.',
    )
  }
  const slug = await currentSlug(context)
  const { config } = await context.config()
  if (options.rebuild === true) {
    rebuildCache(context, slug)
    context.output.success('Cleared the cached board (queued changes kept)')
  }

  await withBoard(
    context,
    async (session) => {
      const board = session.board
      if (options.dropSetAside === true) {
        const dropped = board.discardQuarantined()
        context.output.success(`Dropped ${plural(dropped, 'set-aside change')}`)
      }
      if (options.retrySetAside === true) {
        const released = board.retryQuarantined()
        context.output.success(`Put ${plural(released, 'set-aside change')} back in the queue`)
      }
      if (!session.online) {
        throw new OfflineError(
          'offline_network_required',
          `Cannot reach the server; ${plural(board.queued, 'change')} still queued.`,
        )
      }

      const report = await board.sync()
      const result = reconcile(report, board.state)
      printReconciliation(context.output, result)

      const gitRefreshed = await rescanGit(context, board, config.git.baseBranch)
      const attributed = await attributeBuffered(
        context,
        board,
        session.me,
        config.git.branchTemplate,
      )

      context.output.success(`Pulled the board (seq ${board.state.seq})`)
      if (gitRefreshed.length > 0)
        context.output.success(
          `Refreshed git for ${gitRefreshed.map((n) => `#${n}`).join(', ')} from the local branches`,
        )
      if (attributed > 0)
        context.output.success(`Linked ${plural(attributed, 'buffered commit')} to their cards`)
      if (board.queued > 0) context.output.warn(`${plural(board.queued, 'change')} still queued`)
      else if (board.quarantine.length > 0)
        context.output.warn(
          `${plural(board.quarantine.length, 'change')} set aside — see \`yuzie doctor\``,
        )
      else context.output.success('In sync')

      context.output.result(
        'SyncReport',
        {
          sent: result.sent,
          conflicts: result.conflicts.map(({ cardNo, change, by, message }) => ({
            cardNo,
            change,
            by,
            message,
          })),
          retrying: result.retrying.map(({ cardNo, change, attempts, message }) => ({
            cardNo,
            change,
            attempts,
            message,
          })),
          setAside: result.quarantined.map(({ cardNo, change, attempts, message }) => ({
            cardNo,
            change,
            attempts,
            message,
          })),
          remaining: board.queued,
          seq: board.state.seq,
          gitRefreshed,
          attributed,
          rebuilt: options.rebuild === true,
        },
        { boardSlug: slug, synced: board.queued === 0, queued: board.queued },
      )
    },
    { quiet: true },
  )
}
