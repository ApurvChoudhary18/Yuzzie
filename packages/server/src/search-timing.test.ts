/**
 * SPEC.md §18 Session 14 acceptance: search over a 2,000-card board answers in
 * under 100 ms on the server. Wall-clock, so it runs alone in the `bench` task.
 */
import { CardListResponseSchema, rebalance } from '@yuzie/core'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createBoard,
  startTestServer,
  type TestBoard,
  type TestServer,
} from './__tests__/harness.js'
import { boards, cardLabels, cards, columns, comments, labels } from './db/schema.js'

const CARDS = 2_000
const WORDS = ['oauth', 'webhook', 'billing', 'invoice', 'cache', 'retry', 'export', 'search']

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

describe('search latency over 2,000 cards (§18 Session 14)', () => {
  let server: TestServer
  let board: TestBoard

  beforeAll(async () => {
    server = await startTestServer()
    board = await createBoard(server)
    const db = server.handle.db
    const boardColumns = await db.select().from(columns).where(eq(columns.boardId, board.id))
    const [label] = await db
      .insert(labels)
      .values({ boardId: board.id, name: 'backend', color: null })
      .returning()
    const ranks = rebalance(CARDS)
    const rows = Array.from({ length: CARDS }, (_, index) => ({
      boardId: board.id,
      number: index + 1,
      columnId: boardColumns[index % boardColumns.length]?.id as string,
      rank: ranks[index] as string,
      title: `${WORDS[index % WORDS.length]} task ${index + 1}`,
      description: `Details for ${WORDS[(index * 3) % WORDS.length]} work, item ${index}.`,
    }))
    for (let start = 0; start < rows.length; start += 500) {
      const inserted = await db
        .insert(cards)
        .values(rows.slice(start, start + 500))
        .returning({ id: cards.id, number: cards.number })
      await db.insert(comments).values(
        inserted.map((card) => ({
          cardId: card.id,
          authorId: board.owner.id,
          body: card.number % 97 === 0 ? 'Reproduced on Safari only' : 'Looks fine here',
        })),
      )
      if (label !== undefined)
        await db
          .insert(cardLabels)
          .values(
            inserted
              .filter((card) => card.number % 10 === 0)
              .map((card) => ({ cardId: card.id, labelId: label.id })),
          )
    }
    await db
      .update(boards)
      .set({ nextCardNo: CARDS + 1 })
      .where(eq(boards.id, board.id))
  })

  afterAll(async () => {
    await server?.close()
  })

  const search = async (query: string) => {
    const started = performance.now()
    const response = await call<unknown>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/cards?search=${encodeURIComponent(query)}`,
      token: board.owner.token,
    })
    const elapsed = performance.now() - started
    expect(response.status).toBe(200)
    return { elapsed, cards: CardListResponseSchema.parse(response.body).cards }
  }

  it.each([
    ['a comment', 'safari', Math.floor(CARDS / 97)],
    ['two words', 'oauth task 1', undefined],
    ['a label', 'backend', CARDS / 10],
    ['a title word', 'webhook', undefined],
  ])('%s answers in under 100 ms', async (_, query, expected) => {
    await search(query) // warm the plan cache
    const times: number[] = []
    let found = 0
    for (let run = 0; run < 7; run += 1) {
      const { elapsed, cards: result } = await search(query)
      times.push(elapsed)
      found = result.length
    }
    if (expected !== undefined) expect(found).toBe(expected)
    expect(found).toBeGreaterThan(0)
    console.log(`search "${query}": ${found} cards, median ${median(times).toFixed(1)} ms`)
    expect(median(times)).toBeLessThan(100)
  })
})
