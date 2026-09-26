/**
 * The Git-aware commands (SPEC.md §9): `claim`, `start`, `branch`, `commits`,
 * `finish`. The CLI has the repository and the server does not, so these
 * compute what Git says and push the result as card writes.
 *
 * Two rules hold throughout: Git is never rolled back to match the server,
 * and a server that cannot be reached queues the writes instead of failing.
 */
import { spawn } from 'node:child_process'
import {
  AuthenticationError,
  branchFor,
  type Card,
  type Column,
  GitPreconditionError,
  PermissionError,
} from '@yuzie/core'
import {
  type BranchAction,
  BranchError,
  commitsBetween,
  currentBranch,
  dirtyFiles,
  head,
  localBranchExists,
  onPath,
  pushBranch,
  type Repo,
  stash,
  summarize,
  switchToBranch,
  upstreamState,
} from '@yuzie/git'
import { matchColumn } from '@yuzie/sdk'
import type { Context } from '../context.js'
import { ago, plural } from '../render/text.js'
import { type BoardSession, withBoard } from '../session.js'

function meta(session: BoardSession, extra: Record<string, unknown> = {}) {
  return { boardSlug: session.slug, synced: session.online && session.board.queued === 0, ...extra }
}

function precondition(message: string): GitPreconditionError {
  return new GitPreconditionError('git_precondition_failed', message)
}

/** The column `claim` moves to: `flow.startColumn`, else the first in-progress one. */
function startColumn(columns: readonly Column[], configured: string): Column | undefined {
  return (
    matchColumn(columns, configured) ?? columns.find((column) => column.semantics === 'in_progress')
  )
}

/** The column `finish` moves to: `flow.finishColumn`, else review, else done (§9.4). */
function finishColumn(columns: readonly Column[], configured: string): Column | undefined {
  return (
    matchColumn(columns, configured) ??
    columns.find((column) => column.semantics === 'review') ??
    columns.find((column) => column.semantics === 'terminal')
  )
}

function requireMe(session: BoardSession): string {
  if (session.me === null) {
    throw new AuthenticationError(
      'unauthenticated',
      'Cannot tell who you are: reach the server once (yuzie whoami), then try again.',
    )
  }
  return session.me
}

/** §9.3 step 2: members and owners may claim; viewers may not. */
function requireMember(session: BoardSession, me: string): void {
  const member = session.board.state.members.find((m) => m.handle === me)
  if (member?.role === 'viewer') {
    throw new PermissionError(
      'forbidden',
      `@${me} is a viewer on ${session.slug} and cannot claim cards.`,
    )
  }
}

type DirtyChoice = 'stash' | 'current' | 'force'

/**
 * §9.3 step 3: a dirty tree asks what to do — stash, continue on the current
 * branch, or abort. With nobody to ask it aborts (exit 8) unless `--force`.
 */
async function resolveDirty(
  context: Context,
  dirty: readonly string[],
  force: boolean,
): Promise<DirtyChoice> {
  const summary = `The working tree has ${plural(dirty.length, 'uncommitted file')}`
  if (force) return 'force'
  if (!context.prompter.canAsk) {
    throw precondition(
      `${summary}. Commit or stash them first, or pass --force to carry them along.`,
    )
  }
  context.output.warn(summary)
  const choice = await context.prompter.choose(
    'What now?',
    [
      'Stash them, then switch branches',
      'Continue on the current branch (no branch switch)',
      'Abort',
    ],
    // No default: stashing is not something to do because nobody answered.
    { none: () => precondition(`Aborted: ${summary.toLowerCase()}, and no answer was given.`) },
  )
  if (choice === 0) return 'stash'
  if (choice === 1) return 'current'
  throw precondition(`Aborted: ${summary.toLowerCase()}.`)
}

function branchReceipt(context: Context, action: BranchAction, branch: string): void {
  switch (action) {
    case 'created':
      context.output.success(`Created branch ${branch}`)
      context.output.success(`Checked out ${branch}`)
      return
    case 'tracked':
      context.output.success(`Tracking origin/${branch}`)
      context.output.success(`Checked out ${branch}`)
      return
    case 'checked-out':
      context.output.success(`Checked out existing branch ${branch}`)
      return
    case 'current':
      context.output.success(`Already on ${branch}`)
  }
}

interface ClaimOptions {
  /** `--no-branch` sets this false. */
  readonly branch?: boolean
  readonly from?: string
  readonly force?: boolean
}

/**
 * `yuzie claim` (§9.3) and `yuzie start` (§7.2: the same, without creating a
 * branch — an existing one is still checked out).
 */
