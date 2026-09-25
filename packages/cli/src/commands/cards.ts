/**
 * Card commands (SPEC.md §7.2 "Cards — the core"): add, list, card, move,
 * assign, done, comment, edit, rm, watch, unwatch, check, label, due, priority.
 *
 * Each one renders for people or as a `--json` envelope (§7.3), and fails
 * through the exit codes of §7.4.
 */
import { mkdtemp, readFile, rm as remove, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AnchorInput, type Card, type Column, NotFoundError } from '@yuzie/core'
import { matchColumn } from '@yuzie/sdk'
import type { Context } from '../context.js'
import { parseDue, parseDuration, parsePriority } from '../dates.js'
import { diffCard, parseDocument, runEditor, toDocument } from '../edit.js'
import { UsageError } from '../exit.js'
import {
  columnName,
  isDoneColumn,
  lastActivity,
  renderCardDetail,
  renderCardList,
} from '../render/cards.js'
import { shortDate } from '../render/text.js'
import { type BoardSession, withBoard } from '../session.js'

function paintFor(context: Context) {
  return (tone: Parameters<Context['output']['paint']>[0], text: string) =>
    context.output.paint(tone, text)
}

function meta(session: BoardSession, extra: Record<string, unknown> = {}) {
  return { boardSlug: session.slug, synced: session.online && session.board.queued === 0, ...extra }
}

function stripHandle(handle: string): string {
  return handle.replace(/^@/, '')
}

function requireColumn(session: BoardSession, reference: string): Column {
  const column = matchColumn(session.board.state.columns, reference)
  if (column === undefined) {
    const names = session.board.state.columns.map((c) => c.name).join(', ')
    throw new NotFoundError(
      'column_not_found',
      `No column "${reference}" on ${session.slug} (columns: ${names})`,
      {
        details: { boardSlug: session.slug, column: reference },
      },
    )
  }
  return column
}

function label(card: Card): string {
  return `#${card.number} ${card.title}`
}

/** `src/auth/oauth.ts:42` or `src/auth/oauth.ts:42-60`. */
export function parseAnchor(input: string): AnchorInput {
  const match = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(input.trim())
  if (match === null || (match[1] as string).length === 0) {
    throw new UsageError(
      `Cannot read "${input}" as a code location.`,
      'Use file:line, e.g. src/auth/oauth.ts:42.',
    )
  }
  return {
    path: match[1] as string,
    ...(match[2] === undefined ? {} : { line: Number(match[2]) }),
    ...(match[3] === undefined ? {} : { endLine: Number(match[3]) }),
  }
}

// ---------------------------------------------------------------------------

export interface AddOptions {
  desc?: string
  assign?: string[]
  column?: string
  label?: string[]
  due?: string
  anchor?: string
  priority?: string
}

export async function add(context: Context, words: string[], options: AddOptions): Promise<void> {
  const title = words.join(' ').trim()
  if (title.length === 0)
    throw new UsageError('A card needs a title: `yuzie add "Fix GitHub OAuth"`.')
  await withBoard(context, async (session) => {
    const column = options.column === undefined ? undefined : requireColumn(session, options.column)
    const card = await session.board.cards.create({
      title,
      ...(options.desc === undefined ? {} : { description: options.desc }),
      ...(column === undefined ? {} : { column: column.key }),
      ...(options.assign === undefined ? {} : { assignees: options.assign.map(stripHandle) }),
      ...(options.label === undefined ? {} : { labels: options.label }),
      ...(options.due === undefined
        ? {}
        : { dueAt: parseDue(options.due, context.now()) ?? undefined }),
      ...(options.priority === undefined
        ? {}
        : { priority: parsePriority(options.priority) ?? undefined }),
      ...(options.anchor === undefined ? {} : { anchor: parseAnchor(options.anchor) }),
    })
    const where = columnName(session.board.state.columns, card.column)
    if (card.number < 0)
      context.output.success(
        `Queued "${card.title}" in ${where} (offline; it gets a number when synced)`,
      )
    else context.output.success(`Created ${label(card)} in ${where}`)
    context.output.result('Card', card, meta(session, card.number < 0 ? { queued: true } : {}))
  })
}

// ---------------------------------------------------------------------------

export interface ListOptions {
  status?: string
  column?: string
  assignee?: string
  label?: string
  mine?: boolean
  watching?: boolean
  stale?: string
  search?: string
  limit?: string
  sort?: string
}

const SORTS = ['updated', 'rank', 'created', 'due', 'priority'] as const

