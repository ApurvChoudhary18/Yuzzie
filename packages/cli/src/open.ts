/**
 * What `yuzie open` and the TUI's `o` and `g` open (SPEC.md §9.7, §6.6), and
 * opening it — one code path for both.
 *
 * Where there is no terminal (a pipe, CI), nothing is launched: the target is
 * printed instead (§18 Session 12).
 */
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import type { Card } from '@yuzie/core'
import {
  anchorStale,
  compareUrl,
  EditorNotFoundError,
  onPath,
  pullsApiUrl,
  type Repo,
  resolveEditor,
  webRepo,
} from '@yuzie/git'
import { RuntimeError, UsageError } from './exit.js'

type Env = Readonly<Record<string, string | undefined>>

export type OpenTarget =
  | {
      readonly kind: 'editor'
      readonly program: string
      readonly args: readonly string[]
      /** `src/auth/oauth.ts:42` */
      readonly location: string
    }
  | {
      readonly kind: 'url'
      readonly url: string
      /** What the page is: a PR, the compare view, or a link on the card. */
      readonly page: 'pr' | 'compare' | 'link'
    }

export interface PullRequest {
  readonly url: string
  readonly state: string
}

/** Whether launching is allowed here: a terminal, and not CI. */
export function canLaunch(env: Env, stdoutIsTTY: boolean): boolean {
  return stdoutIsTTY && (env.CI === undefined || env.CI === '' || env.CI === 'false')
}

/** Whether `program` can be run: an executable path, or a name on PATH. */
function installed(program: string, env: Env): boolean {
  if (program.includes('/')) {
    try {
      accessSync(program, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  return onPath(program, env)
}

/** The editor, at the card's anchor. */
export function editorTarget(card: Card, repo: Repo | null, env: Env): OpenTarget {
  const anchor = card.anchor
  if (anchor === null) {
    throw new UsageError(
      `#${card.number} has no code anchor.`,
      `Add one: yuzie anchor ${card.number} path/to/file.ts:42`,
    )
  }
  if (repo === null) {
    throw new UsageError(
      `#${card.number} points at ${anchor.path}, but this is not a Git repository.`,
      'Run it from the repository the card is about.',
    )
  }
  const path = `${repo.root}/${anchor.path}`
  try {
    const editor = resolveEditor(env, path, anchor.line)
    if (!installed(editor.program, env)) {
      throw new RuntimeError(
        `The editor "${editor.program}" (from $${editor.source}) is not installed or not on PATH.`,
        'Set $YUZIE_EDITOR or $EDITOR to one you have, e.g. export EDITOR="code --wait".',
      )
    }
    return {
      kind: 'editor',
      program: editor.program,
      args: editor.args,
      location: `${anchor.path}${anchor.line === null ? '' : `:${anchor.line}`}`,
    }
  } catch (error) {
    if (error instanceof EditorNotFoundError)
      throw new RuntimeError(error.message, 'Set $YUZIE_EDITOR, then try again.')
    throw error
  }
}

function run(
  program: string,
  args: readonly string[],
  env: Env,
  timeoutMs: number,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, [...args], {
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: 127, stdout: '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout })
    })
  })
}

/**
 * The pull request for `branch`: through `gh` when it is installed, else the
 * GitHub REST API with `GH_TOKEN`/`GITHUB_TOKEN`, else null. Every failure is
 * silent — the caller falls back to the compare view (§18 Session 12).
 */