export async function claim(
  context: Context,
  reference: string,
  options: ClaimOptions,
  mode: 'claim' | 'start' = 'claim',
): Promise<void> {
  const { config } = await context.config()
  await withBoard(
    context,
    async (session) => {
      const card = await session.card(reference)
      const me = requireMe(session)
      requireMember(session, me)
      const board = session.board

      // --- Git pre-flight (§9.3 step 3) --------------------------------------
      const repo: Repo | null = await context.repo()
      let plan: { root: string; name: string; base: string; current: string | null } | null = null
      let stashed = false
      if (repo === null) {
        context.output.warn('Not in a Git repository: claiming without a branch')
      } else if (options.branch !== false) {
        const where = await head(repo.root)
        if (where.kind === 'detached') {
          throw precondition(
            'HEAD is detached. Check out a branch first (git switch main), then claim again.',
          )
        }
        const name = card.git?.branch ?? branchFor(card, config.git.branchTemplate, { user: me })
        const base = options.from ?? config.git.baseBranch
        plan = { root: repo.root, name, base, current: where.name }

        // `start` only uses a branch that is already there.
        if (mode === 'start' && !(await localBranchExists(repo.root, name))) plan = null

        const dirty = plan === null || plan.current === name ? [] : await dirtyFiles(repo.root)
        if (plan !== null && dirty.length > 0) {
          const choice = await resolveDirty(context, dirty, options.force === true)
          if (choice === 'current') plan = null
          if (choice === 'stash') {
            stashed = await stash(repo.root, `yuzie: before claiming #${card.number}`)
            if (!stashed) throw precondition('Could not stash the changes; nothing was done.')
            context.output.success(`Stashed ${plural(dirty.length, 'change')}`)
          }
        }
      }

      // --- Branch (§9.3 step 5): before the server, never rolled back ---------
      let action: BranchAction | null = null
      if (plan !== null) {
        try {
          action = await switchToBranch(plan.root, plan.name, plan.base, { current: plan.current })
        } catch (error) {
          if (error instanceof BranchError) throw precondition(error.message)
          throw error
        }
      }

      // --- Server (§9.3 steps 4 and 6): queued when unreachable ---------------
      const queuedBefore = board.queued
      const assigned = card.assignees.includes(me)
      if (!assigned) await board.cards.assign(card.number, { add: [me] })
      context.output.success(
        assigned
          ? `#${card.number} already assigned to @${me}`
          : `#${card.number} assigned to @${me}`,
      )
      const column = startColumn(board.state.columns, config.flow.startColumn)
      if (column !== undefined && card.column !== column.key) {
        await board.cards.move(card.number, column.key)
        context.output.success(`Moved to ${column.name}`)
      }
      if (plan !== null && action !== null) {
        branchReceipt(context, action, plan.name)
        if (card.git?.branch !== plan.name)
          await board.cards.linkBranch(card.number, plan.name, plan.base)
      }

      const queued = board.queued > queuedBefore
      if (queued) {
        context.output.warn('queued (offline): the board will catch up when the server is back')
      } else {
        const teammates = board.state.members.filter((member) => member.handle !== me).length
        if (teammates > 0) context.output.success(`Broadcast to ${plural(teammates, 'teammate')}`)
      }

      context.output.result(
        'Claim',
        {
          card: board.state.cards[card.number] ?? card,
          branch: plan === null || action === null ? null : plan.name,
          branchAction: action,
          stashed,
          queued,
        },
        meta(session),
      )
    },
    { queue: true },
  )
}

/** `yuzie branch <id> [--create] [--link <name>]` (§7.2, §9.1). */
export async function branch(
  context: Context,
  reference: string,
  options: { create?: boolean; link?: string },
): Promise<void> {
  const { config } = await context.config()
  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    const board = session.board
    const repo = await context.repo()

    if (options.link !== undefined) {
      await board.cards.linkBranch(card.number, options.link, config.git.baseBranch)
      context.output.success(`Linked #${card.number} to ${options.link}`)
    }
    const name =
      options.link ??
      card.git?.branch ??
      branchFor(card, config.git.branchTemplate, session.me === null ? {} : { user: session.me })
    let action: BranchAction | null = null
    if (options.create === true) {
      if (repo === null) throw precondition('Not in a Git repository: nothing to create.')
      try {
        action = await switchToBranch(repo.root, name, config.git.baseBranch, {
          current: await currentBranch(repo.root),
        })
      } catch (error) {
        if (error instanceof BranchError) throw precondition(error.message)
        throw error
      }
      branchReceipt(context, action, name)
      if (card.git?.branch !== name)
        await board.cards.linkBranch(card.number, name, config.git.baseBranch)
    }
    if (options.link === undefined && options.create !== true) context.output.line(name)

    context.output.result(
      'Branch',
      {
        number: card.number,
        branch: name,
        linked: (board.state.cards[card.number] ?? card).git?.branch === name,
        existsLocally: repo === null ? null : await localBranchExists(repo.root, name),
        branchAction: action,
      },
      meta(session),
    )
  })
}

