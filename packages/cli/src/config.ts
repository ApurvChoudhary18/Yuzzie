/**
 * `.yuzie/config.json` (SPEC.md §13.2), layered and validated.
 *
 * Lowest to highest precedence:
 *
 *   1. built-in defaults
 *   2. `~/.yuzie/config.json` — the user's own preferences
 *   3. the repo's `.yuzie/config.json`, or the file named by `--config`
 *   4. environment: `YUZIE_SERVER`, `YUZIE_BOARD`
 *   5. flags: `--board`
 *
 * Every layer is validated on its own before merging, so a typo is reported
 * against the file it is in. Secrets never live here (§13.2); tokens are in the
 * credential store.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HOOK_NAMES } from '@yuzie/git'
import { DEFAULT_BASE_URL } from '@yuzie/sdk'
import { z } from 'zod'
import { UsageError } from './exit.js'

export const CONFIG_DIR = '.yuzie'
export const CONFIG_FILE = 'config.json'
export const CACHE_IGNORE = '.yuzie/cache/'
/** Journey A installs these two (§6.1); `pre-push` is opt-in. */
export const DEFAULT_HOOKS = ['post-commit', 'post-checkout'] as const

const GitSchema = z.object({
  baseBranch: z.string().min(1),
  branchTemplate: z.string().min(1),
  autoLinkCommits: z.boolean(),
  hooks: z.array(z.enum(HOOK_NAMES)),
})
const FlowSchema = z.object({
  startColumn: z.string().min(1),
  finishColumn: z.string().min(1),
  doneColumn: z.string().min(1),
})
const ChecksSchema = z.object({
  test: z.string().min(1).optional(),
  requireCleanTree: z.boolean(),
  requirePushed: z.boolean(),
})
const UiSchema = z.object({
  theme: z.enum(['dark', 'light', 'auto']),
  compact: z.boolean(),
  showGitBadges: z.boolean(),
})

/** One file's worth: everything optional, nothing unknown. */
export const ConfigLayerSchema = z.strictObject({
  version: z.literal(1).optional(),
  board: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  server: z.url().optional(),
  git: GitSchema.partial().strict().optional(),
  flow: FlowSchema.partial().strict().optional(),
  checks: ChecksSchema.partial().strict().optional(),
  ui: UiSchema.partial().strict().optional(),
})
export type ConfigLayer = z.infer<typeof ConfigLayerSchema>

export interface ResolvedConfig {
  readonly version: 1
  readonly board: string | undefined
  readonly workspace: string | undefined
  readonly server: string
  readonly git: z.infer<typeof GitSchema>
  readonly flow: z.infer<typeof FlowSchema>
  readonly checks: z.infer<typeof ChecksSchema>
  readonly ui: z.infer<typeof UiSchema>
}

export const DEFAULTS: ResolvedConfig = {
  version: 1,
  board: undefined,
  workspace: undefined,
  server: DEFAULT_BASE_URL,
  git: {
    baseBranch: 'main',
    branchTemplate: 'task/{id}-{slug}',
    autoLinkCommits: true,
    hooks: [...DEFAULT_HOOKS],
  },
  flow: { startColumn: 'doing', finishColumn: 'review', doneColumn: 'done' },
  checks: { requireCleanTree: true, requirePushed: false },
  ui: { theme: 'dark', compact: false, showGitBadges: true },
}

export interface LoadOptions {
  /** Where to look for the repo's `.yuzie/config.json`. */
  readonly root: string | null
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** `--config <path>` */
  readonly configPath?: string
  /** `--board <slug>` */
  readonly board?: string
}

export interface LoadedConfig {
  readonly config: ResolvedConfig
  /** The file `yuzie config set` and `yuzie init` write to, whether or not it exists yet. */
  readonly path: string | null
  /** The repo file as written, so rewrites keep what the user put there. */
  readonly repoLayer: ConfigLayer
}

export function repoConfigPath(root: string): string {
  return join(root, CONFIG_DIR, CONFIG_FILE)
}