export async function findPullRequest(
  branch: string,
  repo: Repo,
  env: Env,
  fetcher: typeof fetch = fetch,
): Promise<PullRequest | null> {
  if (onPath('gh', env)) {
    const viaGh = await run('gh', ['pr', 'view', branch, '--json', 'url,state'], env, 5_000)
    if (viaGh.code === 0) {
      try {
        const parsed = JSON.parse(viaGh.stdout) as { url?: string; state?: string }
        if (parsed.url !== undefined)
          return { url: parsed.url, state: (parsed.state ?? 'open').toLowerCase() }
      } catch {
        // Fall through to the API.
      }
    }
  }
  const remote = repo.remote
  const web = remote === null ? null : webRepo(remote.url)
  const api = web === null ? null : pullsApiUrl(web, branch)
  const token = env.GH_TOKEN || env.GITHUB_TOKEN
  if (api === null) return null
  try {
    const response = await fetcher(api, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return null
    const pulls = (await response.json()) as Array<{
      html_url?: string
      state?: string
      merged_at?: string | null
    }>
    const pull = pulls[0]
    if (pull?.html_url === undefined) return null
    return {
      url: pull.html_url,
      state: pull.merged_at ? 'merged' : (pull.state ?? 'open').toLowerCase(),
    }
  } catch {
    return null
  }
}

/** The first web link on the card: in its description, else in a comment. */
export function attachedLink(card: Card): string | null {
  const texts = [card.description ?? '', ...card.comments.map((comment) => comment.body)]
  for (const text of texts) {
    const found = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/.exec(text)
    if (found !== null) return found[0]
  }
  return null
}

/**
 * The web page for a card: its PR (`--pr`, and `--github` when there is one),
 * else the branch compare view; or a link attached to the card (`--browser`).
 */
export async function webTarget(
  card: Card,
  repo: Repo | null,
  env: Env,
  page: 'github' | 'pr' | 'browser',
  defaults: { baseBranch: string },
  fetcher?: typeof fetch,
): Promise<OpenTarget> {
  if (page === 'browser') {
    const link = attachedLink(card)
    if (link === null) {
      throw new UsageError(
        `#${card.number} has no link attached.`,
        'Put a URL in its description or a comment, or use --github for its branch.',
      )
    }
    return { kind: 'url', url: link, page: 'link' }
  }

  const branch = card.git?.branch ?? null
  if (branch === null) {
    throw new UsageError(
      `#${card.number} has no branch yet.`,
      `Claim it (yuzie claim ${card.number}) or link one (yuzie branch ${card.number} --link <name>).`,
    )
  }
  if (card.git?.prUrl) return { kind: 'url', url: card.git.prUrl, page: 'pr' }
  const remote = repo?.remote ?? null
  const web = remote === null ? null : webRepo(remote.url)
  if (repo !== null) {
    const pr = await findPullRequest(branch, repo, env, fetcher)
    if (pr !== null) return { kind: 'url', url: pr.url, page: 'pr' }
  }
  if (web === null) {
    throw new UsageError(
      `No web page for ${branch}: this repository has no remote on a forge.`,
      'Add one: git remote add origin <url>.',
    )
  }
  const base = card.git?.baseBranch ?? defaults.baseBranch
  return { kind: 'url', url: compareUrl(web, base, branch), page: 'compare' }
}

/** How a URL is opened on this platform. */
function browserCommand(env: Env): [string, string[]] {
  if (env.BROWSER) return [env.BROWSER, []]
  if (process.platform === 'darwin') return ['open', []]
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '""']]
  return ['xdg-open', []]
}

/**
 * Open it. An editor gets the terminal and is waited for; a browser is left
 * to run on its own. An editor that will not start is a clear error, exit 1.
 */
export async function launch(target: OpenTarget, env: Env): Promise<void> {
  if (target.kind === 'url') {
    const [program, args] = browserCommand(env)
    await new Promise<void>((resolve) => {
      const child = spawn(program, [...args, target.url], {
        env: env as NodeJS.ProcessEnv,
        stdio: 'ignore',
        detached: true,
      })
      child.on('error', () => resolve())
      child.on('spawn', () => {
        child.unref()
        resolve()
      })
    })
    return
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(target.program, [...target.args], {
      env: env as NodeJS.ProcessEnv,
      stdio: 'inherit',
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        new RuntimeError(
          error.code === 'ENOENT'
            ? `Could not start the editor "${target.program}": it is not installed or not on PATH.`
            : `Could not start the editor "${target.program}": ${error.message}`,
          'Set $YUZIE_EDITOR or $EDITOR to an editor you have, e.g. export EDITOR="code --wait".',
        ),
      )
    })
    child.on('close', () => resolve())
  })
}

/** How a target reads when printed instead of opened. */
export function describeTarget(target: OpenTarget): string {
  if (target.kind === 'url') return target.url
  return [target.program, ...target.args]
    .map((part) => (/\s/.test(part) ? `'${part}'` : part))
    .join(' ')
}

/** Whether a card's anchor is stale in this checkout (§9.7): for `yuzie card`, `open` and the card view. */
export async function staleness(
  repo: Repo | null,
  card: { readonly anchor: { readonly path: string; readonly commitSha: string | null } | null },
): Promise<boolean | null> {
  if (card.anchor === null || repo === null) return null
  return anchorStale(repo.root, card.anchor)
}