/** `yuzie commits <id>`: what the card holds, and what the branch has that it does not yet. */
export async function commits(context: Context, reference: string): Promise<void> {
  const { config } = await context.config()
  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    const repo = await context.repo()
    const attached = new Map(card.commits.map((commit) => [commit.sha, commit]))
    const rows = card.commits.map((commit) => ({ ...commit, attached: true }))

    const branchName = card.git?.branch ?? null
    if (repo !== null && branchName !== null && (await localBranchExists(repo.root, branchName))) {
      const base = card.git?.baseBranch ?? config.git.baseBranch
      for (const commit of await commitsBetween(repo.root, base, branchName)) {
        if (attached.has(commit.sha)) continue
        rows.push({
          sha: commit.sha,
          message: commit.message,
          author: null,
          committedAt: commit.committedAt,
          attached: false,
        })
      }
    }
    rows.sort((a, b) => (b.committedAt ?? '').localeCompare(a.committedAt ?? ''))

    const now = context.now().getTime()
    for (const row of rows) {
      const subject = (row.message ?? '').split('\n')[0] ?? ''
      const when = row.committedAt === null ? '' : ago(now - Date.parse(row.committedAt))
      const who = row.author === null ? '' : `@${row.author}`
      context.output.line(
        [
          context.output.paint('yellow', row.sha.slice(0, 7)),
          subject,
          context.output.paint('dim', [who, when].filter(Boolean).join(' · ')),
          row.attached ? '' : context.output.paint('dim', '(not attached yet)'),
        ]
          .filter(Boolean)
          .join('  '),
      )
    }
    if (rows.length === 0) context.output.line(`No commits linked to #${card.number} yet.`)
    context.output.result('CommitList', rows, meta(session, { count: rows.length }))
  })
}

// ---------------------------------------------------------------------------
// finish (§9.4)
// ---------------------------------------------------------------------------

type CheckName = 'clean' | 'commits' | 'pushed' | 'checklist' | 'tests' | 'pr'

interface Check {
  readonly name: CheckName
  /** null: could not tell (no repo, no gh). */
  readonly ok: boolean | null
  /** A failing blocking check asks before finishing; the others only inform. */
  readonly blocking: boolean
  readonly detail: string
}

/** `checks.test`, through the shell, with its output shown (§9.4 step 5). */
function runTests(command: string, cwd: string, context: Context): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: context.io.env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', () => resolve(127))
    child.on('close', (code) => {
      if (code !== 0) context.output.debug(output)
      resolve(code ?? 1)
    })
  })
}

/** The PR for `branch`, through `gh` when it is installed (§9.1). */
function findPullRequest(
  branch: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ url: string; state: string } | null> {
  if (!onPath('gh', env)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const child = spawn('gh', ['pr', 'view', branch, '--json', 'url,state'], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    const timer = setTimeout(() => child.kill(), 5_000)
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolve(null)
      try {
        const parsed = JSON.parse(output) as { url?: string; state?: string }
        resolve(
          parsed.url === undefined
            ? null
            : { url: parsed.url, state: (parsed.state ?? 'open').toLowerCase() },
        )
      } catch {
        resolve(null)
      }
    })
  })
}

