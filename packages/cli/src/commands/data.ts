/**
 * Moving a board's data in and out, and an account away (SPEC.md §7.2, §14.3):
 * `yuzie export`, `yuzie import` and `yuzie account delete`.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type EventEnvelope, JSON_API_VERSION } from '@yuzie/core'
import { deleteToken } from '@yuzie/sdk/node'
import type { Context } from '../context.js'
import { UsageError } from '../exit.js'
import { withBoard } from '../session.js'
import {
  type BoardExport,
  FORMATS,
  type Format,
  formatOf,
  parse,
  plan,
  render,
} from '../transfer.js'
import { readStdin } from './cards.js'

const EVENT_PAGE = 500

function chooseFormat(given: string | undefined, path: string | undefined): Format {
  const format = given ?? (path === undefined ? undefined : formatOf(path)) ?? 'json'
  if (!(FORMATS as readonly string[]).includes(format))
    throw new UsageError(`No "${format}" format.`, `Use one of: ${FORMATS.join(', ')}.`)
  return format as Format
}

export interface ExportOptions {
  readonly format?: string
  readonly output?: string
}

export async function exportBoard(context: Context, options: ExportOptions): Promise<void> {
  const format = chooseFormat(options.format, options.output)
  context.requireNetwork('Exporting a board')
  await withBoard(context, async (session) => {
    const board = session.board
    const [detail, cards] = await Promise.all([board.boards.get(), board.cards.list()])
    const events: EventEnvelope[] = []
    for (let since = 0; ; ) {
      const page = await board.boards.events(since, EVENT_PAGE)
      events.push(...page.events)
      const last = page.events.at(-1)
      if (page.events.length < EVENT_PAGE || last === undefined) break
      since = last.seq
    }
    const dump: BoardExport = {
      apiVersion: JSON_API_VERSION,
      kind: 'BoardExport',
      exportedAt: context.now().toISOString(),
      board: detail.board,
      columns: detail.columns,
      labels: detail.labels,
      members: detail.members,
      cards: [...cards].sort((a, b) => a.number - b.number),
      events,
    }

    const { output } = context
    if (options.output === undefined) {
      // `--json` keeps its promise of one envelope; otherwise the file itself.
      if (output.json) output.result('BoardExport', dump, { boardSlug: detail.board.slug })
      else context.io.stdout.write(render(dump, format))
      return
    }
    const path = resolve(context.io.cwd, options.output)
    await writeFile(path, render(dump, format), 'utf8')
    output.success(
      `Exported ${dump.cards.length} card${dump.cards.length === 1 ? '' : 's'} and ${events.length} events to ${options.output}`,
    )
    output.result(
      'Export',
      { path, format, cards: dump.cards.length, events: events.length },
      { boardSlug: detail.board.slug },
    )
  })
}

export interface ImportOptions {
  readonly format?: string
  readonly column?: string
  readonly dryRun?: boolean
}

/** Without an extension to go by: JSON starts with `{` or `[`, markdown has list items. */
function sniff(text: string): Format {
  const start = text.trimStart()[0]
  if (start === '{' || start === '[') return 'json'
  if (/^\s*[-*+]\s+/m.test(text) || /^#{1,2}\s/m.test(text)) return 'md'
  return 'csv'
}

export async function importCards(
  context: Context,
  file: string,
  options: ImportOptions,
): Promise<void> {
  const text =
    file === '-'
      ? await readStdin(context)
      : await readFile(resolve(context.io.cwd, file), 'utf8').catch(() => {
          throw new UsageError(`Cannot read ${file}.`, 'Check the path, or pass - to read stdin.')
        })
  const format =
    options.format === undefined
      ? (formatOf(file) ?? sniff(text))
      : chooseFormat(options.format, undefined)
  let drafts: ReturnType<typeof parse>
  try {
    drafts = parse(text, format)
  } catch (error) {
    throw new UsageError(
      `Cannot read ${file} as ${format}: ${error instanceof Error ? error.message : String(error)}`,
      'Pass --format json, csv or md if the extension misleads.',
    )
  }
  if (drafts.length === 0)
    throw new UsageError(`No cards in ${file}.`, 'Each card needs at least a title.')
  if (options.dryRun !== true) context.requireNetwork('Importing cards')

  await withBoard(context, async (session) => {
    const { output } = context
    let planned: ReturnType<typeof plan>
    try {
      planned = plan(drafts, session.board.state, options.column)
    } catch (error) {
      throw new UsageError(
        error instanceof Error ? error.message : String(error),
        'Run `yuzie columns` to see this board’s columns.',
      )
    }
    for (const warning of planned.warnings) output.warn(warning)

    const columns = session.board.state.columns
    const byColumn = new Map<string, number>()
    for (const item of planned.items)
      byColumn.set(item.column as string, (byColumn.get(item.column as string) ?? 0) + 1)
    const summary = columns
      .filter((column) => byColumn.has(column.key))
      .map((column) => `${column.name} ${byColumn.get(column.key)}`)
      .join(', ')

    if (options.dryRun === true) {
      output.success(
        `Would import ${planned.items.length} card${planned.items.length === 1 ? '' : 's'}: ${summary}`,
      )
      for (const item of planned.items.slice(0, 20))
        output.line(`  ${output.paint('dim', `${item.column}`.padEnd(10))} ${item.title}`)
      if (planned.items.length > 20) output.line(`  … and ${planned.items.length - 20} more`)
      output.result('Import', {
        dryRun: true,
        count: planned.items.length,
        cards: planned.items,
        warnings: planned.warnings,
      })
      return
    }

    const created = await session.board.cards.import(planned.items)
    const numbers = created.map((card) => card.number)
    const range =
      numbers.length === 1 ? `#${numbers[0]}` : `#${numbers[0]}–#${numbers.at(-1) as number}`
    output.success(
      `Imported ${created.length} card${created.length === 1 ? '' : 's'} (${range}): ${summary}`,
    )
    output.result(
      'Import',
      { dryRun: false, count: created.length, numbers, warnings: planned.warnings },
      { boardSlug: session.slug },
    )
  })
}

export async function accountDelete(
  context: Context,
  options: { confirm?: string },
): Promise<number> {
  context.requireNetwork('Deleting an account')
  const client = await context.client()
  const server = await context.server()
  const { user } = await client.me()
  const { output } = context

  let typed = options.confirm
  if (typed === undefined) {
    if (!context.prompter.canAsk)
      throw new UsageError(
        'Deleting your account needs confirmation.',
        `Pass --confirm ${user.handle} to delete @${user.handle}.`,
      )
    output.warn(`This deletes @${user.handle} on ${server}:`)
    output.line('  • your tokens stop working now, and you cannot sign in as this handle again;')
    output.line('  • your memberships, comments and assignments are removed within 30 days;')
    output.line('  • cards you made stay on their boards, without your name.')
    typed = await context.prompter.ask(`Type your handle (${user.handle}) to delete it:`, 'cancel')
  }
  if (typed.replace(/^@/, '') !== user.handle) {
    output.line('Not deleted.')
    output.result('AccountDeleted', { handle: user.handle, deleted: false })
    return 0
  }

  const deleted = await client.account.delete(user.handle)
  await deleteToken(server, context.credentials()).catch(() => undefined)
  output.success(`Deleted @${deleted.handle}`)
  output.line(
    `  Everything else of yours is removed from ${server} by ${deleted.purgeBy.slice(0, 10)}.`,
  )
  output.result('AccountDeleted', { ...deleted, deleted: true })
  return 0
}
