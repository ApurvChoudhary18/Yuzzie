/**
 * Reading the event log and the state it folds to.
 *
 * REST replay (`GET /events`) and the realtime gateway's resume both read
 * through here, so a client sees the same envelope whichever path delivered it.
 */
import type { BoardSnapshot, EventEnvelope } from '@yuzie/core'
import { and, asc, eq, gt, lte } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { boards, columns, events, labels, users } from '../db/schema.js'
import { currentSeq } from './mutate.js'
import { loadCards, loadMembers, toBoard, toColumn, toIsoRequired, toLabel } from './serialize.js'

export interface LoadEventsOptions {
  /** Return events with `seq` strictly greater than this. */
  readonly since: number
  /** Stop at this `seq`, inclusive. */
  readonly until?: number
  readonly limit?: number
}

export async function loadEvents(
  db: Database,
  boardId: string,
  options: LoadEventsOptions,
): Promise<EventEnvelope[]> {
  const conditions = [eq(events.boardId, boardId), gt(events.seq, options.since)]
  if (options.until !== undefined) conditions.push(lte(events.seq, options.until))

  const query = db
    .select({ event: events, actor: users.handle })
    .from(events)
    .leftJoin(users, eq(events.actorId, users.id))
    .where(and(...conditions))
    .orderBy(asc(events.seq))
  const rows = options.limit === undefined ? await query : await query.limit(options.limit)

  // Every payload was validated against @yuzie/core before it was stored
  // (services/mutate.ts), so it is not parsed a second time on the way out.
  return rows.map(
    ({ event, actor }) =>
      ({
        id: event.id,
        seq: Number(event.seq),
        type: event.type,
        actor,
        ...(event.cardNo === null ? {} : { cardNo: event.cardNo }),
        ...(event.idempotencyKey === null ? {} : { idempotencyKey: event.idempotencyKey }),
        payload: event.payload,
        ts: toIsoRequired(event.createdAt),
      }) as EventEnvelope,
  )
}

export interface Snapshot {
  readonly seq: number
  readonly board: BoardSnapshot
}

/**
 * The whole board and the `seq` it corresponds to, read in one repeatable-read
 * transaction.
 *
 * Reading the head and the rows separately would let a write land in between,
 * and a client folding the next event onto that state would apply it twice.
 */
export async function loadSnapshot(db: Database, boardId: string): Promise<Snapshot> {
  return db.transaction(
    async (tx) => {
      // A transaction exposes the same query surface as the pool; the loaders are
      // typed against the pool only because that is what every other caller has.
      const reader = tx as unknown as Database

      const [board] = await reader.select().from(boards).where(eq(boards.id, boardId))
      if (board === undefined) throw new Error(`Board ${boardId} vanished during a snapshot`)

      const seq = await currentSeq(reader, boardId)
      const columnRows = await reader
        .select()
        .from(columns)
        .where(eq(columns.boardId, boardId))
        .orderBy(asc(columns.rank))
      const labelRows = await reader
        .select()
        .from(labels)
        .where(eq(labels.boardId, boardId))
        .orderBy(asc(labels.name))
      const members = await loadMembers(reader, boardId)
      const cards = await loadCards(reader, boardId)

      return {
        seq,
        board: {
          board: toBoard(board),
          columns: columnRows.map(toColumn),
          labels: labelRows.map(toLabel),
          members,
          cards,
        },
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
