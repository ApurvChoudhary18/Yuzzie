/**
 * Folding server events into the cache.
 *
 * The reducer is not reimplemented here. A minimal `BoardState` slice is read
 * out of the cache, `@yuzie/core`'s `applyEvent` decides what the new state is,
 * and the difference is written back. That is what keeps the cached board and an
 * in-memory board identical: there is one set of semantics, in one place.
 */
import { applyEvent, type Card, type EventEnvelope, initialState } from '@yuzie/core'
import type { YuzieCache } from './types.js'

export type CacheChange = 'created' | 'updated' | 'deleted' | 'none'

export interface ApplyResult {
  /** False when the event was at or below the cursor and was ignored. */
  readonly applied: boolean
  /** The cursor after the event. */
  readonly seq: number
  readonly cardNumber: number | null
  readonly change: CacheChange
}

/** The card an event is about, if any. */
function cardNumberOf(event: EventEnvelope): number | null {
  if (event.type === 'card.created') return event.payload.number
  return event.cardNo ?? null
}

/**
 * Apply one event.
 *
 * Events at or below `sync_state.last_seq` are ignored, so redelivering the tail
 * of a replay is safe. An event that arrives *ahead* of the cursor is applied and
 * moves the cursor with it; detecting the resulting gap and asking for a replay
 * is the realtime client's job (§12.2), not the cache's.
 */
export function applyEventToCache(
  cache: YuzieCache,
  boardSlug: string,
  event: EventEnvelope,
): ApplyResult {
  return cache.transaction(() => {
    const cursor = cache.sync.get(boardSlug).lastSeq
    if (event.seq <= cursor) {
      return { applied: false, seq: cursor, cardNumber: cardNumberOf(event), change: 'none' }
    }

    const cardNumber = cardNumberOf(event)
    const before: Card | undefined =
      cardNumber === null ? undefined : cache.cards.get(boardSlug, cardNumber)

    const state = initialState({
      cards: before === undefined ? {} : { [before.number]: before },
      columns: cache.columns.list(boardSlug),
      seq: cursor,
    })

    const next = applyEvent(state, event)
    const after = cardNumber === null ? undefined : next.cards[cardNumber]

    let change: CacheChange = 'none'
    if (cardNumber !== null) {
      if (after === undefined && before !== undefined) {
        cache.cards.delete(boardSlug, cardNumber)
        change = 'deleted'
      } else if (after !== undefined && before === undefined) {
        cache.cards.put(boardSlug, after)
        change = 'created'
      } else if (after !== undefined && before !== undefined && after !== before) {
        cache.cards.put(boardSlug, after)
        change = 'updated'
      }
    }

    // The event log is mirrored locally so `yuzie activity` and the card Activity
    // panel stay projections over events, exactly as they are on the server (§12.3).
    cache.events.append(boardSlug, event)
    cache.sync.advance(boardSlug, next.seq)

    return { applied: true, seq: next.seq, cardNumber, change }
  })
}

/** Apply a batch in seq order, in one transaction. */
export function applyEventsToCache(
  cache: YuzieCache,
  boardSlug: string,
  events: readonly EventEnvelope[],
): ApplyResult[] {
  return cache.transaction(() =>
    [...events]
      .sort((a, b) => a.seq - b.seq)
      .map((event) => applyEventToCache(cache, boardSlug, event)),
  )
}
