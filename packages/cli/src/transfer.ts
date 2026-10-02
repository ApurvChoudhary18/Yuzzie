/**
 * `yuzie export` and `yuzie import` formats (SPEC.md §7.2, §14.3): pure
 * functions from a board to text and from text to cards, so each is tested
 * without a server.
 *
 * - **json** is the complete dump: board, columns, labels, members, every card
 *   (with comments, checklist, commits, git and anchor) and the event log.
 * - **md** is for people, and round-trips: `## Column` headings, a `- [ ]`
 *   item per card with `(#4, @rahul, p0, auth, due 2026-10-10)`, nested
 *   checklist items and a `>` description.
 * - **csv** is one row per card, for spreadsheets.
 */
import type {
  Board,
  Card,
  CardImportItem,
  Column,
  EventEnvelope,
  JSON_API_VERSION,
  Label,
  Member,
} from '@yuzie/core'

export const FORMATS = ['json', 'md', 'csv'] as const
export type Format = (typeof FORMATS)[number]

export interface BoardExport {
  readonly apiVersion: typeof JSON_API_VERSION
  readonly kind: 'BoardExport'
  readonly exportedAt: string
  readonly board: Board
  readonly columns: readonly Column[]
  readonly labels: readonly Label[]
  readonly members: readonly Member[]
  readonly cards: readonly Card[]
  readonly events: readonly EventEnvelope[]
}

/** The format a file name implies, if any. */
export function formatOf(path: string): Format | null {
  const extension = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase()
  if (extension === 'json') return 'json'
  if (extension === 'csv') return 'csv'
  if (extension === 'md' || extension === 'markdown') return 'md'
  return null
}

function ordered(dump: BoardExport): Array<{ column: Column; cards: Card[] }> {
  const columns = [...dump.columns].sort((a, b) => (a.rank < b.rank ? -1 : 1))
  return columns.map((column) => ({
    column,
    cards: dump.cards
      .filter((card) => card.column === column.key && card.archivedAt === null)
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0)),
  }))
}

const day = (iso: string | null): string | null => (iso === null ? null : iso.slice(0, 10))

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function toJson(dump: BoardExport): string {
  return `${JSON.stringify(dump, null, 2)}\n`
}

export function toMarkdown(dump: BoardExport): string {
  const out: string[] = [`# ${dump.board.name}`, '']
  out.push(`<!-- yuzie export of ${dump.board.slug}, ${dump.exportedAt} -->`, '')
  for (const { column, cards } of ordered(dump)) {
    out.push(`## ${column.name}`, '')
    for (const card of cards) {
      const done = column.semantics === 'terminal'
      const facts = [
        `#${card.number}`,
        ...card.assignees.map((handle) => `@${handle}`),
        ...(card.priority === null ? [] : [`p${card.priority}`]),
        ...card.labels,
        ...(card.dueAt === null ? [] : [`due ${day(card.dueAt)}`]),
      ]
      out.push(`- [${done ? 'x' : ' '}] ${card.title} (${facts.join(', ')})`)
      if (card.description !== null && card.description.trim().length > 0)
        for (const line of card.description.trim().split('\n')) out.push(`  > ${line}`.trimEnd())
      for (const item of [...card.checklist].sort((a, b) => a.position - b.position))
        out.push(`  - [${item.doneAt === null ? ' ' : 'x'}] ${item.text}`)
    }
    if (cards.length > 0) out.push('')
  }
  return `${out.join('\n').trimEnd()}\n`
}