export async function list(context: Context, options: ListOptions): Promise<void> {
  const sort = options.sort ?? 'updated'
  if (!(SORTS as readonly string[]).includes(sort)) {
    throw new UsageError(`--sort must be one of ${SORTS.join(', ')}.`)
  }
  const limit = options.limit === undefined ? undefined : Number(options.limit)
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new UsageError('--limit must be a positive whole number.')
  }
  const stale = options.stale === undefined ? undefined : parseDuration(options.stale)

  await withBoard(context, async (session) => {
    const state = session.board.state
    const now = context.now()
    const columnRef = options.status ?? options.column
    const column = columnRef === undefined ? undefined : requireColumn(session, columnRef)
    const me = session.board.handle
    if ((options.mine || options.watching) && me === null) {
      throw new UsageError(
        '--mine and --watching need to know who you are, which needs the network.',
      )
    }

    let cards = Object.values(state.cards)
    if (column !== undefined) cards = cards.filter((card) => card.column === column.key)
    if (options.assignee !== undefined) {
      const who = stripHandle(options.assignee)
      cards = cards.filter((card) => card.assignees.includes(who))
    }
    if (options.label !== undefined)
      cards = cards.filter((card) => card.labels.includes(options.label as string))
    if (options.mine) cards = cards.filter((card) => card.assignees.includes(me as string))
    if (options.watching) cards = cards.filter((card) => card.watchers.includes(me as string))
    if (options.search !== undefined) {
      const needle = options.search.toLowerCase()
      cards = cards.filter(
        (card) =>
          card.title.toLowerCase().includes(needle) ||
          (card.description ?? '').toLowerCase().includes(needle),
      )
    }
    if (stale !== undefined) {
      // Stale means nothing has happened for a while on work that is not finished.
      cards = cards.filter(
        (card) =>
          !isDoneColumn(state.columns, card.column) && now.getTime() - lastActivity(card) >= stale,
      )
    }

    const compare: Record<(typeof SORTS)[number], (a: Card, b: Card) => number> = {
      updated: (a, b) => lastActivity(b) - lastActivity(a),
      rank: (a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0),
      created: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      due: (a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'),
      priority: (a, b) => (a.priority ?? 9) - (b.priority ?? 9),
    }
    cards.sort((a, b) => compare[sort as (typeof SORTS)[number]](a, b) || a.number - b.number)
    if (limit !== undefined) cards = cards.slice(0, limit)

    if (!context.output.json) {
      context.output.line(
        renderCardList(cards, {
          columns: state.columns,
          presence: await session.presence(),
          now,
          width: context.width,
          status: session.status(),
          paint: paintFor(context),
        }).trimEnd(),
      )
    }
    context.output.result('CardList', cards, meta(session, { count: cards.length }))
  })
}

export async function show(context: Context, reference: string): Promise<void> {
  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    if (!context.output.json) {
      context.output.line(
        renderCardDetail(card, {
          columns: session.board.state.columns,
          presence: await session.presence(),
          now: context.now(),
          paint: paintFor(context),
        }).trimEnd(),
      )
    }
    context.output.result('Card', card, meta(session))
  })
}

export async function move(context: Context, reference: string, columnRef: string): Promise<void> {
  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    const column = requireColumn(session, columnRef)
    const moved = await session.board.cards.move(card.number, column.key)
    context.output.success(`Moved ${label(card)} → ${column.name}`)
    context.output.result('Card', moved, meta(session))
  })
}

export async function done(context: Context, reference: string): Promise<void> {
  await withBoard(context, async (session) => {
    const { config } = await context.config()
    const columns = session.board.state.columns
    const column =
      matchColumn(columns, config.flow.doneColumn) ??
      columns.find((c) => c.semantics === 'terminal')
    if (column === undefined) {
      throw new NotFoundError('column_not_found', `Board ${session.slug} has no done column`, {
        details: { boardSlug: session.slug },
      })
    }
    const card = await session.card(reference)
    const moved = await session.board.cards.move(card.number, column.key)
    context.output.success(`Moved ${label(card)} → ${column.name}`)
    context.output.result('Card', moved, meta(session))
  })
}

export async function assign(
  context: Context,
  reference: string,
  handles: string[],
  options: { clear?: boolean },
): Promise<void> {
  const add = handles.map(stripHandle)
  if (add.length === 0 && options.clear !== true) {
    throw new UsageError('Name someone to assign: `yuzie assign 18 @rahul`, or pass --clear.')
  }
  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    const remove = options.clear === true ? card.assignees.filter((h) => !add.includes(h)) : []
    const updated = await session.board.cards.assign(card.number, { add, remove })
    const members = session.board.state.members
    const who = add.map((handle) => {
      const agent = members.find((m) => m.handle === handle)?.kind === 'agent'
      return `@${handle}${agent ? ' (agent)' : ''}`
    })
    if (who.length > 0) context.output.success(`#${card.number} assigned to ${who.join(', ')}`)
    if (remove.length > 0)
      context.output.success(`#${card.number} unassigned ${remove.map((h) => `@${h}`).join(', ')}`)
    context.output.result('Card', updated, meta(session))
  })
}

async function readStdin(context: Context): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of context.io.stdin as unknown as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function editText(context: Context, initial: string, name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yuzie-'))
  const path = join(dir, name)
  try {
    await writeFile(path, initial, 'utf8')
    await runEditor(path, context.io.env)
    return await readFile(path, 'utf8')
  } finally {
    await remove(dir, { recursive: true, force: true })
  }
}