export async function finish(
  context: Context,
  reference: string,
  options: { skipChecks?: boolean; push?: boolean },
): Promise<void> {
  const { config } = await context.config()
  await withBoard(
    context,
    async (session) => {
      const card = await session.card(reference)
      const board = session.board
      const repo = await context.repo()
      const branchName = card.git?.branch ?? (repo === null ? null : await currentBranch(repo.root))
      const base = card.git?.baseBranch ?? config.git.baseBranch
      const checks: Check[] = []

      if (options.skipChecks !== true) {
        if (repo === null || branchName === null) {
          checks.push({
            name: 'clean',
            ok: null,
            blocking: false,
            detail: 'Not in a Git repository: Git checks skipped',
          })
        } else {
          // 1. Working tree clean.
          const dirty = await dirtyFiles(repo.root)
          checks.push({
            name: 'clean',
            ok: dirty.length === 0,
            blocking: config.checks.requireCleanTree,
            detail:
              dirty.length === 0
                ? 'Working tree clean'
                : `Branch ${branchName} has ${plural(dirty.length, 'uncommitted file')}`,
          })
          // 2. At least one commit beyond base.
          const count = (await commitsBetween(repo.root, base, branchName)).length
          checks.push({
            name: 'commits',
            ok: count > 0,
            blocking: true,
            detail:
              count > 0
                ? `${plural(count, 'commit')} on ${branchName}`
                : `No commits on ${branchName} beyond ${base}`,
          })
          // 3. Pushed (offer --push).
          let upstream = await upstreamState(repo.root, branchName)
          if (options.push === true && (upstream.upstream === null || upstream.ahead > 0)) {
            const pushed = await pushBranch(repo.root, branchName)
            if (!pushed.ok) context.output.warn(`Push failed: ${pushed.error.split('\n')[0] ?? ''}`)
            upstream = await upstreamState(repo.root, branchName)
          }
          const isPushed = upstream.upstream !== null && upstream.ahead === 0
          checks.push({
            name: 'pushed',
            ok: isPushed,
            blocking: config.checks.requirePushed,
            detail: isPushed
              ? `Pushed to ${upstream.upstream}`
              : upstream.upstream === null
                ? `${branchName} is not pushed (--push to push it)`
                : `${branchName} is ${plural(upstream.ahead, 'commit')} ahead of ${upstream.upstream} (--push to push it)`,
          })
        }

        // 4. Checklist complete.
        const open = card.checklist.filter((item) => item.doneAt === null).length
        checks.push({
          name: 'checklist',
          ok: card.checklist.length === 0 ? null : open === 0,
          blocking: true,
          detail:
            card.checklist.length === 0
              ? 'No checklist'
              : open === 0
                ? `Checklist complete (${card.checklist.length}/${card.checklist.length})`
                : `${plural(open, 'checklist item')} still open`,
        })

        // 5. Tests, when `checks.test` is configured.
        if (config.checks.test !== undefined && repo !== null) {
          context.output.step(`Running ${config.checks.test}`)
          const code = await runTests(config.checks.test, repo.root, context)
          checks.push({
            name: 'tests',
            ok: code === 0,
            blocking: true,
            detail: code === 0 ? 'Tests passed' : `Tests failed (exit ${code})`,
          })
        }

        // 6. PR exists (informational).
        if (repo !== null && branchName !== null) {
          const pr = await findPullRequest(branchName, repo.root, context.io.env)
          checks.push({
            name: 'pr',
            ok: pr === null ? null : true,
            blocking: false,
            detail: pr === null ? 'No pull request found' : `PR ${pr.url} (${pr.state})`,
          })
        }

        for (const check of checks) {
          if (check.ok === true) context.output.success(check.detail)
          else if (check.ok === false && check.blocking) context.output.warn(check.detail)
          else context.output.line(`${context.output.paint('dim', '·')} ${check.detail}`)
        }

        const failing = checks.filter((check) => check.ok === false && check.blocking)
        if (failing.length > 0) {
          if (!context.prompter.canAsk) {
            throw precondition(
              `${plural(failing.length, 'check')} did not pass. Fix them, or pass --skip-checks.`,
            )
          }
          if (!(await context.prompter.confirm('Continue anyway?', false))) {
            throw precondition('Not finished: the checks above did not pass.')
          }
        }
      }

      // Refresh what the card knows about its branch, then move it along.
      const queuedAtStart = board.queued
      if (repo !== null && branchName !== null) {
        const summary = await summarize(repo.root, base, branchName)
        if (summary !== null) await board.cards.updateGit(card.number, summary)
      }
      const column = finishColumn(board.state.columns, config.flow.finishColumn)
      if (column === undefined) throw precondition('This board has no review or done column.')
      const queuedBefore = board.queued
      if (card.column !== column.key) await board.cards.move(card.number, column.key)
      context.output.success(`#${card.number} → ${column.name}`)
      if (board.queued > Math.min(queuedBefore, queuedAtStart))
        context.output.warn('queued (offline): the board will catch up when the server is back')

      context.output.result(
        'Finish',
        {
          card: board.state.cards[card.number] ?? card,
          checks,
          skipped: options.skipChecks === true,
          column: column.key,
        },
        meta(session),
      )
    },
    { queue: true },
  )
}

export type { Card }
