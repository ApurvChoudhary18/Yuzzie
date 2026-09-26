/**
 * Boards, columns and people (SPEC.md §7.2 "Boards", "Team & awareness"):
 * boards, columns, members, invite, who, activity, feed.
 */
import { type EventEnvelope, NotFoundError, type Role, RoleSchema, slugify } from '@yuzie/core'
import { matchColumn } from '@yuzie/sdk'
import type { Context } from '../context.js'
import { parseDuration } from '../dates.js'
import { UsageError } from '../exit.js'
import { actor, describeEvent } from '../render/events.js'
import { ago, clock, pad } from '../render/text.js'
import { type BoardSession, currentSlug, withBoard } from '../session.js'

/** Left-aligned columns, two spaces apart, header dimmed. */
function table(context: Context, header: string[], rows: string[][]): string {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => [...(row[index] ?? '')].length)),
  )
  const render = (row: string[]) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : pad(cell, (widths[index] ?? 0) + 2)))
      .join('')
      .trimEnd()
  return [context.output.paint('dim', render(header)), ...rows.map(render)].join('\n')
}

function meta(session: BoardSession, extra: Record<string, unknown> = {}) {
  return { boardSlug: session.slug, synced: session.online, ...extra }
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

export async function boardsList(context: Context): Promise<void> {
  context.requireNetwork('Listing boards')
  const client = await context.client()
  const [boards, me] = await Promise.all([client.boards.list(), client.me()])
  const { config } = await context.config()
  const roles = new Map(me.memberships.map((m) => [m.boardSlug, m.role]))
  if (boards.length === 0) {
    context.output.line(
      'No boards yet. Create one with `yuzie init` or `yuzie boards create <name>`.',
    )
  } else {
    context.output.line(
      table(
        context,
        ['', 'SLUG', 'NAME', 'ROLE'],
        boards.map((board) => [
          board.slug === config.board ? context.output.paint('green', '●') : ' ',
          board.slug,
          board.name,
          roles.get(board.slug) ?? '',
        ]),
      ),
    )
  }
  context.output.result('BoardList', boards, { count: boards.length })
}

export async function boardsCreate(
  context: Context,
  words: string[],
  options: { slug?: string },
): Promise<void> {
  const name = words.join(' ').trim()
  if (name.length === 0)
    throw new UsageError('A board needs a name: `yuzie boards create "Payments API"`.')
  context.requireNetwork('Creating a board')
  const client = await context.client()
  const board = await client.boards.create({ name, slug: options.slug ?? slugify(name, 64) })
  context.output.success(`Created board "${board.name}" (${board.slug})`)
  context.output.result('Board', board, { boardSlug: board.slug })
}

async function openOther(context: Context, slug: string) {
  context.requireNetwork('Changing a board')
  const client = await context.client()
  return client.connect(slug, { realtime: false })
}

export async function boardsRename(context: Context, slug: string, words: string[]): Promise<void> {
  const name = words.join(' ').trim()
  if (name.length === 0)
    throw new UsageError('`yuzie boards rename <slug> <name>` needs the new name.')
  const board = await openOther(context, slug)
  try {
    await board.boards.update({ name })
    const renamed = board.state.board
    context.output.success(`Renamed ${slug} to "${name}"`)
    context.output.result('Board', renamed, { boardSlug: slug })
  } finally {
    await board.close()
  }
}

export async function boardsArchive(context: Context, slug: string): Promise<void> {
  if (context.output.json && context.options.yes !== true) {
    throw new UsageError(
      'Archiving a board needs confirmation.',
      'Pass --yes to archive without being asked.',
    )
  }
  const board = await openOther(context, slug)
  try {
    const sure =
      context.options.yes === true ||
      (await context.prompter.confirm(`Archive board ${slug}?`, false))
    if (!sure) {
      context.output.line('Kept it.')
      return
    }
    await board.boards.archive()
    context.output.success(`Archived ${slug}`)
    context.output.result('Deleted', { kind: 'board', id: slug }, { boardSlug: slug })
  } finally {
    await board.close()
  }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export async function columnsList(context: Context): Promise<void> {
  await withBoard(context, async (session) => {
    const { columns, cards } = session.board.state
    const counts = new Map<string, number>()
    for (const card of Object.values(cards))
      counts.set(card.column, (counts.get(card.column) ?? 0) + 1)
    context.output.line(
      table(
        context,
        ['KEY', 'NAME', 'CARDS', 'WIP', 'KIND'],
        columns.map((column) => [
          column.key,
          column.name,
          String(counts.get(column.key) ?? 0),
          column.wipLimit === null ? '—' : String(column.wipLimit),
          column.semantics ?? '—',
        ]),
      ),
    )
    context.output.result('ColumnList', columns, meta(session, { count: columns.length }))
  })
}

export async function columnsAdd(
  context: Context,
  words: string[],
  options: { after?: string },
): Promise<void> {
  const name = words.join(' ').trim()
  if (name.length === 0) throw new UsageError('`yuzie columns add <name>` needs a name.')
  context.requireNetwork('Adding a column')
  await withBoard(context, async (session) => {
    const after =
      options.after === undefined
        ? undefined
        : matchColumn(session.board.state.columns, options.after)
    if (options.after !== undefined && after === undefined) {
      throw new NotFoundError('column_not_found', `No column "${options.after}" on ${session.slug}`)
    }
    const column = await session.board.boards.addColumn({
      name,
      ...(after === undefined ? {} : { after: after.key }),
    })
    context.output.success(
      `Added column ${column.name}${after === undefined ? '' : ` after ${after.name}`}`,
    )
    context.output.result('Column', column, meta(session))
  })
}

export async function columnsRemove(context: Context, reference: string): Promise<void> {
  context.requireNetwork('Removing a column')
  await withBoard(context, async (session) => {
    const column = matchColumn(session.board.state.columns, reference)
    if (column === undefined) {
      throw new NotFoundError('column_not_found', `No column "${reference}" on ${session.slug}`)
    }
    await session.board.boards.removeColumn(column.key)
    context.output.success(`Removed column ${column.name}`)
    context.output.result('Deleted', { kind: 'column', id: column.key }, meta(session))
  })
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export async function members(context: Context): Promise<void> {
  context.requireNetwork('Listing members')
  await withBoard(context, async (session) => {
    const people = await session.board.members.list()
    const now = context.now().getTime()
    context.output.line(
      table(
        context,
        ['HANDLE', 'ROLE', 'KIND', 'LAST SEEN'],
        people.map((member) => [
          `@${member.handle}`,
          member.role,
          member.kind,
          member.lastSeenAt === null ? '—' : ago(now - Date.parse(member.lastSeenAt)),
        ]),
      ),
    )
    context.output.result('MemberList', people, meta(session, { count: people.length }))
  })
}

export async function invite(
  context: Context,
  who: string,
  options: { role?: string },
): Promise<void> {
  const role = RoleSchema.safeParse(options.role ?? 'member')
  if (!role.success) throw new UsageError('--role must be viewer, member or owner.')
  context.requireNetwork('Inviting')
  await withBoard(context, async (session) => {
    const isEmail = who.includes('@') && !who.startsWith('@')
    const result = await session.board.members.invite({
      role: role.data,
      ...(isEmail ? { email: who } : { handle: who.replace(/^@/, '') }),
    })
    context.output.success(`Invited @${result.handle} to ${session.slug} as ${result.role}`)
    context.output.result(
      'Invite',
      { handle: result.handle, role: result.role as Role, boardSlug: session.slug },
      meta(session),
    )
  })
}

/**
 * `yuzie share` (§6.1): how a teammate joins. The board and server are in the
 * committed `.yuzie/config.json`, so joining is: get invited, clone, sign in.
 */
export async function share(context: Context): Promise<void> {
  const slug = await currentSlug(context)
  const server = await context.server()
  const repo = await context.repo()
  const remote = repo?.remote ?? null
  const steps = [
    ...(remote === null ? [] : [`git clone ${remote.url}`, `cd ${remote.name}`]),
    'yuzie login',
    'yuzie',
  ]
  context.output.line(`Share ${context.output.paint('bold', slug)} with your team:`)
  context.output.line('')
  context.output.line(`  1. Invite them:  yuzie invite <email or @handle>`)
  context.output.line(
    remote === null
      ? '  2. They sign in and open the board, with this board in their config:'
      : `  2. They clone ${remote.display}, sign in and open the board:`,
  )
  for (const step of steps) context.output.line(`       ${step}`)
  context.output.line('')
  context.output.line(
    context.output.paint(
      'dim',
      remote === null
        ? `Board ${slug} on ${server}. Commit .yuzie/config.json so teammates pick it up.`
        : `.yuzie/config.json in the repo already points at ${slug} on ${server}.`,
    ),
  )
  context.output.result(
    'Share',
    { boardSlug: slug, server, repo: remote?.url ?? null, steps },
    { boardSlug: slug },
  )
}

export async function who(context: Context): Promise<void> {
  context.requireNetwork('Presence')
  await withBoard(context, async (session) => {
    const people = await session.presence()
    const cards = session.board.state.cards
    const describe = (cardNo: number | null) =>
      cardNo === null
        ? ''
        : `#${cardNo}${cards[cardNo] === undefined ? '' : ` ${cards[cardNo]?.title}`}`
    const width = Math.max(0, ...people.map((person) => person.handle.length + 1))
    for (const person of people) {
      const handle = pad(`@${person.handle}`, width + 2)
      const agent = person.kind === 'agent' ? context.output.paint('cyan', ' (agent)') : ''
      if (person.state === 'working') {
        const branch =
          person.branch === null ? '' : context.output.paint('dim', ` (${person.branch})`)
        context.output.line(
          `${context.output.paint('green', '●')} ${handle}working on ${describe(person.cardNo)}${branch}${agent}`,
        )
      } else if (person.state === 'viewing') {
        context.output.line(
          `${context.output.paint('green', '●')} ${handle}viewing ${describe(person.cardNo)}${agent}`,
        )
      } else {
        context.output.line(`${context.output.paint('dim', '○')} ${handle}online${agent}`)
      }
    }
    context.output.line(
      people.length === 0 ? 'Nobody is on the board right now.' : `${people.length} online`,
    )
    context.output.result('Presence', people, meta(session, { count: people.length }))
  })
}

// ---------------------------------------------------------------------------
// Activity and the live feed
// ---------------------------------------------------------------------------

export async function activity(
  context: Context,
  options: { since?: string; card?: string; limit?: string },
): Promise<void> {
  const window = options.since === undefined ? undefined : parseDuration(options.since)
  const limit = options.limit === undefined ? 50 : Number(options.limit)
  if (!Number.isInteger(limit) || limit <= 0)
    throw new UsageError('--limit must be a positive whole number.')
  context.requireNetwork('Activity')

  await withBoard(context, async (session) => {
    const cardNo =
      options.card === undefined ? undefined : (await session.card(options.card)).number
    const now = context.now().getTime()
    const cutoff = window === undefined ? undefined : now - window

    // The log is read newest-first in pages of 500 until the window is covered.
    const head = session.board.state.seq
    const collected: EventEnvelope[] = []
    for (let upTo = head; upTo > 0; upTo -= 500) {
      const since = Math.max(0, upTo - 500)
      const page = (await session.board.boards.events(since, 500)).events.filter(
        (e) => e.seq <= upTo,
      )
      collected.unshift(...page)
      const oldest = page[0]
      const enough =
        cutoff === undefined
          ? collected.filter((e) => cardNo === undefined || e.cardNo === cardNo).length >= limit
          : oldest !== undefined && Date.parse(oldest.ts) < cutoff
      if (enough) break
    }

    let events = collected.filter(
      (event) =>
        (cardNo === undefined || event.cardNo === cardNo) &&
        (cutoff === undefined || Date.parse(event.ts) >= cutoff),
    )
    events = events.slice(-limit)

    const state = session.board.state
    for (const event of events) {
      context.output.line(
        `${context.output.paint('dim', pad(ago(now - Date.parse(event.ts)), 9))}${context.output.paint('cyan', actor(event))} ${describeEvent(event, state)}`,
      )
    }
    if (events.length === 0) context.output.line('No activity in that window.')
    context.output.result('EventList', events, meta(session, { count: events.length }))
  })
}

/**
 * `yuzie feed` (§7.2, §13.5): one line per event as it happens, until
 * interrupted. Under `--json`, one Event document per line.
 */
export async function feed(context: Context): Promise<number> {
  context.requireNetwork('The live feed')
  const slug = await currentSlug(context)
  return withBoard(
    context,
    async (session) => {
      context.io.stderr.write(
        context.output.json
          ? ''
          : `${context.output.paint('green', '●')} live on ${slug} — Ctrl-C to stop\n`,
      )
      session.board.on('*', (event) => {
        if (context.output.json) {
          context.output.result('Event', event, { boardSlug: slug })
          return
        }
        context.output.line(
          `${context.output.paint('dim', clock(event.ts))}  ${context.output.paint('cyan', actor(event))}  ${describeEvent(event, session.board.state)}`,
        )
      })
      session.board.on('status', (status) => {
        if (!context.output.json && status === 'reconnecting') {
          context.io.stderr.write(`${context.output.paint('yellow', '⚠')} reconnecting…\n`)
        }
      })
      // Runs until the process is interrupted (index.ts turns SIGINT into 130),
      // or until the caller's stop signal fires — which is how tests end it.
      await (context.io.stop ?? new Promise<void>(() => {}))
      return 0
    },
    { live: true },
  )
}
