/**
 * `yuzie doctor` (SPEC.md §15): a self-check that says what is wrong and the
 * exact command that fixes it. `yuzie init` runs the same checks and prints
 * only the ones that are not fine.
 */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { resolve } from 'node:path'
import {
  EXIT_OFFLINE,
  EXIT_RUNTIME,
  EXIT_UNAUTHENTICATED,
  initialState,
  isBoardError,
} from '@yuzie/core'
import { currentBranch, dirtyFiles, gitVersion, type HookName, hookStatus } from '@yuzie/git'
import { openCache, resolveCacheLocation } from '@yuzie/store'
import type { Context } from '../context.js'
import { tailLog } from '../log.js'
import { describeOp } from '../reconcile.js'
import { redactValue } from '../redact.js'
import { VERSION } from '../version.js'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

export interface Check {
  readonly name: string
  readonly status: CheckStatus
  readonly detail: string
  /** The exit code this failure maps to (§7.4); only for `fail`. */
  readonly exitCode?: number
}

const MIN_NODE_MAJOR = 22

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

export async function runChecks(context: Context): Promise<Check[]> {
  const checks: Check[] = []
  const env = context.io.env

  const node = process.versions.node
  const major = Number(node.split('.')[0])
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { name: 'node', status: 'ok', detail: `node v${node} (supported)` }
      : {
          name: 'node',
          status: 'fail',
          detail: `node v${node} is too old → install Node ${MIN_NODE_MAJOR} or newer`,
          exitCode: EXIT_RUNTIME,
        },
  )

  const git = await gitVersion(context.io.cwd)
  checks.push(
    git === null
      ? {
          name: 'git',
          status: 'fail',
          detail: 'git not found → install git',
          exitCode: EXIT_RUNTIME,
        }
      : { name: 'git', status: 'ok', detail: `git ${git}` },
  )

  const truecolor = /truecolor|24bit/i.test(env.COLORTERM ?? '')
  const unicode = /utf-?8/i.test(env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? '')
  checks.push(
    truecolor && unicode
      ? { name: 'terminal', status: 'ok', detail: 'terminal supports truecolor + unicode' }
      : {
          name: 'terminal',
          status: 'warn',
          detail: `terminal: ${truecolor ? 'truecolor' : 'no truecolor'}, ${unicode ? 'unicode' : 'no UTF-8 locale'} → the board will use fewer colours`,
        },
  )

  if (context.options.offline === true) {
    checks.push({ name: 'auth', status: 'skip', detail: 'authentication not checked (--offline)' })
    checks.push({ name: 'server', status: 'skip', detail: 'server not checked (--offline)' })
  } else {
    const server = await context.server()
    const token = await context.token()
    if (token === undefined) {
      checks.push({
        name: 'auth',
        status: 'fail',
        detail: 'not signed in → run `yuzie login`',
        exitCode: EXIT_UNAUTHENTICATED,
      })
    }
    try {
      const client = token === undefined ? await context.anonymousClient() : await context.client()
      const health = await client.health()
      if (token !== undefined) {
        try {
          const me = await client.me()
          checks.push({ name: 'auth', status: 'ok', detail: `authenticated as @${me.user.handle}` })
        } catch (error) {
          checks.push({
            name: 'auth',
            status: 'fail',
            detail: `${isBoardError(error) ? error.message : 'token rejected'} → run \`yuzie login\``,
            exitCode: EXIT_UNAUTHENTICATED,
          })
        }
      }
      checks.push({
        name: 'server',
        status: 'ok',
        detail: `server reachable (${health.latencyMs} ms)`,
      })
    } catch {
      checks.push({
        name: 'server',
        status: 'fail',
        // Nothing on this machine's address is a server not started, not a network fault.
        detail: /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(server)
          ? `server unreachable: ${server} → start one with \`yuzie serve\`, or set YUZIE_SERVER`
          : `server unreachable: ${server} → check the network, or YUZIE_SERVER`,
        exitCode: EXIT_OFFLINE,
      })
    }
  }

  const repo = await context.repo()
  const { config } = await context.config()
  if (repo === null) {
    checks.push({ name: 'hooks', status: 'skip', detail: 'hooks: not in a git repository' })
  } else {
    const wanted = config.git.hooks as HookName[]
    const missing = (await hookStatus(repo.root, wanted)).filter(
      (hook) => hook.state !== 'installed',
    )
    checks.push(
      missing.length === 0
        ? {
            name: 'hooks',
            status: 'ok',
            detail: `hooks installed (${wanted.join(', ') || 'none configured'})`,
          }
        : {
            name: 'hooks',
            status: 'warn',
            detail: `hooks: ${missing.map((hook) => hook.name).join(', ')} not installed → run \`yuzie hooks install\``,
          },
    )
  }

  if (config.board === undefined) {
    checks.push({
      name: 'cache',
      status: 'skip',
      detail: 'cache: no board configured → run `yuzie init`',
    })
  } else {
    const location = resolveCacheLocation({
      boardSlug: config.board,
      cwd: context.io.cwd,
      home: context.home,
      env,
    })
    if (!existsSync(location.path)) {
      checks.push({
        name: 'cache',
        status: 'ok',
        detail: 'cache not created yet (it fills on first sync)',
      })
    } else {
      try {
        const cache = openCache({ boardSlug: config.board, location: location.path, env })
        try {
          const cards = cache.cards.count(config.board)
          const synced = cache.sync.get(config.board).syncedAt
          checks.push({
            name: 'cache',
            status: 'ok',
            detail: `cache healthy (${cards} cards, ${synced === null ? 'never synced' : `last sync ${ago(Date.now() - synced)}`})`,
          })

          // The outbox (§18 Session 13): what is waiting, and what was set aside.
          const queued = cache.outbox.size(config.board)
          const aside = cache.outbox.quarantined(config.board)
          const state = initialState({
            columns: cache.columns.list(config.board),
            cards: Object.fromEntries(cache.cards.list(config.board).map((c) => [c.number, c])),
          })
          if (queued > 0) {
            checks.push({
              name: 'outbox',
              status: 'warn',
              detail: `${queued} change${queued === 1 ? '' : 's'} queued, not on the server yet → run \`yuzie sync\``,
            })
          } else if (aside.length === 0) {
            checks.push({ name: 'outbox', status: 'ok', detail: 'nothing queued' })
          }
          for (const entry of aside) {
            const card = /\/cards\/(\d+)/.exec(entry.op.path)?.[1]
            checks.push({
              name: 'outbox',
              status: 'warn',
              detail: `set aside: ${card === undefined ? '' : `#${card} `}${describeOp(entry.op, state)} — refused ${entry.attempts}× (${entry.lastError ?? 'no reason given'}) → \`yuzie sync --retry-set-aside\` or \`--drop-set-aside\``,
            })
          }
        } finally {
          cache.close()
        }
      } catch (error) {
        checks.push({
          name: 'cache',
          status: 'warn',
          detail: `cache unreadable (${error instanceof Error ? error.message : String(error)}) → delete ${location.path}; it rebuilds on sync`,
        })
      }
    }
  }

  return checks
}

