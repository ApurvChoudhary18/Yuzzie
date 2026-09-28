/**
 * Card search and filters on the server (SPEC.md §18 Session 14).
 *
 * The database narrows first — every word of the query, case-insensitively, in
 * the title, description, a comment, a label, an assignee or the number — so
 * only the candidates are loaded in full. The core matcher then decides, so
 * the server, the CLI offline and the TUI all agree on what matches.
 */
import {
  type Card,
  type Column,
  claimTimes,
  isStale,
  matchesSearch,
  searchWords,
} from '@yuzie/core'
import { and, eq, inArray, or, type SQL, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { cardAssignees, cardLabels, cards, comments, events, labels, users } from '../db/schema.js'

/** `%`, `_` and `\` are literal in a search, not patterns. */
function likePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

function wordCondition(word: string): SQL {
  // `@rahul` and `#18` are how people type handles and numbers; the database
  // looks for the bare word and the core matcher applies the prefix.
  const pattern = likePattern(word.replace(/^[@#]/, ''))
  return or(
    sql`${cards.title} ILIKE ${pattern}`,
    sql`coalesce(${cards.description}, '') ILIKE ${pattern}`,
    sql`${cards.number}::text ILIKE ${pattern}`,
    sql`EXISTS (SELECT 1 FROM ${comments} WHERE ${comments.cardId} = ${cards.id} AND ${comments.body} ILIKE ${pattern})`,
    sql`EXISTS (SELECT 1 FROM ${cardLabels} JOIN ${labels} ON ${labels.id} = ${cardLabels.labelId} WHERE ${cardLabels.cardId} = ${cards.id} AND ${labels.name} ILIKE ${pattern})`,
    sql`EXISTS (SELECT 1 FROM ${cardAssignees} JOIN ${users} ON ${users.id} = ${cardAssignees.userId} WHERE ${cardAssignees.cardId} = ${cards.id} AND ${users.handle} ILIKE ${pattern})`,
  ) as SQL
}

/** The numbers of the cards that might match `query`. */
export async function searchCandidates(
  db: Database,
  boardId: string,
  query: string,
): Promise<number[]> {
  const words = searchWords(query)
  const rows = await db
    .select({ number: cards.number })
    .from(cards)
    .where(and(eq(cards.boardId, boardId), ...words.map(wordCondition)))
  return rows.map((row) => row.number)
}

export function refineSearch(list: readonly Card[], query: string): Card[] {
  return list.filter((card) => matchesSearch(card, query))
}

/** When each card was last claimed, from the board's log. */
export async function loadClaimTimes(
  db: Database,
  boardId: string,
  numbers: readonly number[],
  boardColumns: readonly Column[],
): Promise<Map<number, number>> {
  if (numbers.length === 0) return new Map()
  const rows = await db
    .select({
      type: events.type,
      cardNo: events.cardNo,
      ts: events.createdAt,
      payload: events.payload,
    })
    .from(events)
    .where(
      and(
        eq(events.boardId, boardId),
        inArray(events.type, ['card.moved', 'card.assigned']),
        inArray(events.cardNo, [...numbers]),
      ),
    )
  return claimTimes(
    rows.map((row) => ({
      type: row.type,
      cardNo: row.cardNo ?? undefined,
      ts: row.ts.toISOString(),
      payload: row.payload,
    })),
    boardColumns,
  )
}

export function staleCards(
  list: readonly Card[],
  thresholdMs: number,
  boardColumns: readonly Column[],
  claimed: ReadonlyMap<number, number>,
  now: number,
): Card[] {
  return list.filter((card) =>
    isStale(card, thresholdMs, { now, columns: boardColumns, claimedAt: claimed.get(card.number) }),
  )
}