export async function comment(
  context: Context,
  reference: string,
  words: string[],
  options: { editor?: boolean },
): Promise<void> {
  let body = words.join(' ')
  if (options.editor === true) body = await editText(context, '', 'COMMENT.md')
  else if (body === '-') body = await readStdin(context)
  body = body.trim()
  if (body.length === 0)
    throw new UsageError(
      'A comment needs some text: `yuzie comment 18 "…"`, `-` for stdin, or --editor.',
    )

  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    const created = await session.board.cards.comment(card.number, body)
    context.output.success(`Commented on ${label(card)}`)
    context.output.result('Comment', created, meta(session))
  })
}

export async function edit(context: Context, reference: string): Promise<void> {
  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    const text = await editText(context, toDocument(card), `card-${card.number}.md`)
    const patch = diffCard(card, parseDocument(text), context.now())
    const fields = Object.keys(patch)
    if (fields.length === 0) {
      context.output.line(`No changes to ${label(card)}.`)
      context.output.result('Card', card, meta(session, { changed: [] }))
      return
    }
    const updated = await session.board.cards.update(card.number, patch)
    context.output.success(`Updated #${card.number} (${fields.join(', ')})`)
    context.output.result('Card', updated, meta(session, { changed: fields }))
  })
}

export async function rm(context: Context, reference: string): Promise<void> {
  if (context.output.json && context.options.yes !== true) {
    throw new UsageError(
      'Deleting a card needs confirmation.',
      'Pass --yes to delete without being asked.',
    )
  }
  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    const sure =
      context.options.yes === true ||
      (await context.prompter.confirm(`Delete ${label(card)}?`, false))
    if (!sure) {
      context.output.line('Kept it.')
      return
    }
    await session.board.cards.delete(card.number)
    context.output.success(`Deleted ${label(card)}`)
    context.output.result('Deleted', { kind: 'card', id: card.number }, meta(session))
  })
}

export async function watch(context: Context, reference: string, watching: boolean): Promise<void> {
  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    await session.board.cards.watch(card.number, watching)
    context.output.success(`${watching ? 'Watching' : 'Stopped watching'} ${label(card)}`)
    context.output.result('Watch', { number: card.number, watching }, meta(session))
  })
}

export async function check(
  context: Context,
  reference: string,
  item: string,
  words: string[],
  options: { done?: boolean; undone?: boolean },
): Promise<void> {
  if (options.done === true && options.undone === true)
    throw new UsageError('Pass --done or --undone, not both.')
  await withBoard(context, async (session) => {
    const card = await session.card(reference)

    if (item === 'add') {
      const text = words.join(' ').trim()
      if (text.length === 0)
        throw new UsageError('`yuzie check 18 add <text>` needs the item text.')
      const updated = await session.board.cards.addChecklistItem(card.number, text)
      const added = [...updated.checklist].sort((a, b) => b.position - a.position)[0]
      if (added === undefined) throw new UsageError('The item was not added.')
      context.output.success(`Added item ${added.position} to ${label(card)}: ${added.text}`)
      context.output.result('ChecklistItem', added, meta(session))
      return
    }

    const position = Number(item)
    const current = card.checklist.find((entry) => entry.position === position)
    if (!Number.isInteger(position) || current === undefined) {
      throw new NotFoundError('card_not_found', `#${card.number} has no checklist item ${item}`, {
        details: { number: card.number, item },
      })
    }
    const doneNow =
      options.done === true ? true : options.undone === true ? false : current.doneAt === null
    const updated = await session.board.cards.check(card.number, position, doneNow)
    const after = updated.checklist.find((entry) => entry.position === position) ?? current
    context.output.success(
      `${doneNow ? 'Checked' : 'Unchecked'} #${card.number} item ${position}: ${after.text}`,
    )
    context.output.result('ChecklistItem', after, meta(session))
  })
}

export async function labels(
  context: Context,
  reference: string,
  names: string[],
  options: { rm?: boolean },
): Promise<void> {
  if (names.length === 0) throw new UsageError('Name at least one label: `yuzie label 18 bug`.')
  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    const next =
      options.rm === true
        ? card.labels.filter((existing) => !names.includes(existing))
        : [...new Set([...card.labels, ...names])]
    const updated = await session.board.cards.update(card.number, { labels: next })
    context.output.success(
      `#${card.number} labels: ${next.length === 0 ? 'none' : next.join(', ')}`,
    )
    context.output.result('Card', updated, meta(session))
  })
}

export async function due(context: Context, reference: string, words: string[]): Promise<void> {
  const when = parseDue(words.join(' '), context.now())
  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    const updated = await session.board.cards.update(card.number, { dueAt: when })
    context.output.success(
      when === null
        ? `Cleared the due date on #${card.number}`
        : `#${card.number} due ${shortDate(when, context.now())}`,
    )
    context.output.result('Card', updated, meta(session))
  })
}

export async function priority(context: Context, reference: string, value: string): Promise<void> {
  const level = parsePriority(value)
  await withBoard(context, async (session) => {
    const card = await session.card(reference)
    const updated = await session.board.cards.update(card.number, { priority: level })
    context.output.success(
      level === null ? `Cleared the priority on #${card.number}` : `#${card.number} is p${level}`,
    )
    context.output.result('Card', updated, meta(session))
  })
}
