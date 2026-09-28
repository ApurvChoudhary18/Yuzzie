/**
 * Saying what a sync did (SPEC.md §18 Session 13): what was sent, what the
 * server decided differently, what was set aside and why — in words a person
 * can act on, and as data for `--json`.
 */
import type { BoardState, Card } from '@yuzie/core'
import type { OutboxOpLike, SyncOutcome, SyncReport } from '@yuzie/sdk'
import type { Output } from './output.js'
import { plural } from './render/text.js'

const CARD_PATH = /\/cards\/(-?\d+)(\/[a-z]+)?/

/** A queued write in words: "move to Done", "edit (title, priority)", "comment". */
export function describeOp(op: OutboxOpLike, state: BoardState): string {
  const match = CARD_PATH.exec(op.path)
  const tail = match?.[2] ?? ''
  const body = (op.body ?? {}) as Record<string, unknown>
  if (op.method === 'POST' && /\/cards$/.test(op.path))
    return `add "${String(body.title ?? 'a card')}"`
  if (op.method === 'DELETE' && tail === '') return 'delete'
  switch (tail) {
    case '':
      return op.method === 'PATCH'
        ? `edit (${Object.keys(body)
            .filter((key) => key !== 'version')
            .join(', ')})`
        : op.method.toLowerCase()
    case '/move': {
      const key = String(body.column ?? '')
      const name = state.columns.find((column) => column.key === key)?.name ?? key
      return `move to ${name}`
    }
    case '/assign': {
      const add = (body.add as string[] | undefined) ?? []
      const remove = (body.remove as string[] | undefined) ?? []
      return [
        ...(add.length > 0 ? [`assign ${add.map((h) => `@${h}`).join(', ')}`] : []),
        ...(remove.length > 0 ? [`unassign ${remove.map((h) => `@${h}`).join(', ')}`] : []),
      ].join(' and ')
    }
    case '/comments':
      return 'comment'
    case '/checklist':
      return 'checklist change'
    case '/git':
      return 'git summary'
    case '/commits':
      return 'commit link'
    case '/anchor':
      return 'code anchor'
    case '/watch':
      return 'watch change'
    default:
      return `${op.method} ${op.path}`
  }
}

function cardLabel(cardNo: number | null, state: BoardState): string {
  if (cardNo === null) return 'the board'
  const card = state.cards[cardNo]
  return card === undefined ? `#${cardNo}` : `#${cardNo} ${card.title}`
}

/** What the server has now, in the terms of the change that lost. */
function nowReads(op: OutboxOpLike, current: Card, state: BoardState): string {
  const body = (op.body ?? {}) as Record<string, unknown>
  if (op.path.endsWith('/move')) {
    const column = state.columns.find((c) => c.key === current.column)?.name ?? current.column
    return `it is in ${column}`
  }
  if (op.path.endsWith('/assign')) {
    return current.assignees.length === 0
      ? 'it is unassigned'
      : `it is assigned to ${current.assignees.map((h) => `@${h}`).join(', ')}`
  }
  const fields = Object.keys(body).filter((key) => key !== 'version')
  const shown = fields
    .map((field) => {
      const value = (current as unknown as Record<string, unknown>)[field]
      return `${field} ${JSON.stringify(value)}`
    })
    .slice(0, 3)
  return shown.length === 0 ? `it is at version ${current.version}` : `it has ${shown.join(', ')}`
}

export interface ConflictLine {
  readonly cardNo: number | null
  readonly change: string
  readonly by: string | null
  readonly current: Card | null
  readonly message: string
}

export interface ProblemLine {
  readonly cardNo: number | null
  readonly change: string
  readonly attempts: number
  readonly error: string
  readonly message: string
}

export interface Reconciliation {
  readonly sent: number
  readonly conflicts: readonly ConflictLine[]
  readonly retrying: readonly ProblemLine[]
  readonly quarantined: readonly ProblemLine[]
  readonly held: number
  readonly remaining: number
  readonly reachable: boolean
}

/** A sync report, turned into sentences (§18 Session 13: "told exactly what happened"). */
export function reconcile(report: SyncReport, state: BoardState): Reconciliation {
  const conflicts: ConflictLine[] = []
  const retrying: ProblemLine[] = []
  const quarantined: ProblemLine[] = []
  for (const outcome of report.outcomes as readonly SyncOutcome[]) {
    const change = describeOp(outcome.op, state)
    const card = cardLabel(outcome.cardNo, state)
    if (outcome.kind === 'conflict') {
      const who = outcome.by === null ? 'someone' : `@${outcome.by}`
      const reads =
        outcome.current === null ? '' : ` Now ${nowReads(outcome.op, outcome.current, state)}.`
      conflicts.push({
        cardNo: outcome.cardNo,
        change,
        by: outcome.by,
        current: outcome.current,
        message: `${card}: your ${change} was not applied — ${who} changed it first.${reads}`,
      })
    } else if (outcome.kind === 'retry') {
      retrying.push({
        cardNo: outcome.cardNo,
        change,
        attempts: outcome.attempts,
        error: outcome.error,
        message: `${card}: ${change} was refused (${outcome.error}); attempt ${outcome.attempts} of 3, will retry.`,
      })
    } else if (outcome.kind === 'quarantined') {
      quarantined.push({
        cardNo: outcome.cardNo,
        change,
        attempts: outcome.attempts,
        error: outcome.error,
        message: `${card}: ${change} set aside after ${outcome.attempts} refusals (${outcome.error}).`,
      })
    }
  }
  return {
    sent: report.sent,
    conflicts,
    retrying,
    quarantined,
    held: report.outcomes.filter((o) => o.kind === 'held').length,
    remaining: report.remaining,
    reachable: report.reachable,
  }
}

/** Print the reconciliation; nothing at all when nothing happened. */
export function printReconciliation(output: Output, result: Reconciliation): void {
  if (result.sent > 0) output.success(`Sent ${plural(result.sent, 'queued change')}`)
  for (const line of result.conflicts) output.line(`${output.paint('yellow', '⟳')} ${line.message}`)
  for (const line of result.retrying) output.warn(line.message)
  for (const line of result.quarantined) {
    output.warn(line.message)
  }
  if (result.quarantined.length > 0)
    output.line(
      output.paint(
        'dim',
        '  See them with `yuzie doctor`; retry with `yuzie sync --retry-set-aside`.',
      ),
    )
  if (result.held > 0)
    output.line(
      output.paint(
        'dim',
        `  ${plural(result.held, 'later change')} to the same card${result.held === 1 ? '' : 's'} waiting behind ${result.retrying.length === 1 ? 'it' : 'them'}.`,
      ),
    )
}
