/**
 * Git hooks (SPEC.md §9.5, §14.1).
 *
 * Each hook gets a small marked block that calls the installed `yuzie` binary.
 * The rules, all enforced here:
 *
 *   - **Never fail a Git operation.** The block ends in `|| true`, discards all
 *     output unless the hook itself chooses to print, and does nothing when
 *     `yuzie` is not on PATH.
 *   - **Preserve what is already there.** An existing hook keeps its content;
 *     the block is appended, and uninstall removes only the block.
 *   - **Idempotent.** Installing twice leaves one block; the content is fixed,
 *     so it can be printed before writing and diffed afterwards.
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hooksDirectory } from './repo.js'

export const HOOK_NAMES = ['post-commit', 'post-checkout', 'pre-push'] as const
export type HookName = (typeof HOOK_NAMES)[number]

const BEGIN = '# >>> yuzie >>>'
const END = '# <<< yuzie <<<'

/** The exact block written for `name`. */
export function hookBlock(name: HookName): string {
  return [
    BEGIN,
    '# Managed by `yuzie hooks install`; remove with `yuzie hooks uninstall`.',
    '# It only calls the yuzie binary on your PATH, and can never fail this git command.',
    `command -v yuzie >/dev/null 2>&1 && yuzie __hook ${name} "$@" </dev/null || true`,
    END,
  ].join('\n')
}

const BLOCK_PATTERN = new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`, 'g')

export type HookState = 'installed' | 'missing' | 'outdated'

export interface HookStatus {
  readonly name: HookName
  readonly path: string
  readonly state: HookState
}

async function readHook(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function hookStatus(
  root: string,
  names: readonly HookName[] = HOOK_NAMES,
): Promise<HookStatus[]> {
  const directory = await hooksDirectory(root)
  return Promise.all(
    names.map(async (name) => {
      const path = join(directory, name)
      const content = await readHook(path)
      const state: HookState =
        content === null || !content.includes(BEGIN)
          ? 'missing'
          : content.includes(hookBlock(name))
            ? 'installed'
            : 'outdated'
      return { name, path, state }
    }),
  )
}

export interface InstallResult {
  readonly name: HookName
  readonly path: string
  /** False when the hook was already exactly right. */
  readonly changed: boolean
}

export async function installHooks(
  root: string,
  names: readonly HookName[],
): Promise<InstallResult[]> {
  const directory = await hooksDirectory(root)
  await mkdir(directory, { recursive: true })

  const results: InstallResult[] = []
  for (const name of names) {
    const path = join(directory, name)
    const existing = await readHook(path)
    const block = hookBlock(name)

    const theirs = (existing ?? '')
      .replace(BLOCK_PATTERN, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n*$/, '')
    const onlyOurs = theirs.trim() === '' || theirs.trim() === '#!/bin/sh'

    let next: string
    if (existing !== null && existing.split(BEGIN).length === 2 && existing.includes(block)) {
      next = existing // Already exactly right: leave it byte for byte.
    } else if (onlyOurs) {
      next = `#!/bin/sh\n${block}\n`
    } else {
      // Their content first, then ours; an older block of ours is dropped.
      next = `${theirs}\n\n${block}\n`
    }

    const changed = next !== existing
    if (changed) await writeFile(path, next, 'utf8')
    // Always ensure it is executable; a hook without +x is silently ignored by git.
    await chmod(path, 0o755)
    results.push({ name, path, changed })
  }
  return results
}

/** Remove our block from each hook; delete the file only if nothing else was in it. */
export async function uninstallHooks(
  root: string,
  names: readonly HookName[] = HOOK_NAMES,
): Promise<InstallResult[]> {
  const directory = await hooksDirectory(root)
  const results: InstallResult[] = []
  for (const name of names) {
    const path = join(directory, name)
    const existing = await readHook(path)
    if (existing === null || !existing.includes(BEGIN)) {
      results.push({ name, path, changed: false })
      continue
    }
    const remaining = existing
      .replace(BLOCK_PATTERN, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n*$/, '\n')
    if (remaining.trim() === '' || remaining.trim() === '#!/bin/sh') await rm(path)
    else await writeFile(path, remaining, 'utf8')
    results.push({ name, path, changed: true })
  }
  return results
}
