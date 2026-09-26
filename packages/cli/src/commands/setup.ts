/**
 * `yuzie hooks install|uninstall`, `yuzie config get|set`, and the internal
 * `yuzie __hook` the installed shims call (SPEC.md §7.2, §9.5, §13.2).
 */
import { GitPreconditionError } from '@yuzie/core'
import { type HookName, installHooks, type Repo, uninstallHooks } from '@yuzie/git'
import {
  type ConfigLayer,
  getPath,
  parseValue,
  setPath,
  userConfigPath,
  writeLayer,
} from '../config.js'
import type { Context } from '../context.js'
import { UsageError } from '../exit.js'

export async function requireRepo(context: Context): Promise<Repo> {
  const repo = await context.repo()
  if (repo === null) {
    throw new GitPreconditionError(
      'git_precondition_failed',
      'Not inside a git repository. Run this from your project, or `git init` first.',
    )
  }
  return repo
}

export async function hooksInstall(context: Context): Promise<void> {
  const repo = await requireRepo(context)
  const names = (await context.config()).config.git.hooks as HookName[]
  const results = await installHooks(repo.root, names)
  const changed = results.filter((r) => r.changed)
  if (changed.length === 0)
    context.output.success(`Git hooks already installed (${names.join(', ')})`)
  else context.output.success(`Installed git hooks (${names.join(', ')})`)
  context.output.result('Hooks', { installed: results })
}

export async function hooksUninstall(context: Context): Promise<void> {
  const repo = await requireRepo(context)
  const results = await uninstallHooks(repo.root)
  const removed = results.filter((r) => r.changed).map((r) => r.name)
  context.output.success(
    removed.length === 0
      ? 'No yuzie hooks were installed'
      : `Removed git hooks (${removed.join(', ')})`,
  )
  context.output.result('Hooks', { removed: results })
}

export async function configGet(context: Context, key: string | undefined): Promise<void> {
  const { config, path } = await context.config()
  const value = key === undefined ? config : getPath(config, key)
  if (key === undefined || (typeof value === 'object' && value !== null)) {
    context.output.line(JSON.stringify(value, null, 2))
  } else {
    context.output.line(value === undefined ? '' : String(value))
  }
  context.output.result('ConfigValue', { key: key ?? null, value: value ?? null }, { file: path })
}

export async function configSet(
  context: Context,
  key: string,
  raw: string,
  options: { global?: boolean },
): Promise<void> {
  const loaded = await context.config()
  let path: string
  let layer: ConfigLayer
  if (options.global === true) {
    path = userConfigPath(context.home)
    const { readFile } = await import('node:fs/promises')
    layer = await readFile(path, 'utf8')
      .then((text) => JSON.parse(text) as ConfigLayer)
      .catch(() => ({}))
  } else {
    if (loaded.path === null) {
      throw new UsageError(
        'Not inside a repository with a .yuzie/config.json.',
        'Run `yuzie init`, or pass --global to set it for your user.',
      )
    }
    path = loaded.path
    layer = loaded.repoLayer
  }

  const value = parseValue(raw)
  const next = setPath(layer, key, value)
  await writeLayer(path, next)
  context.reloadConfig()
  context.output.success(`Set ${key} = ${JSON.stringify(value)} in ${path}`)
  context.output.result('ConfigValue', { key, value }, { file: path })
}