function csvField(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const CSV_HEADER = [
  'number',
  'title',
  'column',
  'assignees',
  'labels',
  'priority',
  'due',
  'description',
  'checklist',
  'created',
  'updated',
] as const

export function toCsv(dump: BoardExport): string {
  const rows: string[] = [CSV_HEADER.join(',')]
  for (const { column, cards } of ordered(dump)) {
    for (const card of cards) {
      const done = card.checklist.filter((item) => item.doneAt !== null).length
      rows.push(
        [
          card.number,
          card.title,
          column.key,
          card.assignees.map((handle) => `@${handle}`).join(' '),
          card.labels.join(';'),
          card.priority === null ? null : `p${card.priority}`,
          day(card.dueAt),
          card.description,
          card.checklist.length === 0 ? null : `${done}/${card.checklist.length}`,
          card.createdAt,
          card.updatedAt,
        ]
          .map(csvField)
          .join(','),
      )
    }
  }
  return `${rows.join('\r\n')}\r\n`
}

export function render(dump: BoardExport, format: Format): string {
  return format === 'json' ? toJson(dump) : format === 'md' ? toMarkdown(dump) : toCsv(dump)
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * A card read from a file, before it is matched to a board: `column` is
 * whatever the file said, and `done` marks a ticked markdown item with no
 * column of its own.
 */
export interface DraftCard {
  readonly title: string
  readonly column?: string
  readonly done?: boolean
  readonly description?: string
  readonly assignees?: readonly string[]
  readonly labels?: readonly string[]
  readonly priority?: 0 | 1 | 2 | 3
  readonly due?: string
  readonly checklist?: ReadonlyArray<{ text: string; done: boolean }>
}

function priorityOf(value: unknown): 0 | 1 | 2 | 3 | undefined {
  const match = /^p?([0-3])$/i.exec(String(value ?? '').trim())
  return match === null ? undefined : (Number(match[1]) as 0 | 1 | 2 | 3)
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

function list(value: unknown, separator: RegExp): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean)
}

const handles = (value: unknown) => list(value, /[\s,;]+/).map((h) => h.replace(/^@/, ''))

/** Markdown: `## Column`, `- [ ] title (facts)`, nested checklist, `>` description. */
export function parseMarkdown(text: string): DraftCard[] {
  const cards: Array<DraftCard & { checklist: Array<{ text: string; done: boolean }> }> = []
  const descriptions = new Map<number, string[]>()
  let column: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*<!--.*-->\s*$/.test(raw)) continue
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(raw)
    if (heading !== null) {
      column = heading[1]
      continue
    }
    if (/^#\s/.test(raw)) continue
    const item = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(raw)
    if (item !== null) {
      const indent = item[1]?.length ?? 0
      const ticked = item[2] === 'x' || item[2] === 'X'
      const body = (item[3] ?? '').trim()
      const last = cards.at(-1)
      if (indent > 0 && last !== undefined) {
        last.checklist.push({ text: oneLine(body), done: ticked })
        continue
      }
      cards.push({ ...cardFromLine(body), column, done: ticked, checklist: [] })
      continue
    }
    const quote = /^\s+>\s?(.*)$/.exec(raw)
    if (quote !== null && cards.length > 0) {
      const index = cards.length - 1
      descriptions.set(index, [...(descriptions.get(index) ?? []), quote[1] ?? ''])
    }
  }
  return cards.map((card, index) => {
    const description = descriptions.get(index)?.join('\n').trim()
    const { checklist, column: heading, ...rest } = card
    return {
      ...rest,
      ...(heading === undefined ? {} : { column: heading }),
      ...(description ? { description } : {}),
      ...(checklist.length > 0 ? { checklist } : {}),
    }
  })
}

