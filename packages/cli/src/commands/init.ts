/**
 * `yuzie init` — Journey A (SPEC.md §6.1), line for line:
 *
 *     yuzie · collaborative git-aware kanban
 *
 *     ✓ Git repository detected: payments-api (github.com/acme/payments-api)
 *     ✓ Default branch: main
 *     ? Sign in with GitHub? (Y/n) y
 *     → Opening https://yuzie.dev/device and waiting…
 *       Code: WXYZ-4821
 *     ✓ Signed in as @rahul
 *     ? Board name: (payments-api)
 *     ? Columns: (Todo, Doing, Review, Done)
 *     ✓ Board "payments-api" created
 *     ✓ Wrote .yuzie/config.json
 *     ✓ Added .yuzie/cache/ to .gitignore
 *     ✓ Installed git hooks (post-commit, post-checkout)
 *
 * Idempotent: running it again signs in only if needed, links the board it
 * already made, rewrites nothing that is already right, and never adds a second
 * `.gitignore` line or hook block.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AuthenticationError, type Board, slugify, type User } from '@yuzie/core'
import { type HookName, installHooks } from '@yuzie/git'
import type { YuzieClient } from '@yuzie/sdk'
import { CACHE_IGNORE, type ConfigLayer, repoConfigPath, writeLayer } from '../config.js'
import type { Context } from '../context.js'
import { signIn } from './auth.js'
import { printCheck, runChecks } from './doctor.js'
import { requireRepo } from './setup.js'

const DEFAULT_COLUMNS = ['Todo', 'Doing', 'Review', 'Done']

export interface InitOptions {
  /** `--no-hooks`: the opt-out §20 promises. */
  readonly hooks?: boolean
}

/** Add `.yuzie/cache/` to `.gitignore` unless something already ignores it. */
export async function ignoreCache(root: string): Promise<boolean> {
  const path = join(root, '.gitignore')
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch {
    current = ''
  }
  const covered = current
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) =>
      [
        '.yuzie/cache/',
        '.yuzie/cache',
        '/.yuzie/cache/',
        '/.yuzie/cache',
        '.yuzie/',
        '.yuzie',
        '/.yuzie/',
      ].includes(line),
    )
  if (covered) return false
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
  await writeFile(path, `${current}${separator}${CACHE_IGNORE}\n`, 'utf8')
  return true
}

async function currentUser(context: Context): Promise<{ user: User; client: YuzieClient } | null> {
  if ((await context.token()) === undefined) return null
  const client = await context.client()
  try {
    return { user: (await client.me()).user, client }
  } catch (error) {
    // A stored token the server no longer accepts is the same as none.
    if (error instanceof AuthenticationError) return null
    throw error
  }
}

export async function init(context: Context, options: InitOptions): Promise<void> {
  const { output, prompter } = context

  output.line()
  output.line(output.paint('bold', 'yuzie · collaborative git-aware kanban'))
  output.line()

  const repo = await requireRepo(context)
  output.success(`Git repository detected: ${repo.name} (${repo.remote?.display ?? 'no remote'})`)
  output.success(`Default branch: ${repo.defaultBranch}`)

  // --- sign in -------------------------------------------------------------
  context.requireNetwork('Setting up a board')
  let signedIn = await currentUser(context)
  if (signedIn === null) {
    if (output.json) {
      throw new AuthenticationError(
        'unauthenticated',
        'Not signed in. Run `yuzie login`, then `yuzie init --json`.',
      )
    }
    const proceed = await prompter.confirm('Sign in with GitHub?', true)
    if (!proceed) {
      throw new AuthenticationError(
        'unauthenticated',
        'A board needs an account. Run `yuzie login` when ready.',
      )
    }
    const { user } = await signIn(context)
    signedIn = { user, client: await context.client() }
  }
  const { user, client } = signedIn
  output.success(`Signed in as @${user.handle}`)

  // --- board: link what is configured or already exists, else create -------
  const loaded = await context.config()
  const mine = await client.boards.list()
  let board: Board | undefined =
    loaded.config.board === undefined ? undefined : mine.find((b) => b.slug === loaded.config.board)
  let created = false

  if (board === undefined) {
    const name = await prompter.ask('Board name:', repo.name)
    const existing = mine.find((b) => b.slug === slugify(name, 64))
    if (existing !== undefined) {
      board = existing
    } else {
      const columns = (await prompter.ask('Columns:', DEFAULT_COLUMNS.join(', ')))
        .split(',')
        .map((column) => column.trim())
        .filter((column) => column.length > 0)
      board = await client.boards.create({
        name,
        ...(repo.remote === null ? {} : { repoRemote: repo.remote.display }),
        baseBranch: repo.defaultBranch,
        columns,
      })
      created = true
    }
  }
  output.success(created ? `Board "${board.name}" created` : `Board "${board.name}" linked`)

  // --- config: keep whatever the user already put there ---------------------
  const path = context.options.config ?? repoConfigPath(repo.root)
  const layer: ConfigLayer = {
    ...loaded.repoLayer,
    version: 1,
    board: board.slug,
    server: loaded.config.server,
    git: {
      baseBranch: repo.defaultBranch,
      branchTemplate: board.branchTemplate,
      autoLinkCommits: true,
      hooks: options.hooks === false ? [] : [...loaded.config.git.hooks],
      ...loaded.repoLayer.git,
    },
  }
  const wroteConfig = await writeLayer(path, layer)
  context.reloadConfig()
  output.success(wroteConfig ? 'Wrote .yuzie/config.json' : '.yuzie/config.json is up to date')

  const ignored = await ignoreCache(repo.root)
  output.success(
    ignored ? `Added ${CACHE_IGNORE} to .gitignore` : `.gitignore already ignores ${CACHE_IGNORE}`,
  )

  // --- hooks ----------------------------------------------------------------
  const hookNames = (layer.git?.hooks ?? []) as HookName[]
  let hooks: Awaited<ReturnType<typeof installHooks>> = []
  if (options.hooks === false || hookNames.length === 0) {
    output.line(
      `${output.paint('dim', '–')} Skipped git hooks${options.hooks === false ? ' (--no-hooks)' : ''}`,
    )
  } else {
    hooks = await installHooks(repo.root, hookNames)
    output.success(
      hooks.some((h) => h.changed)
        ? `Installed git hooks (${hookNames.join(', ')})`
        : `Git hooks already installed (${hookNames.join(', ')})`,
    )
  }

  // --- self-check: say something only if something is wrong -----------------
  // (The terminal check is left to `yuzie doctor`: it describes this shell, not this setup.)
  const problems = (await runChecks(context)).filter(
    (c) => (c.status === 'warn' || c.status === 'fail') && c.name !== 'terminal',
  )
  for (const problem of problems) printCheck(context, problem)

  output.line()
  output.line('Invite your team:')
  output.line('  yuzie invite adarsh@acme.dev')
  output.line(`  yuzie share          ${output.paint('dim', '# prints a join link')}`)
  output.line()
  output.line('Next: yuzie add "Fix GitHub OAuth"')

  output.result('Init', {
    repo: {
      root: repo.root,
      name: repo.name,
      remote: repo.remote?.display ?? null,
      defaultBranch: repo.defaultBranch,
    },
    user,
    board: { slug: board.slug, name: board.name, created },
    config: { path, changed: wroteConfig },
    gitignore: { changed: ignored },
    hooks,
    checks: problems,
  })
}
