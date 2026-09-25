/**
 * Human formatters for cards (SPEC.md §7.3, §6.6).
 *
 * The list table reproduces the §7.3 sample exactly at 80 columns:
 *
 *     #    TITLE                     ASSIGNEE   COLUMN    BRANCH                 ACT
 *     18   Fix GitHub OAuth          @rahul  ●  Doing     task/18-fix-github…    2m
 *
 * Column widths come from that sample. A wider terminal gives the extra room to
 * TITLE (then BRANCH); a narrower one takes it from TITLE first.
 */
import type { Card, Column, Presence } from '@yuzie/core'
import { pad, plural, priorityLabel, shortAge, shortDate, truncate } from './text.js'

export type Paint = (
  tone: 'green' | 'yellow' | 'red' | 'cyan' | 'dim' | 'bold',
  text: string,
) => string

const plain: Paint = (_tone, text) => text

export interface ListContext {
  readonly columns: readonly Column[]
  readonly presence: readonly Presence[]
  readonly now: Date
  /** Terminal width. */
  readonly width: number
  /** e.g. `synced`, `offline · 2 queued`. */
  readonly status: string
  readonly paint?: Paint
}

/** The last time anything happened to a card, for ACT and for `--stale`. */
export function lastActivity(card: Card): number {
  const git = card.git?.lastActivityAt
  return Math.max(
    Date.parse(card.updatedAt),
    git === null || git === undefined ? 0 : Date.parse(git),
  )
}

export function columnName(columns: readonly Column[], key: string): string {
  return columns.find((column) => column.key === key)?.name ?? key
}

export function isDoneColumn(columns: readonly Column[], key: string): boolean {
  return columns.find((column) => column.key === key)?.semantics === 'terminal'
}

/** `●` the assignee is working on this card right now; `✓` it is done; else blank. */
function stateSymbol(card: Card, context: ListContext, paint: Paint): string {
  if (isDoneColumn(context.columns, card.column)) return paint('green', '✓')
  const working = context.presence.some(
    (person) =>
      person.state === 'working' &&
      person.cardNo === card.number &&
      card.assignees.includes(person.handle),
  )
  return working ? paint('green', '●') : ' '
}

function assigneeLabel(card: Card): string {
  const [first, ...rest] = card.assignees
  if (first === undefined) return '—'
  const extra = rest.length === 0 ? '' : `+${rest.length}`
  return truncate(`@${first}`, 8 - extra.length) + extra
}

/** Column widths for a terminal `total` characters wide. */
function layout(total: number) {
  const widths = { number: 5, title: 26, assignee: 11, column: 10, branch: 23 }
  const base = 80
  if (total > base) {
    const extra = total - base
    const toTitle = Math.min(extra, 34)
    widths.title += toTitle
    widths.branch += Math.min(extra - toTitle, 17)
  } else if (total < base) {
    let short = base - total
    const fromTitle = Math.min(short, widths.title - 14)
    widths.title -= fromTitle
    short -= fromTitle
    widths.branch -= Math.min(short, widths.branch - 12)
  }
  return widths
}

export function renderCardList(cards: readonly Card[], context: ListContext): string {
  const paint = context.paint ?? plain
  const widths = layout(context.width)
  const lines = [
    `${pad('#', widths.number)}${pad('TITLE', widths.title)}${pad('ASSIGNEE', widths.assignee)}${pad('COLUMN', widths.column)}${pad('BRANCH', widths.branch)}ACT`,
  ].map((line) => paint('dim', line))

  for (const card of cards) {
    const assignee = `${pad(assigneeLabel(card), 8)}${stateSymbol(card, context, paint)}  `
    const branch = card.git?.branch ?? '—'
    lines.push(
      pad(String(card.number), widths.number) +
        pad(truncate(card.title, widths.title - 2), widths.title) +
        assignee +
        pad(truncate(columnName(context.columns, card.column), widths.column - 1), widths.column) +
        pad(truncate(branch, widths.branch - 4), widths.branch) +
        shortAge(context.now.getTime() - lastActivity(card)),
    )
  }

  const online = context.presence.length
  lines.push('', `${plural(cards.length, 'card')} · ${online} online · ${context.status}`)
  return `${lines.join('\n')}\n`
}

export interface DetailContext {
  readonly columns: readonly Column[]
  readonly presence: readonly Presence[]
  readonly now: Date
  readonly paint?: Paint
}

/** `yuzie card <id>` — everything about one card, read-only (§7.2, §6.6). */
export function renderCardDetail(card: Card, context: DetailContext): string {
  const paint = context.paint ?? plain
  const label = (name: string) => paint('dim', pad(name, 8))
  const lines: string[] = []

  lines.push(`${paint('bold', `#${card.number}`)}  ${paint('bold', card.title)}`)
  const facts = [
    columnName(context.columns, card.column),
    card.assignees.length === 0 ? 'unassigned' : card.assignees.map((h) => `@${h}`).join(', '),
    ...(card.priority === null ? [] : [priorityLabel(card.priority)]),
    ...(card.dueAt === null ? [] : [`due ${shortDate(card.dueAt, context.now)}`]),
    ...(card.labels.length === 0 ? [] : [card.labels.join(', ')]),
  ]
  lines.push(facts.join(' · '))

  const working = context.presence.filter((p) => p.cardNo === card.number && p.state !== 'online')
  for (const person of working) {
    lines.push(
      paint(
        'green',
        `● @${person.handle} is ${person.state === 'working' ? 'working on this' : 'viewing'}`,
      ),
    )
  }

  if (card.git?.branch) {
    const stats = [
      plural(card.git.commits, 'commit'),
      plural(card.git.filesChanged, 'file'),
      ...(card.git.pushed ? ['pushed'] : []),
      ...(card.git.prUrl === null ? [] : [card.git.prUrl]),
    ]
    lines.push(`${label('Branch')}${card.git.branch}  ${paint('dim', `(${stats.join(' · ')})`)}`)
  }
  if (card.anchor !== null) {
    const range =
      card.anchor.line === null
        ? ''
        : card.anchor.endLine === null || card.anchor.endLine === card.anchor.line
          ? `:${card.anchor.line}`
          : `:${card.anchor.line}-${card.anchor.endLine}`
    lines.push(`${label('Code')}${card.anchor.path}${range}`)
  }
  if (card.watchers.length > 0) {
    lines.push(`${label('Watch')}${card.watchers.map((h) => `@${h}`).join(', ')}`)
  }
  lines.push(
    `${label('Updated')}${shortAge(context.now.getTime() - lastActivity(card))} ago${card.createdBy === null ? '' : ` · created by @${card.createdBy}`}`,
  )

  if (card.description !== null && card.description.trim().length > 0) {
    lines.push('', card.description.trimEnd())
  }

  if (card.checklist.length > 0) {
    const done = card.checklist.filter((item) => item.doneAt !== null).length
    lines.push('', paint('bold', `Checklist  ${done}/${card.checklist.length}`))
    for (const item of [...card.checklist].sort((a, b) => a.position - b.position)) {
      const mark = item.doneAt === null ? '○' : paint('green', '✓')
      lines.push(`  ${mark} ${item.position}. ${item.text}`)
    }
  }

  if (card.comments.length > 0) {
    lines.push('', paint('bold', 'Comments'))
    for (const comment of card.comments) {
      lines.push(
        `  ${paint('cyan', `@${comment.author}`)} ${paint('dim', `· ${shortAge(context.now.getTime() - Date.parse(comment.createdAt))} ago`)}`,
      )
      for (const line of comment.body.split('\n')) lines.push(`    ${line}`)
    }
  }

  return `${lines.join('\n')}\n`
}
