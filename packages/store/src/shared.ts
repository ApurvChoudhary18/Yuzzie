/**
 * Behaviour both drivers must share exactly, so the conformance suite cannot
 * pass for one and fail for the other because of a copied-and-drifted helper.
 */
import type { Card } from '@yuzie/core'
import type { CardFilter, DrainOptions, DrainReport, Outbox, OutboxEntry } from './types.js'

/** Filters that are cheaper to evaluate in memory than in a JSON column. */
export function matchesFilter(card: Card, filter: CardFilter | undefined): boolean {
  if (filter === undefined) return true
  if (filter.column !== undefined && card.column !== filter.column) return false
  if (filter.assignee !== undefined && !card.assignees.includes(filter.assignee)) return false
  if (filter.label !== undefined && !card.labels.includes(filter.label)) return false
  return true
}

/** Board order: rank first, card number as the tiebreak (SPEC.md §11.4). */
export function byBoardOrder(a: Card, b: Card): number {
  if (a.rank < b.rank) return -1
  if (a.rank > b.rank) return 1
  return a.number - b.number
}

/**
 * Send due entries in queue order.
 *
 * A handler that throws records the failure with backoff and stops the drain, so
 * queued writes never reach the server out of order. Session 13 adds the
 * poison-op quarantine that lets a drain skip past a permanently failing entry.
 */
export async function drainOutbox(
  outbox: Outbox,
  handler: (entry: OutboxEntry) => void | Promise<void>,
  options: DrainOptions,
): Promise<DrainReport> {
  const now = options.now ?? Date.now()
  const queue = outbox.due(now, options.boardSlug)
  const limit = options.limit ?? queue.length

  let sent = 0
  let failed = 0
  let stoppedAt: OutboxEntry | null = null

  for (const entry of queue.slice(0, limit)) {
    try {
      await handler(entry)
      outbox.remove(entry.id)
      sent += 1
    } catch (error) {
      outbox.recordFailure(entry.id, error instanceof Error ? error.message : String(error), now)
      failed += 1
      stoppedAt = entry
      break
    }
  }

  return { sent, failed, remaining: outbox.size(options.boardSlug), stoppedAt }
}