export function userConfigPath(home: string): string {
  return join(home, CONFIG_DIR, CONFIG_FILE)
}

async function readLayer(path: string): Promise<ConfigLayer> {
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new UsageError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      `Fix the file, or delete it and run \`yuzie init\`.`,
    )
  }
  const parsed = ConfigLayerSchema.safeParse(raw)
  if (!parsed.success) {
    const problem = parsed.error.issues[0]
    const where = problem?.path.join('.') || '(root)'
    throw new UsageError(
      `${path}: ${where}: ${problem?.message ?? 'invalid'}`,
      'See SPEC.md §13.2 for the file format, or run `yuzie config set <key> <value>`.',
    )
  }
  return parsed.data
}

function merge(base: ResolvedConfig, layer: ConfigLayer): ResolvedConfig {
  return {
    version: 1,
    board: layer.board ?? base.board,
    workspace: layer.workspace ?? base.workspace,
    server: layer.server ?? base.server,
    git: { ...base.git, ...layer.git },
    flow: { ...base.flow, ...layer.flow },
    checks: { ...base.checks, ...layer.checks },
    ui: { ...base.ui, ...layer.ui },
  }
}

export async function loadConfig(options: LoadOptions): Promise<LoadedConfig> {
  const path = options.configPath ?? (options.root === null ? null : repoConfigPath(options.root))
  const userLayer = await readLayer(userConfigPath(options.home))
  const repoLayer = path === null ? {} : await readLayer(path)

  let config = merge(merge(DEFAULTS, userLayer), repoLayer)

  const server = options.env.YUZIE_SERVER?.trim()
  if (server !== undefined && server.length > 0) {
    if (!z.url().safeParse(server).success) {
      throw new UsageError(`YUZIE_SERVER is not a URL: ${server}`)
    }
    config = { ...config, server }
  }
  const envBoard = options.env.YUZIE_BOARD?.trim()
  if (envBoard !== undefined && envBoard.length > 0) config = { ...config, board: envBoard }
  if (options.board !== undefined) config = { ...config, board: options.board }

  return { config, path, repoLayer }
}

/** Write a layer back, pretty-printed and newline-terminated so diffs stay small. */
export async function writeLayer(path: string, layer: ConfigLayer): Promise<boolean> {
  const next = `${JSON.stringify(layer, null, 2)}\n`
  let current: string | null = null
  try {
    current = await readFile(path, 'utf8')
  } catch {
    current = null
  }
  if (current === next) return false
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, next, 'utf8')
  return true
}

// ---------------------------------------------------------------------------
// `yuzie config get|set`
// ---------------------------------------------------------------------------

/** Read a dotted path such as `git.baseBranch`. */
export function getPath(config: ResolvedConfig, key: string): unknown {
  let value: unknown = config
  for (const part of key.split('.')) {
    if (typeof value !== 'object' || value === null || !(part in value)) {
      throw new UsageError(`Unknown config key: ${key}`, 'Run `yuzie config get` to see every key.')
    }
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/** Parse a value typed on the command line: JSON when it is valid JSON, a string otherwise. */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/** Set a dotted path on a layer, validating the result against the schema. */
export function setPath(layer: ConfigLayer, key: string, value: unknown): ConfigLayer {
  const parts = key.split('.')
  const next = structuredClone(layer) as Record<string, unknown>
  let cursor = next
  for (const part of parts.slice(0, -1)) {
    const child = cursor[part]
    if (child === undefined) cursor[part] = {}
    else if (typeof child !== 'object' || child === null) {
      throw new UsageError(`${key}: ${part} is not a section`)
    }
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts.at(-1) as string] = value

  const parsed = ConfigLayerSchema.safeParse({ version: 1, ...next })
  if (!parsed.success) {
    const problem = parsed.error.issues[0]
    const unknown = problem?.code === 'unrecognized_keys'
    throw new UsageError(
      unknown ? `Unknown config key: ${key}` : `${key}: ${problem?.message ?? 'invalid value'}`,
      'Run `yuzie config get` to see every key and its current value.',
    )
  }
  return parsed.data
}
