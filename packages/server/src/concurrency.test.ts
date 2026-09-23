import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMember,
  call,
  createBoard,
  createUser,
  startTestServer,
  type TestBoard,
  type TestServer,
  type TestUser,
} from './__tests__/harness.js'

/**
 * SPEC.md §18 Session 3 acceptance:
 * "50 parallel card creations produce 50 distinct card numbers and 50 gapless
 * seq values."
 *
 * This is the test the `FOR UPDATE` on the board row exists for. Without it,
 * two transactions read the same `next_card_no` and the same `max(seq)`.
 */
describe('concurrent writes to one board', () => {
  let server: TestServer
  let board: TestBoard
  let writer: TestUser

  beforeAll(async () => {
    server = await startTestServer()
    board = await createBoard(server)
    writer = board.owner
  })

  afterAll(async () => {
    await server?.close()
  })

  it('gives 50 parallel card creations 50 distinct numbers and gapless seq', async () => {
    const creations = Array.from({ length: 50 }, (_, index) =>
      call<{ number: number }>(server, {
        method: 'POST',
        url: `/v1/boards/${board.slug}/cards`,
        token: writer.token,
        body: { title: `Card ${index + 1}` },
      }),
    )

    const responses = await Promise.all(creations)

    for (const response of responses) {
      expect(response.status).toBe(201)
    }

    const numbers = responses.map((response) => response.body.number).sort((a, b) => a - b)
    expect(new Set(numbers).size).toBe(50)
    // Card numbers are "per-board monotonic integers" (§7.5): 1..50, no holes.
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))

    const events = await call<{ events: { seq: number }[]; seq: number }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/events?since=0&limit=500`,
      token: writer.token,
    })
    expect(events.status).toBe(200)

    const seqs = events.body.events.map((event) => event.seq)
    expect(seqs).toHaveLength(50)
    expect(new Set(seqs).size).toBe(50)
    // Strictly monotonic and gapless, which is what lets a client resume from a
    // cursor without asking for a snapshot (§12.2).
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))
    expect(events.body.seq).toBe(50)
  })

  it('keeps seq monotonic when several kinds of write race', async () => {
    const other = await createUser(server)
    await addMember(server, board, other, 'member')

    const first = await call<{ number: number }>(server, {
      method: 'POST',
      url: `/v1/boards/${board.slug}/cards`,
      token: writer.token,
      body: { title: 'Racing card' },
    })
    const number = first.body.number

    const before = await call<{ seq: number }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/events?since=0&limit=1`,
      token: writer.token,
    })

    await Promise.all([
      ...Array.from({ length: 10 }, (_, index) =>
        call(server, {
          method: 'POST',
          url: `/v1/boards/${board.slug}/cards/${number}/comments`,
          token: writer.token,
          body: { body: `comment ${index}` },
        }),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        call(server, {
          method: 'POST',
          url: `/v1/boards/${board.slug}/cards`,
          token: other.token,
          body: { title: `Parallel ${index}` },
        }),
      ),
    ])

    const after = await call<{ events: { seq: number }[]; seq: number }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/events?since=${before.body.seq}&limit=500`,
      token: writer.token,
    })

    const seqs = after.body.events.map((event) => event.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    for (let i = 1; i < seqs.length; i += 1) {
      const previous = seqs[i - 1]
      const current = seqs[i]
      if (previous === undefined || current === undefined) throw new Error('unreachable')
      expect(current - previous).toBe(1)
    }
  })

  it('counts every committed event on the metrics registry', async () => {
    const metrics = await call<string>(server, { method: 'GET', url: '/metrics' })
    expect(metrics.status).toBe(200)
    expect(String(metrics.body)).toContain('yuzie_events_total')
    expect(String(metrics.body)).toContain('card.created')
  })
})
