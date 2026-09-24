/**
 * The realtime gateway beyond the five acceptance criteria: auth on upgrade,
 * connection limits, the frame protocol's error paths, idempotency echo, the
 * replay threshold, presence coalescing, and ordering through a broker that
 * loses and reorders messages.
 */
import { STREAM_PROTOCOL } from '@yuzie/core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  addMember,
  call,
  createBoard,
  createCard,
  createUser,
  startTestServer,
  type TestBoard,
  type TestServer,
  type TestUser,
} from './__tests__/harness.js'
import { httpBase, listen, range, StreamClient, sleep } from './__tests__/stream.js'
import { createMemoryPubSub, type PubSub } from './realtime/pubsub.js'

const clients: StreamClient[] = []
async function connect(
  base: string,
  board: TestBoard,
  user: TestUser,
  options: { since?: number; viaHeader?: boolean } = {},
): Promise<StreamClient> {
  const client = await StreamClient.connect(base, board.slug, user.token, options)
  clients.push(client)
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) client.terminate()
})

/** The HTTP status of an upgrade the server refused. */
function refusal(url: string, protocols?: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols)
    socket.on('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0)
      socket.terminate()
    })
    socket.on('open', () => {
      socket.terminate()
      reject(new Error('upgrade unexpectedly succeeded'))
    })
    socket.on('error', () => {})
  })
}

