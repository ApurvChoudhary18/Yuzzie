/**
 * The five acceptance criteria for SPEC.md §18 Session 4, in the order the spec
 * lists them. Everything runs over real sockets against a real Postgres; the
 * only thing faked anywhere is the gateway's clock in the presence test, so that
 * a 60-second expiry can be measured to the second without waiting a minute.
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

/** Create `count` cards, a few at a time, as `token`. */
async function createCards(
  server: TestServer,
  board: TestBoard,
  token: string,
  count: number,
): Promise<void> {
  for (let done = 0; done < count; done += 20) {
    const batch = Math.min(20, count - done)
    await Promise.all(
      range(1, batch).map((index) =>
        createCard(server, board, token, { title: `card ${done + index}` }),
      ),
    )
  }
}

describe('Session 4 acceptance', () => {
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

  it('2. B misses 10 events, reconnects with since, and receives exactly those 10, in order, once', async () => {
    const board = await createBoard(server)
    const bob = await member(server, board)
    const a = await connect(base, board, board.owner)
    await a.ready()
    const first = await connect(base, board, bob)
    const start = (await first.ready()).seq

    await createCard(server, board, board.owner.token, { title: 'seen live' })
    await first.waitForSeq(start + 1)
    const lastSeen = first.seqs.at(-1) as number

    // Killed, not closed: no goodbye, as when a laptop lid shuts.
    first.terminate()
    await first.waitForClose()

    for (const index of range(1, 10)) {
      await createCard(server, board, board.owner.token, { title: `missed ${index}` })
    }
    await a.waitForSeq(lastSeen + 10)

    const again = await connect(base, board, bob, { since: lastSeen })
    const welcome = await again.ready()
    expect(welcome).toMatchObject({ resumed: true, seq: lastSeen + 10 })
    await again.waitForSeq(lastSeen + 10)

    // Give any duplicate time to show up before asserting there is none.
    await sleep(300)
    expect(again.seqs).toEqual(range(lastSeen + 1, lastSeen + 10))
    expect(again.snapshots).toHaveLength(0)

    // What was replayed is exactly what A saw live, field for field.
    const liveCopy = a.events.filter((event) => event.seq > lastSeen)
    expect(again.events).toEqual(liveCopy)

    // And the stream carries on live from there, still without duplicates.
    await createCard(server, board, board.owner.token, { title: 'after resume' })
    await again.waitForSeq(lastSeen + 11)
    await sleep(100)
    expect(again.seqs).toEqual(range(lastSeen + 1, lastSeen + 11))
  })

  it('3. B misses 600 events and receives a snapshot, not a replay', async () => {
    const board = await createBoard(server)
    const bob = await member(server, board)
    const first = await connect(base, board, bob)
    const lastSeen = (await first.ready()).seq
    first.terminate()
    await first.waitForClose()

    await createCards(server, board, board.owner.token, 600)

    const again = await connect(base, board, bob, { since: lastSeen })
    const welcome = await again.ready()
    await again.until(() => again.snapshots.length === 1, 10_000, 'snapshot')

    expect(welcome).toMatchObject({ resumed: false, seq: lastSeen + 600 })
    const snapshot = again.snapshots[0]
    expect(snapshot?.seq).toBe(lastSeen + 600)
    expect(snapshot?.board.cards).toHaveLength(600)
    expect(snapshot?.board.board.slug).toBe(board.slug)
    expect(again.frames.map((frame) => frame.t).slice(0, 2)).toEqual(['welcome', 'snapshot'])

    await sleep(200)
    expect(again.events).toHaveLength(0)

    // Live events continue from the snapshot's seq.
    await createCard(server, board, board.owner.token, { title: 'after snapshot' })
    await again.waitForSeq(lastSeen + 601)
    expect(again.seqs).toEqual([lastSeen + 601])
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

describe('Session 4 acceptance — presence', () => {
  let server: TestServer
  let base: string
  let clock = Date.now()

  beforeAll(async () => {
    // The gateway's clock is ours to move; its sweep runs every 20 ms of real
    // time, so each second we step it forward is judged almost immediately.
    server = await startTestServer({ presenceSweepMs: 20 }, { now: () => clock })
    base = await listen(server)
  })

  afterAll(async () => {
    await server.close()
  })

  it('4. presence expires 60–70 s after a silent disconnect', async () => {
    const board = await createBoard(server)
    const bob = await member(server, board)
    const alice = await connect(base, board, board.owner)
    await alice.ready()

    const origin = clock
    const b = await connect(base, board, bob)
    await b.ready()
    b.send({ t: 'presence', state: 'working', cardNo: 18, branch: 'task/18-fix-github-oauth' })
    await alice.until(() => alice.present.includes(bob.handle), 2_000, 'bob to appear')

    // From here on Bob sends nothing: no pings, no close. Alice keeps pinging,
    // as a healthy client does, so only Bob falls silent.
    let expiredAt: number | null = null
    let bobClosedAt: number | null = null
    for (let second = 1; second <= 75; second += 1) {
      clock = origin + second * 1_000
      alice.send({ t: 'ping' })
      await sleep(60)
      if (bobClosedAt === null && b.closed !== null) bobClosedAt = second
      if (!alice.present.includes(bob.handle)) {
        expiredAt = second
        break
      }
    }

    // §12.2: the server closes a silent connection after 45 s, but presence
    // outlives the socket until 60 s after the last thing heard.
    expect(b.closed?.code).toBe(4002)
    expect(bobClosedAt).toBeGreaterThanOrEqual(45)
    expect(bobClosedAt).toBeLessThanOrEqual(47)
    expect(expiredAt).not.toBeNull()
    expect(expiredAt).toBeGreaterThanOrEqual(60)
    expect(expiredAt).toBeLessThanOrEqual(70)
    expect(alice.present).toEqual([board.owner.handle])
    expect(alice.closed).toBeNull()
  })

  it('4b. a connection dropped without a goodbye also expires on the TTL, not before', async () => {
    const board = await createBoard(server)
    const bob = await member(server, board)
    const alice = await connect(base, board, board.owner)
    await alice.ready()

    const origin = clock
    const b = await connect(base, board, bob)
    await b.ready()
    await alice.until(() => alice.present.includes(bob.handle), 2_000, 'bob to appear')

    b.terminate()
    await b.waitForClose()

    let expiredAt: number | null = null
    for (let second = 1; second <= 75; second += 1) {
      clock = origin + second * 1_000
      alice.send({ t: 'ping' })
      await sleep(60)
      if (!alice.present.includes(bob.handle)) {
        expiredAt = second
        break
      }
    }
    expect(expiredAt).toBeGreaterThanOrEqual(60)
    expect(expiredAt).toBeLessThanOrEqual(70)
  })
})
