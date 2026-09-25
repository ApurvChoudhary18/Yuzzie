/**
 * The two Session 4 acceptance criteria that are measured in wall-clock time:
 * delivery under 100 ms (#1) and 25 clients at 100 events/s (#5).
 *
 * They run in the `bench` task, alone (`pnpm turbo bench --concurrency=1`),
 * not in `test`: timing measured while other suites saturate the machine
 * measures the machine. In isolation delivery takes ~15 ms; alongside the
 * e2e suite it has been seen above 100. The correctness criteria (#2-#4) are
 * in `realtime-acceptance.test.ts` and run with everything else.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  addMember,
  createBoard,
  createCard,
  createUser,
  startTestServer,
  type TestBoard,
  type TestServer,
  type TestUser,
} from './__tests__/harness.js'
import { httpBase, listen, range, StreamClient, sleep } from './__tests__/stream.js'

const clients: StreamClient[] = []
async function connect(
  base: string,
  board: TestBoard,
  user: TestUser,
  options: { since?: number } = {},
): Promise<StreamClient> {
  const client = await StreamClient.connect(base, board.slug, user.token, options)
  clients.push(client)
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) client.terminate()
})

async function member(server: TestServer, board: TestBoard): Promise<TestUser> {
  const user = await createUser(server)
  await addMember(server, board, user, 'member')
  return user
}

describe('Session 4 acceptance — timing', () => {
  let server: TestServer
  let base: string

  beforeAll(async () => {
    server = await startTestServer()
    base = await listen(server)
  })

  afterAll(async () => {
    await server.close()
  })

  it('1. a mutation on A reaches B in under 100 ms', async () => {
    const board = await createBoard(server)
    const bob = await member(server, board)
    const a = await connect(base, board, board.owner)
    const b = await connect(base, board, bob)
    await a.ready()
    let seq = (await b.ready()).seq

    const post = (title: string) =>
      fetch(`${httpBase(base)}/v1/boards/${board.slug}/cards`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${board.owner.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title }),
      })

    // Warm the JIT, the pool and the route before measuring.
    for (const title of ['warm 1', 'warm 2', 'warm 3']) {
      await post(title)
      seq += 1
      await b.waitForSeq(seq)
    }

    const samples: number[] = []
    for (const index of range(1, 20)) {
      const started = performance.now()
      const response = await post(`latency ${index}`)
      expect(response.status).toBe(201)
      seq += 1
      await b.waitForSeq(seq)
      samples.push(performance.now() - started)
    }

    // Measured from before the HTTP request to B holding the frame: the full trip
    // through HTTP, the transaction, the broker, and B's socket.
    expect(Math.max(...samples)).toBeLessThan(100)
    expect(b.events.at(-1)).toMatchObject({ type: 'card.created', actor: board.owner.handle })
  })

  it('5. 25 concurrent clients at 100 events/s: nothing dropped, nothing duplicated', async () => {
    const board = await createBoard(server)
    const users = [board.owner]
    for (const _ of range(1, 24)) users.push(await member(server, board))

    const streams = await Promise.all(users.map((user) => connect(base, board, user)))
    const welcomes = await Promise.all(streams.map((stream) => stream.ready()))
    const start = welcomes[0]?.seq ?? 0
    for (const welcome of welcomes) expect(welcome.seq).toBe(start)

    // A mix of event types from several writers, paced at 100 per second.
    const seed = await createCard(server, board, board.owner.token, { title: 'soak target' })
    const TOTAL = 1_000
    const INTERVAL_MS = 10
    const writes: Promise<unknown>[] = []
    const began = performance.now()
    for (let index = 0; index < TOTAL - 1; index += 1) {
      const writer = users[index % 5] as TestUser
      writes.push(
        index % 4 === 3
          ? fetch(`${httpBase(base)}/v1/boards/${board.slug}/cards/${seed.number}/comments`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${writer.token}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ body: `comment ${index}` }),
            })
          : fetch(`${httpBase(base)}/v1/boards/${board.slug}/cards`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${writer.token}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ title: `soak ${index}` }),
            }),
      )
      const due = began + (index + 1) * INTERVAL_MS
      const wait = due - performance.now()
      if (wait > 0) await sleep(wait)
    }
    // The offered load really was 100 events per second, not something gentler.
    // (Completion can trail it when the run is instrumented for coverage; what
    // is under test is fan-out correctness at this rate, not write throughput.)
    const offeredSeconds = (performance.now() - began) / 1000
    expect((TOTAL - 1) / offeredSeconds).toBeGreaterThanOrEqual(95)

    const responses = (await Promise.all(writes)) as Response[]
    expect(responses.every((response) => response.status === 201)).toBe(true)

    const end = start + TOTAL
    await Promise.all(streams.map((stream) => stream.waitForSeq(end, 15_000)))
    await sleep(300)

    const expected = range(start + 1, end)
    for (const stream of streams) {
      expect(stream.seqs).toEqual(expected)
    }
    expect(server.gateway.stats().connections).toBe(25)
  }, 60_000)
})