/** `Fix OAuth (#4, @rahul, p0, auth, due 2026-10-10)`: the facts come off the title. */
function cardFromLine(line: string): Omit<DraftCard, 'column' | 'done'> {
  const facts = /^(.*?)\s*\((#\d+(?:,\s*[^)]*)?)\)\s*$/.exec(line)
  if (facts === null) return { title: oneLine(line) }
  const assignees: string[] = []
  const labels: string[] = []
  let priority: 0 | 1 | 2 | 3 | undefined
  let due: string | undefined
  for (const fact of (facts[2] ?? '').split(',').map((part) => part.trim())) {
    if (/^#\d+$/.test(fact)) continue
    if (fact.startsWith('@')) assignees.push(fact.slice(1))
    else if (priorityOf(fact) !== undefined && /^p/i.test(fact)) priority = priorityOf(fact)
    else if (/^due\s+/.test(fact)) due = fact.replace(/^due\s+/, '')
    else if (fact.length > 0) labels.push(fact)
  }
  return {
    title: oneLine(facts[1] ?? line),
    ...(assignees.length > 0 ? { assignees } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(priority === undefined ? {} : { priority }),
    ...(due === undefined ? {} : { due }),
  }
}

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += char
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0))
}

export function parseCsv(text: string): DraftCard[] {
  const [header, ...rows] = parseCsvRows(text.replace(/^﻿/, ''))
  if (header === undefined) return []
  const names = header.map((name) => name.trim().toLowerCase())
  const at = (...aliases: string[]) => names.findIndex((name) => aliases.includes(name))
  const title = at('title', 'name', 'summary')
  if (title === -1) throw new Error('The CSV has no "title" column.')
  const column = at('column', 'status', 'list')
  const description = at('description', 'desc', 'body', 'notes')
  const assignees = at('assignees', 'assignee', 'owner')
  const labels = at('labels', 'label', 'tags')
  const priority = at('priority')
  const due = at('due', 'dueat', 'due date', 'due_date')
  const cell = (row: string[], index: number) => (index === -1 ? '' : (row[index] ?? '').trim())
  return rows
    .filter((row) => cell(row, title).length > 0)
    .map((row) => {
      const p = priorityOf(cell(row, priority))
      const people = handles(cell(row, assignees))
      const tags = list(cell(row, labels), /[;,]/)
      return {
        title: oneLine(cell(row, title)),
        ...(cell(row, column) ? { column: cell(row, column) } : {}),
        ...(cell(row, description) ? { description: cell(row, description) } : {}),
        ...(people.length > 0 ? { assignees: people } : {}),
        ...(tags.length > 0 ? { labels: tags } : {}),
        ...(p === undefined ? {} : { priority: p }),
        ...(cell(row, due) ? { due: cell(row, due) } : {}),
      }
    })
}

/** Our own export, `{ cards: [...] }`, or a bare array of card-like objects. */
export function parseJson(text: string): DraftCard[] {
  const parsed = JSON.parse(text) as unknown
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { cards?: unknown })?.cards)
      ? (parsed as { cards: unknown[] }).cards
      : null
  if (items === null) throw new Error('Expected a yuzie export, or an array of cards.')
  return items.flatMap((raw): DraftCard[] => {
    if (typeof raw === 'string') return raw.trim() ? [{ title: oneLine(raw) }] : []
    if (raw === null || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    if (typeof item.title !== 'string' || item.title.trim().length === 0) return []
    if (item.archivedAt !== undefined && item.archivedAt !== null) return []
    const p = priorityOf(item.priority)
    const people = handles(item.assignees ?? item.assignee)
    const tags = list(item.labels, /[;,]/)
    const checklist = Array.isArray(item.checklist)
      ? item.checklist.flatMap((entry): Array<{ text: string; done: boolean }> => {
          if (typeof entry === 'string') return [{ text: oneLine(entry), done: false }]
          const e = entry as { text?: unknown; done?: unknown; doneAt?: unknown }
          if (typeof e?.text !== 'string') return []
          return [
            {
              text: oneLine(e.text),
              done: e.done === true || (e.doneAt !== undefined && e.doneAt !== null),
            },
          ]
        })
      : []
    const due = item.dueAt ?? item.due
    const column = item.column ?? item.status
    return [
      {
        title: oneLine(item.title),
        ...(typeof column === 'string' ? { column } : {}),
        ...(typeof item.description === 'string' && item.description.trim()
          ? { description: item.description }
          : {}),
        ...(people.length > 0 ? { assignees: people } : {}),
        ...(tags.length > 0 ? { labels: tags } : {}),
        ...(p === undefined ? {} : { priority: p }),
        ...(typeof due === 'string' ? { due } : {}),
        ...(checklist.length > 0 ? { checklist } : {}),
      },
    ]
  })
}

export function parse(text: string, format: Format): DraftCard[] {
  return format === 'json'
    ? parseJson(text)
    : format === 'md'
      ? parseMarkdown(text)
      : parseCsv(text)
}

