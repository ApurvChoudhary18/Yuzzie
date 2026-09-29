/**
 * The load test (SPEC.md §10.4, §18 Session 16): 25 clients on a 2,000-card
 * board while the board takes 100 events a second.
 *
 *   pnpm --filter @yuzie/server load
 *
 * Asserted: event propagation p95 under 250 ms (every event, every client,
 * measured from the moment its request left to the moment the client held
 * it), nothing dropped or duplicated, and the server's memory bounded.
 * Wall-clock, so it runs alone (the `bench` task, and `load` on its own).
 */

import { rebalance } from '@yuzie/core'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMember,
  createBoard,
  createUser,
  startTestServer,
  type TestBoard,
  type TestServer,
  type TestUser,
} from './__tests__/harness.js'
import { httpBase, listen, range, StreamClient, sleep } from './__tests__/stream.js'
import { boards, cards, columns } from './db/schema.js'

const CARDS = 2_000
const CLIENTS = 25
const RATE_PER_SECOND = 100
const SECONDS = 10
const P95_BUDGET_MS = 250
const HEAP_GROWTH_BUDGET_MB = 96

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

const mb = (bytes: number) => bytes / 1024 / 1024

describe(`load: ${CLIENTS} clients × ${CARDS} cards × ${RATE_PER_SECOND} events/s (§10.4)`, () => {
  let server: TestServer
  let base: string
  let board: TestBoard
  const users: TestUser[] = []
  const streams: StreamClient[] = []

  beforeAll(async () => {
    server = await startTestServer()
    base = await listen(server)
    board = await createBoard(server)
    users.push(board.owner)
    for (const _ of range(1, CLIENTS - 1)) {
      const user = await createUser(server)
      await addMember(server, board, user, 'member')
      users.push(user)
    }

    // 2,000 cards, inserted directly: the board's size is the setting, not the test.
    const db = server.handle.db
    const boardColumns = await db.select().from(columns).where(eq(columns.boardId, board.id))
    const ranks = rebalance(CARDS)
    for (let start = 0; start < CARDS; start += 500) {
      await db.insert(cards).values(
        range(start, Math.min(CARDS, start + 500) - 1).map((index) => ({
          boardId: board.id,
          number: index + 1,
          columnId: boardColumns[index % boardColumns.length]?.id as string,
          rank: ranks[index] as string,
          title: `Card ${index + 1}`,
        })),
      )
    }
    await db
      .update(boards)
      .set({ nextCardNo: CARDS + 1 })
      .where(eq(boards.id, board.id))
  }, 120_000)

  afterAll(async () => {
    for (const stream of streams) stream.terminate()
    await server?.close()
  })

  it('p95 propagation under 250 ms, nothing dropped, memory bounded', async () => {
    streams.push(
      ...(await Promise.all(
        users.map((user) => StreamClient.connect(base, board.slug, user.token)),
      )),
    )
    const welcomes = await Promise.all(streams.map((stream) => stream.ready()))
    const start = welcomes[0]?.seq ?? 0

    const post = (writer: TestUser, method: string, path: string, body: unknown) =>
      fetch(`${httpBase(base)}/v1/boards/${board.slug}${path}`, {
        method,
        headers: { authorization: `Bearer ${writer.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    // Warm the JIT, the pool and both routes before measuring anything.
    for (const index of range(1, 20)) {
      await post(board.owner, 'POST', `/cards/${index}/comments`, { body: `warm ${index}` })
    }
    const warmEnd = start + 20
    await Promise.all(streams.map((stream) => stream.waitForSeq(warmEnd, 15_000)))

    global.gc?.()
    const heapBefore = process.memoryUsage().heapUsed
    let peakRss = process.memoryUsage().rss
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
    }, 100)

    // Each write carries a marker, so each arrival can be matched to its send.
    const TOTAL = RATE_PER_SECOND * SECONDS
    const sentAt = new Map<string, number>()
    const writes: Promise<Response>[] = []
    const answered: number[] = []
    const began = performance.now()
    for (let index = 0; index < TOTAL; index += 1) {
      const writer = users[index % 5] as TestUser
      const cardNo = 1 + ((index * 7919) % CARDS)
      const marker = `load ${index}`
      const sent = performance.now()
      sentAt.set(marker, sent)
      writes.push(
        (index % 2 === 0
          ? post(writer, 'POST', `/cards/${cardNo}/comments`, { body: marker })
          : post(writer, 'PATCH', `/cards/${cardNo}`, { title: marker })
        ).then((response) => {
          answered.push(performance.now() - sent)
          return response
        }),
      )
      const wait = began + (index + 1) * (1000 / RATE_PER_SECOND) - performance.now()
      if (wait > 0) await sleep(wait)
    }
    const offered = TOTAL / ((performance.now() - began) / 1000)
    const responses = await Promise.all(writes)
    expect(responses.filter((response) => !response.ok).map((r) => r.status)).toEqual([])

    const end = warmEnd + TOTAL
    await Promise.all(streams.map((stream) => stream.waitForSeq(end, 30_000)))
    clearInterval(sampler)
    await sleep(200)
    global.gc?.()
    const heapAfter = process.memoryUsage().heapUsed

    const latencies: number[] = []
    for (const stream of streams) {
      // Nothing dropped, nothing duplicated, in order.
      expect(stream.seqs.filter((seq) => seq > start)).toEqual(range(start + 1, end))
      stream.frames.forEach((frame, index) => {
        if (frame.t !== 'event') return
        const payload = frame.payload as { body?: string; fields?: { title?: string } }
        const marker = payload.body ?? payload.fields?.title
        const sent = marker === undefined ? undefined : sentAt.get(marker)
        if (sent !== undefined) latencies.push((stream.arrivedAt[index] ?? sent) - sent)
      })
    }
    expect(latencies).toHaveLength(TOTAL * CLIENTS)

    const p50 = percentile(latencies, 50)
    const p95 = percentile(latencies, 95)
    const p99 = percentile(latencies, 99)
    const growth = mb(heapAfter - heapBefore)
    console.log(
      [
        `offered ${offered.toFixed(0)} events/s to ${CLIENTS} clients on ${CARDS} cards`,
        `propagation p50 ${p50.toFixed(0)} ms · p95 ${p95.toFixed(0)} ms · p99 ${p99.toFixed(0)} ms (${latencies.length} deliveries)`,
        `write response p50 ${percentile(answered, 50).toFixed(0)} ms · p95 ${percentile(answered, 95).toFixed(0)} ms`,
        `memory: heap ${growth >= 0 ? '+' : ''}${growth.toFixed(1)} MB after GC · peak RSS ${mb(peakRss).toFixed(0)} MB`,
      ].join('\n'),
    )

    expect(offered).toBeGreaterThanOrEqual(RATE_PER_SECOND * 0.95)
    expect(p95).toBeLessThan(P95_BUDGET_MS)
    expect(growth).toBeLessThan(HEAP_GROWTH_BUDGET_MB)
    expect(server.gateway.stats().connections).toBe(CLIENTS)
  }, 180_000)
})
