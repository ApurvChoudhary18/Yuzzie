/**
 * Code anchors (SPEC.md §9.7): a `file:line[-endLine]` on a card, stored
 * relative to the repository root with the commit it was made at, so it can
 * be reported as stale once the file changes.
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { git } from './repo.js'

export class AnchorError extends Error {}

export interface NormalisedAnchor {
  /** Relative to the repository root, `/`-separated. */
  readonly path: string
  readonly line: number | null
  readonly endLine: number | null
  /** On disk, for opening. */
  readonly absolute: string
}

/**
 * Resolve `path` (relative to `cwd`, or absolute) against the repository,
 * and check the file and lines exist.
 */
export async function normaliseAnchor(
  root: string,
  cwd: string,
  input: { readonly path: string; readonly line?: number | null; readonly endLine?: number | null },
): Promise<NormalisedAnchor> {
  const absolute = isAbsolute(input.path) ? input.path : resolve(cwd, input.path)
  const inRepo = relative(root, absolute)
  if (
    inRepo.length === 0 ||
    inRepo.startsWith(`..${sep}`) ||
    inRepo === '..' ||
    isAbsolute(inRepo)
  ) {
    throw new AnchorError(`${input.path} is outside the repository at ${root}.`)
  }
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(absolute)
  } catch {
    throw new AnchorError(`${inRepo.split(sep).join('/')} does not exist.`)
  }
  if (!info.isFile()) throw new AnchorError(`${inRepo.split(sep).join('/')} is not a file.`)

  const line = input.line ?? null
  const endLine = input.endLine ?? null
  if (line !== null) {
    const text = await readFile(absolute, 'utf8')
    const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    const name = inRepo.split(sep).join('/')
    if (line > lines) throw new AnchorError(`${name} has ${lines} lines; there is no line ${line}.`)
    if (endLine !== null && endLine < line)
      throw new AnchorError(`The range ${line}-${endLine} ends before it starts.`)
    if (endLine !== null && endLine > lines)
      throw new AnchorError(`${name} has ${lines} lines; the range ends at ${endLine}.`)
  } else if (endLine !== null) {
    throw new AnchorError('A range needs a start line: file:start-end.')
  }
  return { path: inRepo.split(sep).join('/'), line, endLine, absolute }
}

/**
 * Whether the file changed since the anchor was made: `true` (changed, or
 * gone), `false` (same), or `null` when it cannot be told — no commit was
 * stored, or this clone does not have it.
 */
export async function anchorStale(
  root: string,
  anchor: { readonly path: string; readonly commitSha: string | null },
): Promise<boolean | null> {
  if (anchor.commitSha === null) return null
  if ((await git(root, ['cat-file', '-e', `${anchor.commitSha}^{commit}`])).code !== 0) return null
  try {
    await stat(resolve(root, anchor.path))
  } catch {
    return true
  }
  // Against the working tree: an uncommitted edit moves lines too.
  const diff = await git(root, ['diff', '--quiet', anchor.commitSha, '--', anchor.path])
  if (diff.code === 0) return false
  if (diff.code === 1) return true
  return null
}