// ---------------------------------------------------------------------------
// Matching drafts to a board
// ---------------------------------------------------------------------------

export interface Planned {
  readonly items: CardImportItem[]
  /** One line per thing that could not be kept as it was. */
  readonly warnings: string[]
}

/** `2026-10-10` or a full timestamp → an ISO date-time the server accepts. */
function dueAt(value: string): string | null {
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T12:00:00.000Z`
  const time = Date.parse(text)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/**
 * Fit drafts to this board: columns by key, name or unique prefix; assignees
 * only if they are members; everything else that does not fit is dropped with
 * a warning rather than failing the whole file.
 */
export function plan(
  drafts: readonly DraftCard[],
  board: { columns: readonly Column[]; members: readonly Member[] },
  fallbackColumn?: string,
): Planned {
  const columns = [...board.columns].sort((a, b) => (a.rank < b.rank ? -1 : 1))
  const find = (wanted: string): Column | undefined => {
    const lowered = wanted.trim().toLowerCase()
    const exact = columns.find(
      (column) => column.key === lowered || column.name.toLowerCase() === lowered,
    )
    if (exact !== undefined) return exact
    const prefixed = columns.filter(
      (column) => column.key.startsWith(lowered) || column.name.toLowerCase().startsWith(lowered),
    )
    return prefixed.length === 1 ? prefixed[0] : undefined
  }
  const fallback = fallbackColumn === undefined ? columns[0] : find(fallbackColumn)
  if (fallback === undefined) throw new Error(`No column "${fallbackColumn}" on this board.`)
  const terminal = columns.find((column) => column.semantics === 'terminal') ?? columns.at(-1)
  const members = new Set(board.members.map((member) => member.handle))

  const warnings: string[] = []
  const unknownColumns = new Map<string, { fallback: number; done: number }>()
  const strangers = new Set<string>()
  const items = drafts.map((draft): CardImportItem => {
    let column: Column | undefined
    if (draft.column !== undefined) column = find(draft.column)
    if (column === undefined && draft.done === true) column = terminal
    if (draft.column !== undefined && find(draft.column) === undefined) {
      const seen = unknownColumns.get(draft.column) ?? { fallback: 0, done: 0 }
      if (draft.done === true) seen.done += 1
      else seen.fallback += 1
      unknownColumns.set(draft.column, seen)
    }
    const assignees = (draft.assignees ?? []).filter((handle) => {
      if (members.has(handle)) return true
      strangers.add(handle)
      return false
    })
    const due = draft.due === undefined ? null : dueAt(draft.due)
    if (draft.due !== undefined && due === null)
      warnings.push(`"${draft.title}": cannot read the due date "${draft.due}"; left unset`)
    return {
      title: draft.title,
      column: (column ?? fallback).key,
      ...(draft.description === undefined ? {} : { description: draft.description }),
      ...(assignees.length > 0 ? { assignees } : {}),
      ...(draft.labels === undefined ? {} : { labels: [...new Set(draft.labels)] }),
      ...(draft.priority === undefined ? {} : { priority: draft.priority }),
      ...(due === null ? {} : { dueAt: due }),
      ...(draft.checklist === undefined ? {} : { checklist: [...draft.checklist] }),
    }
  })
  const cards = (count: number) => `${count} card${count === 1 ? '' : 's'}`
  for (const [name, { fallback: rest, done }] of unknownColumns) {
    const where = [
      ...(rest > 0 ? [`${cards(rest)} to ${fallback.name}`] : []),
      ...(done > 0 ? [`${done} ticked ${done === 1 ? 'card' : 'cards'} to ${terminal?.name}`] : []),
    ]
    warnings.push(`no column "${name}" on this board: ${where.join(', ')}`)
  }
  if (strangers.size > 0)
    warnings.push(
      `not members of this board, so not assigned: ${[...strangers]
        .sort()
        .map((handle) => `@${handle}`)
        .join(', ')}`,
    )
  return { items, warnings }
}
