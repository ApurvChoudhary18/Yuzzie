/**
 * Which editor to open, and how to ask it for a line (SPEC.md §9.7).
 *
 * `$YUZIE_EDITOR` → `$VISUAL` → `$EDITOR` → the first of `code`, `cursor`,
 * `subl`, `nvim`, `vim` on PATH → a helpful error. Each editor spells "open
 * at line N" its own way; the table below knows how.
 */
import { accessSync, constants } from 'node:fs'
import { basename, delimiter, join } from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

export const DETECTED_EDITORS = ['code', 'cursor', 'subl', 'nvim', 'vim'] as const

export interface EditorCommand {
  /** The program, e.g. `code`. */
  readonly program: string
  /** Everything after it: the configured flags, then the file (and line). */
  readonly args: readonly string[]
  /** Where the choice came from. */
  readonly source: 'YUZIE_EDITOR' | 'VISUAL' | 'EDITOR' | 'detected'
}

export class EditorNotFoundError extends Error {
  constructor() {
    super(
      'No editor found. Set $YUZIE_EDITOR or $EDITOR (e.g. `export EDITOR="code --wait"`), or install one of: code, cursor, subl, nvim, vim.',
    )
  }
}

/** `path:line` (or `path:line-end`) → `code -g`, `+line`, … per editor. */
export function lineArgs(program: string, path: string, line: number | null): string[] {
  if (line === null) return [path]
  const name = basename(program).replace(/\.(exe|cmd)$/i, '')
  switch (name) {
    case 'code':
    case 'code-insiders':
    case 'cursor':
    case 'codium':
    case 'windsurf':
      return ['-g', `${path}:${line}`]
    case 'subl':
    case 'zed':
    case 'hx':
    case 'helix':
      return [`${path}:${line}`]
    case 'idea':
    case 'webstorm':
    case 'pycharm':
    case 'goland':
      return ['--line', String(line), path]
    case 'mate':
      return ['-l', String(line), path]
    default:
      // vi, vim, nvim, nano, emacs, micro, kak and most others.
      return [`+${line}`, path]
  }
}

/** Split `code --wait` into program and flags, respecting simple quotes. */
export function splitCommand(command: string): string[] {
  const parts: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of command.matchAll(pattern)) parts.push(match[1] ?? match[2] ?? match[3] ?? '')
  return parts
}

/** Whether `program` is an executable on PATH. */
export function onPath(program: string, env: Env): boolean {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    try {
      accessSync(join(directory, program), constants.X_OK)
      return true
    } catch {
      // Not here.
    }
  }
  return false
}

export function resolveEditor(
  env: Env,
  path: string,
  line: number | null,
  available: (program: string) => boolean = (program) => onPath(program, env),
): EditorCommand {
  for (const source of ['YUZIE_EDITOR', 'VISUAL', 'EDITOR'] as const) {
    const configured = env[source]?.trim()
    if (configured === undefined || configured.length === 0) continue
    const [program, ...flags] = splitCommand(configured)
    if (program === undefined) continue
    return { program, args: [...flags, ...lineArgs(program, path, line)], source }
  }
  const found = DETECTED_EDITORS.find((program) => available(program))
  if (found === undefined) throw new EditorNotFoundError()
  return { program: found, args: lineArgs(found, path, line), source: 'detected' }
}
