/**
 * Every write to a board goes through here (SPEC.md §18 Session 3).
 *
 * Three guarantees, all of which depend on doing this in one place:
 *
 *   1. **Serialised per board.** The board row is locked `FOR UPDATE` first, so
 *      concurrent mutations of the same board queue behind each other. That is
 *      what makes card numbers distinct and `seq` gapless under load, and it is
 *      the alternative the spec names to an advisory lock.
 *   2. **Events are part of the mutation.** They are appended inside the same
 *      transaction as the rows they describe, so the log can never disagree with
 *      the state, and a rollback takes the events with it.
 *   3. **Events are validated before they are stored.** A payload that does not
 *      match `@yuzie/core`'s schema aborts the transaction rather than putting a
 *      frame in the log that no client can parse.
 */
import {
  boardError,
  type EventEnvelope,
  EventEnvelopeSchema,
  type EventType,
  newId,
} from '@yuzie/core'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { boards, events } from '../db/schema.js'
import type { EventBus } from './event-bus.js'

export type BoardRow = typeof boards.$inferSelect
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface EventDraft {
  readonly type: EventType
  readonly cardId?: string | null
  readonly cardNo?: number | null
  readonly payload: unknown
}

export interface MutationActor {
  readonly id: string
  readonly handle: string
}

export interface MutationContext {
  readonly tx: Transaction
  readonly board: BoardRow
  /** Queue an event; it is written, in order, when the mutation commits. */
  emit(draft: EventDraft): void
  /** The next `#n` for this board. Safe because the board row is locked. */
  nextCardNumber(): number
}

export interface MutationResult<T> {
  readonly value: T
  readonly events: EventEnvelope[]
}

export interface MutateOptions {
  /** Echoed on the emitted events so a client can drop its own write (§12.2). */
  readonly idempotencyKey?: string | undefined
  /** Notified once the transaction has committed, never before. */
  readonly bus?: EventBus | undefined
}

export async function mutateBoard<T>(
  db: Database,
  boardId: string,
  actor: MutationActor | null,
  fn: (context: MutationContext) => Promise<T>,
  options: MutateOptions = {},
): Promise<MutationResult<T>> {
  const outcome = await db.transaction(async (tx) => {
    const [board] = await tx.select().from(boards).where(eq(boards.id, boardId)).for('update')
    if (board === undefined) {
      throw boardError('board_not_found', `Board ${boardId} does not exist`)
    }

    const drafts: EventDraft[] = []
    let nextNumber = board.nextCardNo
    let allocated = 0

    const value = await fn({
      tx,
      board,
      emit: (draft) => {
        drafts.push(draft)
      },
      nextCardNumber: () => {
        const number = nextNumber
        nextNumber += 1
        allocated += 1
        return number
      },
    })

    if (allocated > 0) {
      await tx.update(boards).set({ nextCardNo: nextNumber }).where(eq(boards.id, boardId))
    }

    const envelopes = await appendEvents(tx, boardId, actor, drafts, options.idempotencyKey)
    return { value, events: envelopes }
  })

  options.bus?.publish(boardId, outcome.events)
  return outcome
}

async function appendEvents(
  tx: Transaction,
  boardId: string,
  actor: MutationActor | null,
  drafts: readonly EventDraft[],
  idempotencyKey: string | undefined,
): Promise<EventEnvelope[]> {
  if (drafts.length === 0) return []

  const [head] = await tx
    .select({ maxSeq: sql<string>`coalesce(max(${events.seq}), 0)` })
    .from(events)
    .where(eq(events.boardId, boardId))

  let seq = Number(head?.maxSeq ?? 0)
  const envelopes: EventEnvelope[] = []

  for (const draft of drafts) {
    seq += 1
    const id = newId()
    const ts = new Date()

    const envelope = EventEnvelopeSchema.parse({
      id,
      seq,
      type: draft.type,
      actor: actor?.handle ?? null,
      ...(draft.cardNo === null || draft.cardNo === undefined ? {} : { cardNo: draft.cardNo }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      payload: draft.payload,
      ts: ts.toISOString(),
    })

    await tx.insert(events).values({
      boardId,
      seq,
      id,
      type: draft.type,
      actorId: actor?.id ?? null,
      cardId: draft.cardId ?? null,
      cardNo: draft.cardNo ?? null,
      payload: envelope.payload as Record<string, unknown>,
      createdAt: ts,
    })

    envelopes.push(envelope)
  }

  return envelopes
}

/** Read the board's current head sequence. */
export async function currentSeq(db: Database, boardId: string): Promise<number> {
  const [head] = await db
    .select({ maxSeq: sql<string>`coalesce(max(${events.seq}), 0)` })
    .from(events)
    .where(eq(events.boardId, boardId))
  return Number(head?.maxSeq ?? 0)
}