export function printCheck(context: Context, check: Check): void {
  const { output } = context
  if (check.status === 'ok') output.success(check.detail)
  else if (check.status === 'warn') output.warn(check.detail)
  else if (check.status === 'fail') output.fail(check.detail)
  else output.line(`${output.paint('dim', '–')} ${output.paint('dim', check.detail)}`)
}

export async function doctor(
  context: Context,
  options: { bundle?: boolean | string } = {},
): Promise<number> {
  const checks = await runChecks(context)
  for (const check of checks) printCheck(context, check)
  const failed = checks.find((check) => check.status === 'fail')
  if (options.bundle !== undefined && options.bundle !== false) {
    const path = await writeBundle(
      context,
      checks,
      typeof options.bundle === 'string' ? options.bundle : undefined,
    )
    context.output.success(`Wrote a diagnostic bundle: ${path}`)
    context.output.line(
      context.output.paint(
        'dim',
        '  Tokens, passwords and your home directory are redacted. Read it before you share it.',
      ),
    )
    context.output.result('Doctor', { checks, bundle: path }, { ok: failed === undefined })
    // A bundle is asked for when something is wrong: writing it is the success.
    return 0
  }
  context.output.result('Doctor', { checks }, { ok: failed === undefined })
  return failed?.exitCode ?? 0
}

/**
 * `yuzie doctor --bundle` (SPEC.md §15, §18 Session 16): everything needed to
 * diagnose a problem in one file — versions, the checks above, config with
 * secrets stripped, the last 200 log lines, and Git facts — redacted before it
 * is written.
 */
export async function buildBundle(
  context: Context,
  checks: readonly Check[],
): Promise<Record<string, unknown>> {
  const env = context.io.env
  const { config, path: configPath } = await context.config()
  const repo = await context.repo().catch(() => null)
  let gitFacts: Record<string, unknown> = { repository: false }
  if (repo !== null) {
    const [branch, dirty, hooks] = await Promise.all([
      currentBranch(repo.root).catch(() => null),
      dirtyFiles(repo.root).catch(() => []),
      hookStatus(repo.root, config.git.hooks as HookName[]).catch(() => []),
    ])
    gitFacts = {
      repository: true,
      root: repo.root,
      remote: repo.remote === null ? null : { host: repo.remote.host, path: repo.remote.path },
      defaultBranch: repo.defaultBranch,
      currentBranch: branch,
      uncommittedFiles: dirty.length,
      hooks: hooks.map((hook) => ({ name: hook.name, state: hook.state })),
    }
  }
  let cache: Record<string, unknown> = { board: config.board ?? null }
  if (config.board !== undefined) {
    const location = resolveCacheLocation({
      boardSlug: config.board,
      cwd: context.io.cwd,
      home: context.home,
      env,
    })
    cache = {
      ...cache,
      path: location.path,
      scope: location.scope,
      exists: existsSync(location.path),
    }
  }
  const bundle = {
    generatedAt: new Date().toISOString(),
    yuzie: VERSION,
    node: process.versions.node,
    platform: `${platform()} ${release()} ${arch()}`,
    terminal: {
      term: env.TERM ?? null,
      colorterm: env.COLORTERM ?? null,
      lang: env.LANG ?? env.LC_ALL ?? null,
      ci: env.CI !== undefined,
      columns: (context.io.stdout as { columns?: number }).columns ?? null,
    },
    checks,
    config: { path: configPath, resolved: config },
    environment: Object.fromEntries(
      Object.entries(env)
        .filter(([name]) => name.startsWith('YUZIE_') || name === 'NO_COLOR')
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    git: { version: await gitVersion(context.io.cwd), ...gitFacts },
    cache,
    log: tailLog(context.home, BUNDLE_LOG_LINES),
  }
  return redactValue(bundle, context.home) as Record<string, unknown>
}

export const BUNDLE_LOG_LINES = 200

async function writeBundle(
  context: Context,
  checks: readonly Check[],
  target: string | undefined,
): Promise<string> {
  const bundle = await buildBundle(context, checks)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const path = resolve(context.io.cwd, target ?? `yuzie-diagnostics-${stamp}.json`)
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 })
  return path
}
