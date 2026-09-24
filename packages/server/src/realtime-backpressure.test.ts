/**
 * Backpressure (SPEC.md §18 Session 4): a client that stops reading must not
 * grow the server's memory. Its backlog is dropped, and once its socket drains it
 * is reset with a snapshot rather than an unbounded replay.
 *
 * "Stops reading" is real here: the client pauses its TCP socket, so the kernel
 * buffers fill and the server's writes stop completing. The events are large so
 * that happens after a few megabytes rather than a few hundred.
 */
import { allCards, applyEvents, type Card, initialState } from '@yuzie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMember,
  call,
  createBoard,
  createCard,
  createUser,
  startTestServer,
  type TestServer,
} from './__tests__/harness.js'
import { listen, range, StreamClient, sleep } from './__tests__/stream.js'

const QUEUE_LIMIT = 16

describe('a slow consumer', () => {
  let server: TestServer
  let base: string

  beforeAll(async () => {
    server = await startTestServer({
      wsOutboundQueueLimit: QUEUE_LIMIT,
      wsMaxInflightBytes: 64 * 1024,
      // Writing ~20 MB of cards should not trip the per-token write limit.
      rateLimitEnabled: false,
    })
    base = await listen(server)
  })

  afterAll(async () => {
    await server.close()
  })

  it('is reset with a snapshot while a fast client on the same board misses nothing', async () => {
    const board = await createBoard(server)
    const fastUser = await createUser(server)
    await addMember(server, board, fastUser, 'member')

    const slow = await StreamClient.connect(base, board.slug, board.owner.token)
    const fast = await StreamClient.connect(base, board.slug, fastUser.token)
    const start = (await slow.ready(0)).seq
    await fast.ready(0)

    // Stop reading. Frames pile up in the kernel, then in the gateway's queue.
    slow.socket.pause()

    const description = 'x'.repeat(160 * 1024)
    const CARDS = 120
    for (let done = 0; done < CARDS; done += 10) {
      await Promise.all(
        range(1, 10).map((index) =>
          createCard(server, board, board.owner.token, {
            title: `big ${done + index}`,
            description,
          }),
        ),
      )
    }
    const end = start + CARDS
    await fast.waitForSeq(end, 20_000)

    // The server never held more than the cap for this client, however far behind it fell.
    expect(server.gateway.stats().maxQueueDepth).toBeLessThanOrEqual(QUEUE_LIMIT)
    const metrics = await server.metrics.registry.getSingleMetricAsString('yuzie_ws_resets_total')
    expect(metrics).toMatch(/yuzie_ws_resets_total [1-9]/)

    // Start reading again: the backlog that survived drains, then the snapshot arrives.
    slow.socket.resume()
    await slow.until(() => slow.snapshots.length > 0, 20_000, 'reset snapshot')

    // Keep writing: the reset client picks up live after its snapshot.
    await createCard(server, board, board.owner.token, { title: 'after the reset' })
    await slow.waitForSeq(end + 1, 10_000)
    await fast.waitForSeq(end + 1)
    await sleep(100)

    // The fast client is untouched: every event, in order, no snapshot.
    expect(fast.seqs).toEqual(range(start + 1, end + 1))
    expect(fast.snapshots).toHaveLength(0)

    // The slow one received a prefix of the live stream, then a snapshot, then
    // strictly newer events — and folding them gives the server's exact state.
    const snapshotIndex = slow.frames.findIndex((frame) => frame.t === 'snapshot')
    const snapshot = slow.snapshots[0]
    if (snapshot === undefined) throw new Error('no snapshot')
    const before = slow.frames
      .slice(0, snapshotIndex)
      .flatMap((f) => (f.t === 'event' ? [f.seq] : []))
    const after = slow.frames.slice(snapshotIndex).flatMap((f) => (f.t === 'event' ? [f.seq] : []))
    expect(before).toEqual(range(start + 1, start + before.length))
    expect(before.length).toBeLessThan(CARDS)
    expect(after).toEqual(range(snapshot.seq + 1, end + 1))

    const cards: Record<number, Card> = {}
    for (const card of snapshot.board.cards) cards[card.number] = card
    const state = applyEvents(
      initialState({ ...snapshot.board, cards, seq: snapshot.seq }),
      slow.events.filter((event) => event.seq > snapshot.seq),
    )
    const rest = await call<{ cards: Card[] }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/cards`,
      token: board.owner.token,
    })
    expect(
      allCards(state)
        .map((card) => card.number)
        .sort((a, b) => a - b),
    ).toEqual(rest.body.cards.map((card) => card.number).sort((a, b) => a - b))
    expect(state.seq).toBe(end + 1)

    slow.terminate()
    fast.terminate()
  }, 60_000)

  it('is disconnected with 4003 if it never drains', async () => {
    let clock = Date.now()
    const strict = await startTestServer(
      {
        wsOutboundQueueLimit: 4,
        wsMaxInflightBytes: 16 * 1024,
        presenceSweepMs: 20,
        rateLimitEnabled: false,
      },
      { now: () => clock },
    )
    const strictBase = await listen(strict)
    try {
      const board = await createBoard(strict)
      const slow = await StreamClient.connect(strictBase, board.slug, board.owner.token)
      await slow.ready(0)
      slow.socket.pause()

      const description = 'y'.repeat(160 * 1024)
      for (let done = 0; done < 120; done += 10) {
        await Promise.all(
          range(1, 10).map(() =>
            createCard(strict, board, board.owner.token, { title: 'big', description }),
          ),
        )
      }
      const resets = await strict.metrics.registry.getSingleMetricAsString('yuzie_ws_resets_total')
      expect(resets).toMatch(/yuzie_ws_resets_total [1-9]/)

      // Not a heartbeat timeout (that is 45 s): the reset deadline is 30 s after
      // the reset began, and one second short of it the client is still there.
      expect(strict.gateway.stats().connections).toBe(1)
      clock += 29_000
      await sleep(200)
      expect(strict.gateway.stats().connections).toBe(1)
      clock += 1_000
      await sleep(200)
      expect(strict.gateway.stats().connections).toBe(0)

      // The client could not read the close frame while paused; now it can.
      slow.socket.resume()
      expect((await slow.waitForClose()).code).toBe(4003)
      slow.terminate()
    } finally {
      await strict.close()
    }
  }, 60_000)
})
