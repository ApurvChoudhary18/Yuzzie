/**
 * `yuzie edit` (SPEC.md §7.2): the card as YAML front matter plus a markdown
 * body, opened in `$EDITOR`, turned back into the smallest PATCH that says what
 * changed.
 *
 *     ---
 *     title: Fix GitHub OAuth
 *     priority: p1
 *     due: 2026-10-02
 *     labels: [bug, auth]
 *     ---
 *
 *     The callback returns 500 when the state param is missing.
 */
import { spawn } from 'node:child_process'
import type { Card, CardUpdateRequest } from '@yuzie/core'
import { Document, isSeq, parse } from 'yaml'
import { parseDue, parsePriority } from './dates.js'
import { UsageError } from './exit.js'

const FENCE = '---'

function localDate(iso: string): string {
  const date = new Date(iso)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function toDocument(card: Card): string {
  const document = new Document({
    title: card.title,
    priority: card.priority === null ? null : `p${card.priority}`,
    due: card.dueAt === null ? null : localDate(card.dueAt),
    labels: card.labels,
  })
  // `labels: [bug, auth]` on one line reads and edits better than a block list.
  const labels = document.get('labels', true)
  if (isSeq(labels)) labels.flow = true
  const front = document.toString({ flowCollectionPadding: false, lineWidth: 0 })
  return [
    FENCE,
    `# Editing #${card.number}. Save and close to apply; close without saving to cancel.`,
    '# priority: p0-p3 or blank · due: YYYY-MM-DD, friday, +3d, or blank',
    front.trimEnd(),
    FENCE,
    '',
    card.description ?? '',
  ]
    .join('\n')
    .replace(/\n*$/, '\n')
}

interface Edited {
  readonly title: string
  readonly priority: 0 | 1 | 2 | 3 | null
  /** As typed: a date the user may not have touched. */
  readonly due: string | null
  readonly labels: string[]
  readonly description: string | null
}

export function parseDocument(text: string): Edited {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== FENCE) {
    throw new UsageError('The file must start with the --- front matter it was opened with.')
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE)
  if (close === -1) throw new UsageError('The front matter has no closing ---.')

  let front: Record<string, unknown>
  try {
    front = (parse(lines.slice(1, close).join('\n')) ?? {}) as Record<string, unknown>
  } catch (error) {
    throw new UsageError(
      `The front matter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const title = typeof front.title === 'string' ? front.title.trim() : ''
  if (title.length === 0) throw new UsageError('title cannot be empty.')

  const rawPriority = front.priority
  const priority =
    rawPriority === null || rawPriority === undefined || rawPriority === ''
      ? null
      : parsePriority(String(rawPriority))

  const rawDue = front.due
  const due =
    rawDue === null || rawDue === undefined || rawDue === ''
      ? null
      : rawDue instanceof Date
        ? rawDue.toISOString().slice(0, 10)
        : String(rawDue)

  const rawLabels = front.labels ?? []
  if (
    !Array.isArray(rawLabels) ||
    rawLabels.some((label) => typeof label !== 'string' || label.trim() === '')
  ) {
    throw new UsageError('labels must be a list of names, e.g. [bug, auth].')
  }
  const labels = [...new Set((rawLabels as string[]).map((label) => label.trim()))]

  const body = lines
    .slice(close + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '')
  return { title, priority, due, labels, description: body.length === 0 ? null : body }
}

/** Only what changed. An empty object means "nothing to do". */
export function diffCard(card: Card, edited: Edited, now: Date = new Date()): CardUpdateRequest {
  const patch: Record<string, unknown> = {}
  if (edited.title !== card.title) patch.title = edited.title
  if (edited.priority !== card.priority) patch.priority = edited.priority
  // Compare the day meant, not the text typed: `friday` over `2026-10-02` is no change
  // when that Friday is the 2nd.
  const before = card.dueAt === null ? null : localDate(card.dueAt)
  const dueAt = edited.due === null ? null : parseDue(edited.due, now)
  const after = dueAt === null ? null : localDate(dueAt)
  if (after !== before) patch.dueAt = dueAt
  const sorted = (list: readonly string[]) => [...list].sort().join('\u0000')
  if (sorted(edited.labels) !== sorted(card.labels)) patch.labels = edited.labels
  if ((edited.description ?? '') !== (card.description ?? '').trimEnd())
    patch.description = edited.description
  return patch as CardUpdateRequest
}

/** Open `$VISUAL`, else `$EDITOR`, else `vi`, and wait for it to close. */
export function runEditor(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const editor = env.VISUAL || env.EDITOR || 'vi'
  return new Promise((resolve, reject) => {
    // Through the shell, so an EDITOR like `code --wait` works as it does in git.
    const child = spawn('sh', ['-c', `${editor} "$1"`, 'sh', path], {
      stdio: 'inherit',
      env: env as NodeJS.ProcessEnv,
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new UsageError(`${editor} exited with ${code}; nothing was changed.`))
    })
  })
}
