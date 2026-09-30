/**
 * Knowing when there is a newer yuzie (SPEC.md §18 Session 17).
 *
 * At most once a day a detached background process asks the npm registry for
 * the latest version and writes the answer to `~/.yuzie/update.json`. A
 * command never waits on it. When that file says something newer exists, one
 * dim line on stderr says so — at most once a day, only to a person at a
 * terminal, never under `--json`, `--quiet` or CI, and never with
 * `YUZIE_NO_UPDATE_CHECK=1` or `ui.updateCheck: false`.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nodeFetch } from '@yuzie/sdk/node'
import { VERSION } from './version.js'

export const PACKAGE = '@yuzie/cli'
export const DAY_MS = 86_400_000
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

type Env = Readonly<Record<string, string | undefined>>

export interface UpdateState {
  /** When the registry was last asked. */
  readonly checkedAt: number
  /** What it said was latest; null when it could not say. */
  readonly latest: string | null
  /** When a person was last told about it. */
  readonly notifiedAt: number
}

export function statePath(home: string): string {
  return join(home, '.yuzie', 'update.json')
}

export function readState(home: string): UpdateState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(home), 'utf8')) as Partial<UpdateState>
    return {
      checkedAt: Number(parsed.checkedAt) || 0,
      latest: typeof parsed.latest === 'string' ? parsed.latest : null,
      notifiedAt: Number(parsed.notifiedAt) || 0,
    }
  } catch {
    return { checkedAt: 0, latest: null, notifiedAt: 0 }
  }
}

function writeState(home: string, state: UpdateState): void {
  try {
    mkdirSync(dirname(statePath(home)), { recursive: true })
    writeFileSync(statePath(home), `${JSON.stringify(state)}\n`)
  } catch {
    // An unwritable home only means asking again tomorrow.
  }
}

/** `1.2.10` > `1.2.9`; a prerelease sorts before its release. Unparseable → not newer. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (version: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version.trim())
    return match === null
      ? null
      : { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null }
  }
  const a = parse(candidate)
  const b = parse(current)
  if (a === null || b === null) return false
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  if (a.pre === null) return b.pre !== null
  if (b.pre === null) return false
  return a.pre > b.pre
}

export function registry(env: Env): string {
  return (env.YUZIE_REGISTRY_URL ?? env.npm_config_registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '')
}

/** The latest published version, or null when the registry cannot say. */
export async function latestVersion(env: Env, timeoutMs = 3_000): Promise<string | null> {
  try {
    const response = await nodeFetch(`${registry(env)}/${PACKAGE.replace('/', '%2F')}/latest`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = JSON.parse(await response.text()) as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

export function checksAllowed(
  env: Env,
  options: { json?: boolean; quiet?: boolean; configured?: boolean },
): boolean {
  if (env.YUZIE_NO_UPDATE_CHECK === '1' || env.NO_UPDATE_NOTIFIER !== undefined) return false
  if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') return false
  if (options.configured === false) return false
  return options.json !== true && options.quiet !== true
}

/** `yuzie __update-check`: ask the registry and remember the answer. */
export async function updateCheck(home: string, env: Env, now = Date.now()): Promise<void> {
  const previous = readState(home)
  writeState(home, { ...previous, checkedAt: now })
  const latest = await latestVersion(env)
  writeState(home, { ...readState(home), checkedAt: now, latest: latest ?? previous.latest })
}

/**
 * After a command: start tomorrow's check if one is due, and return the line
 * to show if a newer version is known and today's nudge has not been shown.
 */
export function afterCommand(
  home: string,
  env: Env,
  launch: { execPath: string; script: string | undefined },
  now = Date.now(),
): string | null {
  const state = readState(home)
  if (now - state.checkedAt >= DAY_MS && launch.script !== undefined) {
    writeState(home, { ...state, checkedAt: now })
    try {
      const child = spawn(launch.execPath, [launch.script, '__update-check'], {
        detached: true,
        stdio: 'ignore',
        env: { ...env },
      })
      child.on('error', () => {})
      child.unref()
    } catch {
      // No background check today; there is always tomorrow.
    }
  }
  if (state.latest === null || !isNewer(state.latest, VERSION)) return null
  if (now - state.notifiedAt < DAY_MS) return null
  writeState(home, { ...readState(home), notifiedAt: now })
  return `yuzie ${state.latest} is available (you have ${VERSION}) — run \`yuzie upgrade\`. Silence with YUZIE_NO_UPDATE_CHECK=1.`
}

export type Installer = 'npx' | 'npm' | 'pnpm' | 'yarn' | 'bun'

/** How this copy was installed, from where it runs. */
export function installer(script: string | undefined): Installer {
  const path = script ?? ''
  if (/[\\/]_npx[\\/]/.test(path)) return 'npx'
  if (/[\\/]pnpm[\\/]|[\\/]\.pnpm[\\/]|pnpm-global/.test(path)) return 'pnpm'
  if (/[\\/]\.bun[\\/]/.test(path)) return 'bun'
  if (/[\\/]yarn[\\/]|[\\/]\.yarn[\\/]/.test(path)) return 'yarn'
  return 'npm'
}

export function upgradeCommand(how: Installer): string[] | null {
  switch (how) {
    case 'npx':
      return null
    case 'pnpm':
      return ['pnpm', 'add', '--global', `${PACKAGE}@latest`]
    case 'yarn':
      return ['yarn', 'global', 'add', `${PACKAGE}@latest`]
    case 'bun':
      return ['bun', 'add', '--global', `${PACKAGE}@latest`]
    case 'npm':
      return ['npm', 'install', '--global', `${PACKAGE}@latest`]
  }
}
