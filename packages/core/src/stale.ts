/**
 * Stale work (SPEC.md §7.2 `--stale`, §18 Session 14).
 *
 * A card that is claimed and in progress shows progress through commits: it is
 * stale when it was claimed at least the threshold ago and nothing has been
 * committed since ("claimed 3 days ago, no commits"). Any other unfinished card
 * is stale when nothing at all has happened to it for that long. Finished
 * cards are never stale.
 */
import type { Card, Column } from './types.js'

/** All staleness needs to know about a column. */
export type StaleColumn = Pick<Column, 'key' | 'semantics'>

export interface StaleContext {
  readonly now: number
  readonly columns: readonly StaleColumn[]
  /**
   * When the card was last claimed — moved into an in-progress column or
   * assigned — from the event log. Unknown (offline, no log) falls back to the
   * card's own last update.
   */
  readonly claimedAt?: number | null
}

function time(iso: string | null | undefined): number {
  const parsed = iso === null || iso === undefined ? Number.NaN : Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}

/** When the card last moved forward. */
export function lastProgressAt(card: Card, context: StaleContext): number {
  const lastCommit = time(card.git?.lastActivityAt)
  const column = context.columns.find((candidate) => candidate.key === card.column)
  const claimed = column?.semantics === 'in_progress' && card.assignees.length > 0
  if (claimed && context.claimedAt !== undefined && context.claimedAt !== null)
    return Math.max(context.claimedAt, lastCommit)
  return Math.max(time(card.updatedAt), lastCommit)
}

export function isStale(card: Card, thresholdMs: number, context: StaleContext): boolean {
  const column = context.columns.find((candidate) => candidate.key === card.column)
  if (column?.semantics === 'terminal') return false
  return context.now - lastProgressAt(card, context) >= thresholdMs
}

/** From an event log: when each card was last claimed (moved into progress, or assigned). */
export function claimTimes(
  events: ReadonlyArray<{
    readonly type: string
    readonly cardNo?: number | undefined
    readonly ts: string
    readonly payload: unknown
  }>,
  columns: readonly StaleColumn[],
): Map<number, number> {
  const inProgress = new Set(
    columns.filter((column) => column.semantics === 'in_progress').map((column) => column.key),
  )
  const claimed = new Map<number, number>()
  for (const event of events) {
    if (event.cardNo === undefined) continue
    const payload = event.payload as { to?: string; added?: readonly string[] }
    const claims =
      (event.type === 'card.moved' && payload.to !== undefined && inProgress.has(payload.to)) ||
      (event.type === 'card.assigned' && (payload.added?.length ?? 0) > 0)
    if (claims) claimed.set(event.cardNo, Math.max(claimed.get(event.cardNo) ?? 0, time(event.ts)))
  }
  return claimed
}

const UNIT_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/** `2d`, `36h`, `1w`, `30m` → milliseconds; `null` when it is not a duration. */
export function durationMs(input: string): number | null {
  const match = /^(\d+)\s*(m|min|h|d|w)$/i.exec(input.trim())
  if (match === null) return null
  return Number(match[1]) * (UNIT_MS[(match[2] as string).toLowerCase()] ?? 0)
}