describe('the realtime gateway', () => {
  let server: TestServer
  let base: string
  let clock = Date.now()

  beforeAll(async () => {
    server = await startTestServer({ presenceSweepMs: 20, wsReplayLimit: 5 }, { now: () => clock })
    base = await listen(server)
  })

  afterAll(async () => {
    await server.close()
  })

  async function member(board: TestBoard, role: 'member' | 'viewer' = 'member') {
    const user = await createUser(server)
    await addMember(server, board, user, role)
    return user
  }

  describe('auth on upgrade', () => {
    it('refuses a missing or unknown token with 401 before any socket exists', async () => {
      const board = await createBoard(server)
      const url = `${base}/v1/boards/${board.slug}/stream`
      expect(await refusal(url)).toBe(401)
      expect(await refusal(url, [STREAM_PROTOCOL, 'bearer.yz_not-a-real-token'])).toBe(401)
    })

    it('answers 404 for a board the caller cannot see, so membership cannot be probed', async () => {
      const board = await createBoard(server)
      const outsider = await createUser(server)
      const url = `${base}/v1/boards/${board.slug}/stream`
      expect(await refusal(url, [STREAM_PROTOCOL, `bearer.${outsider.token}`])).toBe(404)
      expect(
        await refusal(`${base}/v1/boards/no-such-board/stream`, [
          STREAM_PROTOCOL,
          `bearer.${outsider.token}`,
        ]),
      ).toBe(404)
    })

    it('refuses a revoked token', async () => {
      const board = await createBoard(server)
      const user = await createUser(server)
      await addMember(server, board, user, 'member')
      const list = await call<{ tokens: { id: string }[] }>(server, {
        method: 'GET',
        url: '/v1/tokens',
        token: user.token,
      })
      await call(server, {
        method: 'DELETE',
        url: `/v1/tokens/${list.body.tokens[0]?.id}`,
        token: user.token,
      })
      const url = `${base}/v1/boards/${board.slug}/stream`
      expect(await refusal(url, [STREAM_PROTOCOL, `bearer.${user.token}`])).toBe(401)
    })

    it('rejects a malformed since with 400', async () => {
      const board = await createBoard(server)
      const url = `${base}/v1/boards/${board.slug}/stream?since=-3`
      expect(await refusal(url, [STREAM_PROTOCOL, `bearer.${board.owner.token}`])).toBe(400)
    })

    it('selects the versioned sub-protocol and never echoes the one carrying the token', async () => {
      const board = await createBoard(server)
      const client = await connect(base, board, board.owner)
      expect(client.socket.protocol).toBe(STREAM_PROTOCOL)
    })

    it('also accepts an Authorization header, for clients that can set one', async () => {
      const board = await createBoard(server)
      const client = await connect(base, board, board.owner, { viaHeader: true })
      const welcome = await client.ready()
      expect(welcome.resumed).toBe(false)
    })

    it('lets a viewer stream the board', async () => {
      const board = await createBoard(server)
      const viewer = await member(board, 'viewer')
      const client = await connect(base, board, viewer)
      await client.ready()
      await createCard(server, board, board.owner.token)
      await client.until(() => client.events.length === 1)
    })

    it('answers a plain GET with 426 Upgrade Required', async () => {
      const board = await createBoard(server)
      const response = await call<{ error: { status: number } }>(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/stream`,
        token: board.owner.token,
      })
      expect(response.status).toBe(426)
      expect(response.body.error.status).toBe(426)
    })
  })

  describe('connection limits (§14.1)', () => {
    it('allows two connections per user per board and closes a third with 4029', async () => {
      const board = await createBoard(server)
      const first = await connect(base, board, board.owner)
      const second = await connect(base, board, board.owner)
      const third = await connect(base, board, board.owner)
      expect((await third.waitForClose()).code).toBe(4029)
      await first.ready()
      await second.ready()

      // The limit is per board: the same user may stream another board.
      const other = await createBoard(server, board.owner)
      const elsewhere = await connect(base, other, board.owner)
      await elsewhere.ready()

      // Closing one frees its slot.
      await first.close()
      const replacement = await connect(base, board, board.owner)
      await replacement.ready()
      expect(replacement.closed).toBeNull()
    })
  })

  describe('the frame protocol (§12.2)', () => {
    it('answers ping with pong', async () => {
      const board = await createBoard(server)
      const client = await connect(base, board, board.owner)
      client.send({ t: 'ping' })
      await client.until(() => client.frames.some((frame) => frame.t === 'pong'))
    })

    it('gives a client with no lastSeq a snapshot of the whole board', async () => {
      const board = await createBoard(server)
      const card = await createCard(server, board, board.owner.token, { title: 'Existing' })
      const client = await connect(base, board, board.owner)
      const welcome = await client.ready()
      await client.until(() => client.snapshots.length === 1)

      expect(welcome).toMatchObject({ resumed: false, seq: 1 })
      const snapshot = client.snapshots[0]
      expect(snapshot?.seq).toBe(1)
      expect(snapshot?.board.columns.map((column) => column.key)).toEqual([
        'todo',
        'doing',
        'review',
        'done',
      ])
      expect(snapshot?.board.members.map((m) => m.handle)).toEqual([board.owner.handle])

      // The snapshot's cards are exactly what the REST API returns.
      const rest = await call<{ cards: unknown[] }>(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/cards`,
        token: board.owner.token,
      })
      expect(snapshot?.board.cards).toEqual(rest.body.cards)
      expect(snapshot?.board.cards[0]).toMatchObject({ number: card.number, title: 'Existing' })
    })

    it('takes lastSeq from hello over ?since=', async () => {
      const board = await createBoard(server)
      await createCard(server, board, board.owner.token)
      await createCard(server, board, board.owner.token)
      const client = await connect(base, board, board.owner, { since: 0 })
      const welcome = await client.ready(1)
      expect(welcome).toMatchObject({ resumed: true, seq: 2 })
      await client.waitForSeq(2)
      expect(client.seqs).toEqual([2])
    })

    it('replays up to the threshold and snapshots one past it', async () => {
      // This server's threshold is 5, so the boundary costs a dozen writes, not a thousand.
      const board = await createBoard(server)
      for (const _ of range(1, 11)) await createCard(server, board, board.owner.token)

      const atLimit = await connect(base, board, board.owner, { since: 6 })
      expect(await atLimit.ready()).toMatchObject({ resumed: true, seq: 11 })
      await atLimit.waitForSeq(11)
      expect(atLimit.seqs).toEqual([7, 8, 9, 10, 11])

      const pastLimit = await connect(base, board, board.owner, { since: 5 })
      expect(await pastLimit.ready()).toMatchObject({ resumed: false, seq: 11 })
      await pastLimit.until(() => pastLimit.snapshots.length === 1)
      expect(pastLimit.events).toHaveLength(0)
    })

    it('snapshots a client that claims to be ahead of the board', async () => {
      const board = await createBoard(server)
      const client = await connect(base, board, board.owner)
      const welcome = await client.ready(999)
      expect(welcome.resumed).toBe(false)
      await client.until(() => client.snapshots.length === 1)
    })

    it('resumes a caught-up client with no events at all', async () => {
      const board = await createBoard(server)
      await createCard(server, board, board.owner.token)
      const client = await connect(base, board, board.owner)
      expect(await client.ready(1)).toMatchObject({ resumed: true, seq: 1 })
      await sleep(100)
      expect(client.events).toHaveLength(0)
      expect(client.snapshots).toHaveLength(0)
    })

    it('echoes the idempotency key live and on replay, so a client can drop its own write', async () => {
      const board = await createBoard(server)
      const live = await connect(base, board, board.owner)
      await live.ready(0)

      await call(server, {
        method: 'POST',
        url: `/v1/boards/${board.slug}/cards`,
        token: board.owner.token,
        body: { title: 'Mine' },
        headers: { 'idempotency-key': 'key-abc-123' },
      })
      await live.waitForSeq(1)
      expect(live.events[0]?.idempotencyKey).toBe('key-abc-123')

      const replayed = await connect(base, board, board.owner)
      await replayed.ready(0)
      await replayed.waitForSeq(1)
      expect(replayed.events[0]?.idempotencyKey).toBe('key-abc-123')

      const rest = await call<{ events: { idempotencyKey?: string }[] }>(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/events?since=0`,
        token: board.owner.token,
      })
      expect(rest.body.events[0]?.idempotencyKey).toBe('key-abc-123')
    })

    it.each([
      ['text that is not JSON', 'not json'],
      ['a frame with an unknown type', JSON.stringify({ t: 'subscribe' })],
      ['a server frame sent by a client', JSON.stringify({ t: 'pong' })],
      ['a presence frame with an invalid state', JSON.stringify({ t: 'presence', state: 'away' })],
    ])('closes with 4000 on %s', async (_label, raw) => {
      const board = await createBoard(server)
      const client = await connect(base, board, board.owner)
      client.socket.send(raw)
      expect((await client.waitForClose()).code).toBe(4000)
    })

    it('closes with 4000 on a binary frame', async () => {
      const board = await createBoard(server)
      const client = await connect(base, board, board.owner)
      client.socket.send(Buffer.from(JSON.stringify({ t: 'ping' })), { binary: true })
      expect((await client.waitForClose()).code).toBe(4000)
    })

    it('closes with 4000 on a second hello', async () => {
      const board = await createBoard(server)
      const client = await connect(base, board, board.owner)
      await client.ready()
      client.hello()
      expect((await client.waitForClose()).code).toBe(4000)
    })

    it('closes a client that floods frames with 4030 (§14.1 message rate cap)', async () => {
      const board = await createBoard(server)
      const client = await connect(base, board, board.owner)
      for (const _ of range(1, 100)) client.send({ t: 'ping' })
      expect((await client.waitForClose()).code).toBe(4030)
    })

    it('closes a client that never says hello with 4001', async () => {
      const board = await createBoard(server)
      const client = await connect(base, board, board.owner)
      clock += 10_001
      expect((await client.waitForClose()).code).toBe(4001)
    })

    it('closes a silent client after 45 s with 4002, and not before', async () => {
      const board = await createBoard(server)
      const client = await connect(base, board, board.owner)
      await client.ready()
      const origin = clock
      clock = origin + 44_000
      await sleep(100)
      expect(client.closed).toBeNull()
      clock = origin + 45_000
      expect((await client.waitForClose()).code).toBe(4002)
    })
  })

  describe('presence', () => {
    it('includes the connecting user in welcome and tells everyone else', async () => {
      const board = await createBoard(server)
      const bob = await member(board)
      const alice = await connect(base, board, board.owner)
      expect((await alice.ready()).presence.map((user) => user.handle)).toEqual([
        board.owner.handle,
      ])

      const b = await connect(base, board, bob)
      const welcome = await b.ready()
      expect(welcome.presence.map((user) => user.handle).sort()).toEqual(
        [board.owner.handle, bob.handle].sort(),
      )
      await alice.until(() => alice.present.includes(bob.handle))
    })

    it('reflects viewing and working, and reports it over REST too', async () => {
      const board = await createBoard(server)
      const alice = await connect(base, board, board.owner)
      await alice.ready()
      alice.send({ t: 'presence', state: 'working', cardNo: 18, branch: 'task/18-fix-oauth' })
      await alice.until(() => alice.presenceFrames.at(-1)?.users[0]?.state === 'working')

      expect(alice.presenceFrames.at(-1)?.users[0]).toMatchObject({
        handle: board.owner.handle,
        kind: 'human',
        state: 'working',
        cardNo: 18,
        branch: 'task/18-fix-oauth',
      })

      const rest = await call<{ users: { handle: string; state: string }[] }>(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/presence`,
        token: board.owner.token,
      })
      expect(rest.body.users).toEqual([
        expect.objectContaining({ handle: board.owner.handle, state: 'working' }),
      ])

      alice.send({ t: 'presence', state: 'idle' })
      await alice.until(() => alice.presenceFrames.at(-1)?.users[0]?.state === 'online')
      expect(alice.presenceFrames.at(-1)?.users[0]).toMatchObject({ cardNo: null, branch: null })
    })

    it('marks an agent as an agent (§8.5)', async () => {
      const board = await createBoard(server)
      const agent = await createUser(server, { kind: 'agent' })
      await addMember(server, board, agent, 'member')
      const alice = await connect(base, board, board.owner)
      await alice.ready()
      const claude = await connect(base, board, agent)
      await claude.ready()
      await alice.until(() => alice.present.includes(agent.handle))
      const entry = alice.presenceFrames.at(-1)?.users.find((u) => u.handle === agent.handle)
      expect(entry?.kind).toBe('agent')
    })

    it('shows a user with two sessions once, at their most engaged', async () => {
      const board = await createBoard(server)
      const bob = await member(board)
      const alice = await connect(base, board, board.owner)
      await alice.ready()
      const tui = await connect(base, board, bob)
      const watch = await connect(base, board, bob)
      await tui.ready()
      await watch.ready()
      tui.send({ t: 'presence', state: 'viewing', cardNo: 3 })
      await alice.until(
        () => alice.presenceFrames.at(-1)?.users.some((u) => u.state === 'viewing') ?? false,
      )
      const bobs = alice.presenceFrames.at(-1)?.users.filter((u) => u.handle === bob.handle)
      expect(bobs).toHaveLength(1)
      expect(bobs?.[0]).toMatchObject({ state: 'viewing', cardNo: 3 })
    })

    it('removes a user who says goodbye at once, without waiting for the TTL', async () => {
      const board = await createBoard(server)
      const bob = await member(board)
      const alice = await connect(base, board, board.owner)
      await alice.ready()
      const b = await connect(base, board, bob)
      await b.ready()
      await alice.until(() => alice.present.includes(bob.handle))
      await b.close()
      await alice.until(() => !alice.present.includes(bob.handle), 1_000, 'bob to leave')
    })

    it('coalesces a burst of changes to at most one broadcast per 200 ms', async () => {
      const board = await createBoard(server)
      const bob = await member(board)
      const alice = await connect(base, board, board.owner)
      await alice.ready()
      const b = await connect(base, board, bob)
      await b.ready()
      await alice.until(() => alice.present.includes(bob.handle))
      await sleep(250)

      const before = alice.presenceFrames.length
      const arrivals: number[] = []
      alice.socket.on('message', (data) => {
        if (String(data).startsWith('{"t":"presence"')) arrivals.push(performance.now())
      })

      // 30 distinct changes in ~300 ms, under the message rate cap.
      for (const cardNo of range(1, 30)) {
        b.send({ t: 'presence', state: 'viewing', cardNo })
        await sleep(10)
      }
      await alice.until(
        () =>
          alice.presenceFrames
            .at(-1)
            ?.users.some((u) => u.handle === bob.handle && u.cardNo === 30) ?? false,
        2_000,
        'final presence',
      )

      const broadcasts = alice.presenceFrames.length - before
      // ~300 ms of changes at ≤ 5 Hz is at most three broadcasts, plus one that
      // may straddle the window's edge.
      expect(broadcasts).toBeLessThanOrEqual(4)
      for (let index = 1; index < arrivals.length; index += 1) {
        expect((arrivals[index] as number) - (arrivals[index - 1] as number)).toBeGreaterThan(180)
      }
    })

    it('reports an empty presence list for a board nobody is streaming', async () => {
      const board = await createBoard(server)
      const rest = await call<{ users: unknown[] }>(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/presence`,
        token: board.owner.token,
      })
      expect(rest.body.users).toEqual([])
    })
  })

  it('counts open connections in yuzie_ws_connections', async () => {
    const board = await createBoard(server)
    const before = server.gateway.stats().connections
    const client = await connect(base, board, board.owner)
    await client.ready()
    const metrics = await (await fetch(`${httpBase(base)}/metrics`)).text()
    expect(metrics).toMatch(/yuzie_ws_connections \d+/)
    expect(server.gateway.stats().connections).toBe(before + 1)
    await client.close()
    await sleep(50)
    expect(server.gateway.stats().connections).toBe(before)
  })
})

describe('ordering through an unreliable broker', () => {
  /**
   * Wraps the in-memory broker to misbehave the way a real one can: drop some
   * messages and deliver others late. The gateway must still hand every client
   * every event, once, in order.
   */
  function unreliable(inner: PubSub) {
    // Only event messages are counted, so which ones misbehave does not depend
    // on how presence traffic happened to interleave.
    let count = 0
    const broker = {
      dropped: 0,
      delayed: 0,
      /** When set, every event message is dropped: a total outage of the broker. */
      blackhole: false,
      async publish(topic: string, message: string) {
        if (!message.startsWith('{"k":"events"')) return inner.publish(topic, message)
        count += 1
        if (broker.blackhole || count % 7 === 0) {
          broker.dropped += 1
          return
        }
        if (count % 5 === 0) {
          broker.delayed += 1
          setTimeout(() => void inner.publish(topic, message), 30)
          return
        }
        return inner.publish(topic, message)
      },
      subscribe: inner.subscribe.bind(inner),
      close: inner.close.bind(inner),
    }
    return broker
  }

  let server: TestServer
  let base: string
  const broker = unreliable(createMemoryPubSub())

  beforeAll(async () => {
    server = await startTestServer({ presenceSweepMs: 50, wsHeadCheckMs: 200 }, { pubsub: broker })
    base = await listen(server)
  })

  afterAll(async () => {
    await server.close()
  })

  it('delivers every event once and in seq order despite drops and reordering', async () => {
    const board = await createBoard(server)
    const client = await connect(base, board, board.owner)
    await client.ready(0)

    for (const _ of range(1, 61)) await createCard(server, board, board.owner.token)

    await client.waitForSeq(61, 5_000)
    await sleep(200)
    expect(broker.dropped).toBeGreaterThan(0)
    expect(broker.delayed).toBeGreaterThan(0)
    expect(client.seqs).toEqual(range(1, 61))
  })

  it('recovers events whose messages were all lost, with no later write to reveal them', async () => {
    const board = await createBoard(server)
    const client = await connect(base, board, board.owner)
    await client.ready(0)

    broker.blackhole = true
    try {
      for (const _ of range(1, 3)) await createCard(server, board, board.owner.token)
    } finally {
      broker.blackhole = false
    }

    // Nothing arrives through the broker, and nothing else is written. The
    // periodic head check (200 ms here, 5 s by default) finds them in the log.
    await client.waitForSeq(3, 3_000)
    await sleep(100)
    expect(client.seqs).toEqual([1, 2, 3])
  })

  it('does not stall behind a seq the log never had', async () => {
    // Impossible by construction (seq is allocated under the board lock), so it
    // is forced here: the broker announces seq 3 on a board whose log ends at 1.
    const board = await createBoard(server)
    const client = await connect(base, board, board.owner)
    await client.ready(0)
    await createCard(server, board, board.owner.token)
    await client.waitForSeq(1)

    const events = await call<{ events: Array<Record<string, unknown>> }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/events?since=0`,
      token: board.owner.token,
    })
    const phantom = { ...events.body.events[0], seq: 3 }
    await broker.publish(
      `yuzie:board:${board.id}`,
      JSON.stringify({ k: 'events', events: [phantom] }),
    )

    // The gateway looks for seq 2, finds the log has no such event, and steps
    // over it rather than holding every later event back forever.
    await client.waitForSeq(3, 3_000)
    expect(client.seqs).toEqual([1, 3])
  })

  it('drops an event delivered twice', async () => {
    const board = await createBoard(server)
    const client = await connect(base, board, board.owner)
    await client.ready(0)
    await createCard(server, board, board.owner.token)
    await client.waitForSeq(1)

    // Replay the committed event straight into the broker a second time.
    const events = await call<{ events: unknown[] }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/events?since=0`,
      token: board.owner.token,
    })
    await broker.publish(
      `yuzie:board:${board.id}`,
      JSON.stringify({ k: 'events', events: events.body.events }),
    )
    await createCard(server, board, board.owner.token)
    await client.waitForSeq(2)
    await sleep(100)
    expect(client.seqs).toEqual([1, 2])
  })
})

describe('a broker that lags the database', () => {
  /**
   * Redis under load delivers an event some milliseconds after its commit. A
   * client syncing in that window gets the event twice — once in the snapshot or
   * replay, once live — unless the gateway filters what it held while syncing.
   * Delaying every event by 30 ms makes that window wide enough to hit reliably.
   */
  let server: TestServer
  let base: string

  beforeAll(async () => {
    const inner = createMemoryPubSub()
    const lagging: PubSub = {
      async publish(topic, message) {
        if (!message.startsWith('{"k":"events"')) return inner.publish(topic, message)
        setTimeout(() => void inner.publish(topic, message), 30)
      },
      subscribe: inner.subscribe.bind(inner),
      close: inner.close.bind(inner),
    }
    server = await startTestServer({ wsReplayLimit: 5 }, { pubsub: lagging })
    base = await listen(server)
  })

  afterAll(async () => {
    await server.close()
  })

  it('hands a client that joins mid-write every event once, whether it resumes or snapshots', async () => {
    // Writes land while each client is still reading the log or the snapshot,
    // which is exactly the window where an event could be sent twice or not at all.
    const board = await createBoard(server)
    // Enough cards that a snapshot takes a while to read, so writes land inside it.
    for (let done = 0; done < 300; done += 25) {
      await Promise.all(range(1, 25).map(() => createCard(server, board, board.owner.token)))
    }

    let writing = true
    const writers = range(1, 4).map(async () => {
      while (writing) await createCard(server, board, board.owner.token)
    })

    const joined: Array<{ client: StreamClient; from: number | undefined }> = []
    const starts = [undefined, 297, undefined, 298, undefined, 299, undefined, undefined]
    for (const from of [...starts, ...starts]) {
      const user = await createUser(server)
      await addMember(server, board, user, 'member')
      const client = await StreamClient.connect(base, board.slug, user.token)
      clients.push(client)
      client.hello(from)
      joined.push({ client, from })
      await sleep(15)
    }
    await sleep(100)
    writing = false
    await Promise.all(writers)

    const head = (
      await call<{ seq: number }>(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/events?since=0&limit=1`,
        token: board.owner.token,
      })
    ).body.seq

    for (const { client, from } of joined) {
      // Caught up means holding `head`, from an event or from the snapshot itself.
      await client.until(
        () =>
          (client.seqs.at(-1) ?? client.snapshots[0]?.seq ?? -1) >= head ||
          (client.snapshots[0]?.seq ?? -1) >= head,
        5_000,
        'caught up',
      )
      await sleep(50)
      const welcome = client.welcome
      if (welcome === undefined) throw new Error('no welcome')
      if (from === undefined) expect(welcome.resumed).toBe(false)
      // A replayed client starts after its lastSeq; a snapshotted one after the snapshot.
      const start = welcome.resumed ? (from as number) : (client.snapshots[0]?.seq as number)
      expect(client.seqs).toEqual(range(start + 1, head))
    }
  })
})
