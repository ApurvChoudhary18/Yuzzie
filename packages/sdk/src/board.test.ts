/**
 * The board's state machine, against an in-memory fake of the API.
 *
 * The real-server behaviour is proven in `e2e/src/sdk.test.ts`; this suite pins
 * the logic that is hard to provoke on demand there — an echo racing its HTTP
 * response, a gap in the stream, a queue that must stay in order — and runs on
 * every platform, Docker or not.
 */
import {
  type Card,
  type Column,
  ConflictError,
  type EventEnvelope,
  OfflineError,
  ValidationError,
} from '@yuzie/core'
import { describe, expect, it } from 'vitest'
import { Board, type ConflictEvent, matchColumn, type RejectedEvent } from './board.js'
import { createMemoryOutbox } from './cache.js'
import { createClient } from './client.js'
import { Emitter } from './emitter.js'
import { createHttp } from './http.js'
import { Yuzie as NodeYuzie } from './node.js'
import type { FetchLike, RequestInitLike, ResponseLike, WebSocketLike } from './platform.js'

const BOARD_ID = '11111111-1111-4111-8111-111111111111'
const T = '2026-08-19T09:00:00.000Z'

const COLUMNS: Column[] = ['todo', 'doing', 'review', 'done'].map((key, index) => ({
  id: `66666666-6666-4666-8666-00000000000${index}`,
  boardId: BOARD_ID,
  key,
  name: key,
  rank: String.fromCharCode(97 + index),
  semantics: null,
  wipLimit: null,
}))

function card(number: number, overrides: Partial<Card> = {}): Card {
  return {
    id: `33333333-3333-4333-8333-${String(number).padStart(12, '0')}`,
    boardId: BOARD_ID,
    number,
    column: 'todo',
    rank: `a${number}`,
    title: `Card ${number}`,
    description: null,
    priority: null,
    dueAt: null,
    assignees: [],
    labels: [],
    watchers: [],
    checklist: [],
    comments: [],
    commits: [],
    git: null,
    anchor: null,
    createdBy: 'rahul',
    archivedAt: null,
    createdAt: T,
    updatedAt: T,
    version: 1,
    ...overrides,
  }
}

function reply(status: number, body?: unknown): ResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

function problem(code: string, status: number, details: Record<string, unknown> = {}) {
  return { error: { code, message: code, status, details } }
}

type Route = (
  init: RequestInitLike,
  match: RegExpMatchArray,
) => ResponseLike | Promise<ResponseLike>

/** A fake API: routes by method + path regex, records every call, can go offline. */
class FakeApi {
  offline = false
  readonly calls: Array<{ method: string; path: string; init: RequestInitLike }> = []
  cards = new Map<number, Card>([[1, card(1)]])
  events: EventEnvelope[] = []
  private readonly routes: Array<{ method: string; pattern: RegExp; handle: Route }> = []

  constructor() {
    this.on('GET', /^\/boards\/b$/, () =>
      reply(200, {
        board: {
          id: BOARD_ID,
          workspaceId: '22222222-2222-4222-8222-222222222222',
          slug: 'b',
          name: 'B',
          repoRemote: null,
          baseBranch: 'main',
          branchTemplate: 'task/{id}-{slug}',
          nextCardNo: 2,
          archivedAt: null,
          createdAt: T,
        },
        columns: COLUMNS,
        labels: [],
        members: [],
      }),
    )
    this.on('GET', /^\/me$/, () =>
      reply(200, {
        user: {
          id: '44444444-4444-4444-8444-444444444444',
          handle: 'rahul',
          email: null,
          displayName: null,
          avatarUrl: null,
          kind: 'human',
          githubLogin: null,
          createdAt: T,
        },
        memberships: [],
      }),
    )
    this.on('GET', /^\/boards\/b\/cards$/, () =>
      reply(200, { cards: [...this.cards.values()], boardSlug: 'b', count: this.cards.size }),
    )
    this.on('GET', /^\/boards\/b\/cards\/(\d+)$/, (_init, match) => {
      const found = this.cards.get(Number(match[1]))
      return found === undefined ? reply(404, problem('card_not_found', 404)) : reply(200, found)
    })
    this.on('GET', /^\/boards\/b\/events\?since=(\d+)/, (_init, match) => {
      const since = Number(match[1])
      const head = this.events.at(-1)?.seq ?? 0
      return reply(200, { events: this.events.filter((e) => e.seq > since), seq: head })
    })
  }

  on(method: string, pattern: RegExp, handle: Route): void {
    this.routes.unshift({ method, pattern, handle })
  }

  readonly fetch: FetchLike = async (url, init) => {
    const path = url.replace('https://api.test/v1', '')
    this.calls.push({ method: init.method, path, init })
    if (this.offline) throw new TypeError('fetch failed')
    for (const route of this.routes) {
      const match = path.match(route.pattern)
      if (route.method === init.method && match !== null) return route.handle(init, match)
    }
    return reply(404, problem('card_not_found', 404))
  }

  writes(): string[] {
    return this.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)
  }
}

class FakeSocket implements WebSocketLike {
  readyState = 0
  protocol = 'yuzie.v1'
  onopen: WebSocketLike['onopen'] = null
  onmessage: WebSocketLike['onmessage'] = null
  onclose: WebSocketLike['onclose'] = null
  onerror: WebSocketLike['onerror'] = null
  readonly sent: Array<Record<string, unknown>> = []
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    this.readyState = 3
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  frame(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function moved(seq: number, number: number, to: string, idempotencyKey?: string): EventEnvelope {
  return {
    seq,
    type: 'card.moved',
    actor: 'priya',
    cardNo: number,
    payload: { from: 'todo', to, rank: `z${seq}` },
    ts: T,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function connectHttpOnly(api: FakeApi, offline: 'queue' | 'fail' = 'fail'): Promise<Board> {
  return createClient({
    baseUrl: 'https://api.test/v1',
    token: 'yz_t',
    fetch: api.fetch,
    retries: 0,
  }).connect('b', { realtime: false, offline })
}

/** Open a streaming board: waits for the socket to exist, then plays the server's side. */
async function connectStreaming(
  api: FakeApi,
  handshake?: (socket: FakeSocket) => void,
): Promise<{ board: Board; socket: FakeSocket; hello: Record<string, unknown> }> {
  // What the real gateway does for a client with no state: welcome, then a snapshot.
  const detail = JSON.parse(
    await (await api.fetch('https://api.test/v1/boards/b', { method: 'GET', headers: {} })).text(),
  ) as Record<string, unknown>
  api.calls.length = 0
  const serverHandshake = (socket: FakeSocket) => {
    socket.frame({ t: 'welcome', seq: 0, presence: [], resumed: false })
    socket.frame({ t: 'snapshot', seq: 0, board: { ...detail, cards: [...api.cards.values()] } })
  }
  const sockets: FakeSocket[] = []
  const opening = createClient({
    baseUrl: 'https://api.test/v1',
    token: 'yz_t',
    fetch: api.fetch,
  }).connect('b', {
    webSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  })
  while (sockets.length === 0) await settle()
  const socket = sockets[0] as FakeSocket
  socket.open()
  ;(handshake ?? serverHandshake)(socket)
  const board = await opening
  return { board, socket, hello: socket.sent[0] ?? {} }
}

describe('opening a board', () => {
  it('loads board, columns and cards over HTTP when not streaming', async () => {
    const api = new FakeApi()
    const board = await connectHttpOnly(api)
    expect(board.state.board?.slug).toBe('b')
    expect(board.state.columns).toHaveLength(4)
    expect(board.state.cards[1]?.title).toBe('Card 1')
    expect(board.status).toBe('live')
  })

  it('streams: asks for a snapshot, and resolves once it is folded in', async () => {
    const api = new FakeApi()
    const detail = JSON.parse(
      await (
        await api.fetch('https://api.test/v1/boards/b', { method: 'GET', headers: {} })
      ).text(),
    )
    const { board, hello } = await connectStreaming(api, (socket) => {
      socket.frame({ t: 'welcome', seq: 4, presence: [], resumed: false })
      socket.frame({
        t: 'snapshot',
        seq: 4,
        board: { ...detail, cards: [card(1), card(2, { column: 'done' })] },
      })
    })
    // A client with no state asks for a snapshot by leaving lastSeq out.
    expect(hello).toMatchObject({ t: 'hello' })
    expect(hello).not.toHaveProperty('lastSeq')
    expect(board.state.seq).toBe(4)
    expect(board.state.cards[2]?.column).toBe('done')
    expect(board.status).toBe('live')
    await board.close()
  })
})

describe('optimistic writes', () => {
  it('apply before the server answers and settle to the server’s card', async () => {
    const api = new FakeApi()
    let release: () => void = () => {}
    api.on('POST', /^\/boards\/b\/cards\/1\/move$/, async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return reply(200, card(1, { column: 'done', rank: 'q', version: 2 }))
    })
    const board = await connectHttpOnly(api)

    const moving = board.cards.move(1, 'DON')
    expect(board.state.cards[1]?.column).toBe('done')
    expect(board.unconfirmed).toBe(1)
    expect([...board.pendingCards]).toEqual([1])

    release()
    await moving
    expect(board.unconfirmed).toBe(0)
    expect(board.pendingCards.size).toBe(0)
    expect(board.state.cards[1]).toMatchObject({ column: 'done', rank: 'q', version: 2 })
  })

  it('are resolved by their own event echoing back, even before the HTTP response', async () => {
    const api = new FakeApi()
    let socket: FakeSocket | undefined
    let release: () => void = () => {}
    api.on('POST', /^\/boards\/b\/cards\/1\/move$/, async (init) => {
      // The event reaches the client before the HTTP response does.
      socket?.frame({ t: 'event', ...moved(1, 1, 'review', init.headers['idempotency-key']) })
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return reply(200, card(1, { column: 'review', rank: 'z1', version: 2 }))
    })
    const connected = await connectStreaming(api)
    socket = connected.socket
    const { board } = connected

    const moving = board.cards.move(1, 'review')
    await settle()
    await settle()
    expect(board.state.seq).toBe(1)
    expect(board.unconfirmed).toBe(0)
    expect(board.state.cards[1]?.column).toBe('review')
    release()
    await moving
    await board.close()
  })

  it('fill a gap in the stream from the event log before applying what arrived early', async () => {
    const api = new FakeApi()
    api.events = [moved(1, 1, 'doing'), moved(2, 1, 'review'), moved(3, 1, 'done')]
    const { board, socket } = await connectStreaming(api)
    const seen: number[] = []
    board.on('*', (event) => seen.push(event.seq))

    socket.frame({ t: 'event', ...moved(1, 1, 'doing') })
    socket.frame({ t: 'event', ...moved(3, 1, 'done') })
    for (let tick = 0; tick < 10; tick += 1) await settle()

    expect(api.calls.map((c) => c.path)).toContain('/boards/b/events?since=1&limit=500')
    expect(seen).toEqual([1, 2, 3])
    expect(board.state.cards[1]?.column).toBe('done')
    await board.close()
  })
})

describe('conflicts', () => {
  it('roll the optimistic edit back to the server’s card and emit conflict', async () => {
    const api = new FakeApi()
    const winner = card(1, { title: 'Theirs', version: 5 })
    api.on('PATCH', /^\/boards\/b\/cards\/1$/, (init) => {
      expect(init.headers['if-match']).toBe('1')
      return reply(409, problem('version_conflict', 409, { number: 1, current: winner }))
    })
    const board = await connectHttpOnly(api)
    const conflicts: ConflictEvent[] = []
    board.on('conflict', (conflict) => conflicts.push(conflict))

    const editing = board.cards.update(1, { title: 'Mine' })
    expect(board.state.cards[1]?.title).toBe('Mine')
    await expect(editing).rejects.toBeInstanceOf(ConflictError)

    expect(board.state.cards[1]).toEqual(winner)
    expect(conflicts).toEqual([expect.objectContaining({ cardNo: 1, current: winner })])
  })

  it('still roll back when the conflict carries no card', async () => {
    const api = new FakeApi()
    api.on('PATCH', /^\/boards\/b\/cards\/1$/, () =>
      reply(409, problem('version_conflict', 409, { number: 1 })),
    )
    const board = await connectHttpOnly(api)
    const conflicts: ConflictEvent[] = []
    board.on('conflict', (conflict) => conflicts.push(conflict))
    await expect(board.cards.update(1, { title: 'Mine' })).rejects.toBeInstanceOf(ConflictError)
    expect(board.state.cards[1]?.title).toBe('Card 1')
    expect(conflicts[0]).toMatchObject({ cardNo: 1, current: null })
  })
})

describe('the offline queue', () => {
  it('keeps order: once anything is queued, later writes queue behind it', async () => {
    const api = new FakeApi()
    api.on('POST', /^\/boards\/b\/cards\/1\/move$/, () => reply(200, card(1, { column: 'done' })))
    api.on('POST', /^\/boards\/b\/cards\/1\/assign$/, () =>
      reply(200, card(1, { assignees: ['priya'] })),
    )
    const board = await connectHttpOnly(api, 'queue')

    api.offline = true
    await board.cards.move(1, 'done')
    api.offline = false
    // The network is back, but this must not overtake the queued move.
    await board.cards.assign(1, ['priya'])
    expect(board.queued).toBe(2)
    expect(api.writes()).toEqual(['POST /boards/b/cards/1/move'])

    const report = await board.sync()
    expect(report).toMatchObject({ sent: 2, conflicts: 0, rejected: 0, remaining: 0 })
    const keys = api.calls
      .filter((c) => c.method === 'POST')
      .map((c) => c.init.headers['idempotency-key'])
    // The retried move reused the key it was first sent with.
    expect(keys[0]).toBe(keys[1])
    expect(api.writes()).toEqual([
      'POST /boards/b/cards/1/move',
      'POST /boards/b/cards/1/move',
      'POST /boards/b/cards/1/assign',
    ])
  })

  it('stops at the first write the server cannot take yet, and reports the rest as remaining', async () => {
    const api = new FakeApi()
    let failures = 1
    api.on('POST', /^\/boards\/b\/cards\/1\/move$/, () =>
      failures-- > 0
        ? reply(503, problem('internal', 503))
        : reply(200, card(1, { column: 'done' })),
    )
    const board = await connectHttpOnly(api, 'queue')
    api.offline = true
    await board.cards.move(1, 'done')
    await board.cards.move(1, 'done')
    api.offline = false

    expect(await board.sync()).toMatchObject({ sent: 0, conflicts: 0, rejected: 0, remaining: 2 })
    expect(await board.sync()).toMatchObject({ sent: 2, conflicts: 0, rejected: 0, remaining: 0 })
  })

  it('retries a refused write, then sets it aside after three tries without blocking the rest', async () => {
    const api = new FakeApi()
    api.cards.set(2, card(2))
    api.on('POST', /^\/boards\/b\/cards\/1\/move$/, () =>
      reply(404, problem('card_not_found', 404)),
    )
    api.on('POST', /^\/boards\/b\/cards\/1\/assign$/, () => reply(200, card(1)))
    api.on('POST', /^\/boards\/b\/cards\/2\/move$/, () => reply(200, card(2, { column: 'done' })))
    const board = await connectHttpOnly(api, 'queue')
    api.offline = true
    await board.cards.move(1, 'done')
    await board.cards.assign(1, ['priya'])
    await board.cards.move(2, 'done')
    api.offline = false
    const rejected: RejectedEvent[] = []
    board.on('rejected', (event) => rejected.push(event))

    // 1st try: refused. #1's later write waits behind it; #2 goes ahead.
    const first = await board.sync()
    expect(first).toMatchObject({ sent: 1, failed: 1, rejected: 0, remaining: 2, quarantined: 0 })
    expect(first.outcomes.map((o) => `${o.kind} #${o.cardNo}`)).toEqual([
      'retry #1',
      'held #1',
      'sent #2',
    ])
    expect(board.state.cards[1]?.column).toBe('done') // still assumed, still queued

    expect((await board.sync()).failed).toBe(1)
    // 3rd try: set aside, reported, and the rest of #1's queue moves again.
    const third = await board.sync()
    expect(third).toMatchObject({ rejected: 1, quarantined: 1, remaining: 0 })
    expect(third.outcomes.map((o) => o.kind)).toEqual(['quarantined', 'sent'])
    expect(third.outcomes[0]).toMatchObject({
      attempts: 3,
      error: expect.stringContaining('card_not_found'),
    })
    expect(rejected[0]?.error.code).toBe('card_not_found')
    expect(board.quarantine).toHaveLength(1)
    expect(board.state.cards[1]?.column).toBe('todo')
  })

  it('two offline edits to one card are not a conflict with each other', async () => {
    const api = new FakeApi()
    let serverVersion = 1
    const seen: Array<string | undefined> = []
    api.on('PATCH', /^\/boards\/b\/cards\/1$/, (init) => {
      const ifMatch = init.headers['if-match']
      seen.push(ifMatch)
      if (Number(ifMatch) !== serverVersion)
        return reply(
          409,
          problem('version_conflict', 409, {
            number: 1,
            current: card(1, { version: serverVersion }),
          }),
        )
      serverVersion += 1
      api.cards.set(1, card(1, { version: serverVersion }))
      return reply(200, api.cards.get(1))
    })
    const board = await connectHttpOnly(api, 'queue')
    api.offline = true
    await board.cards.update(1, { title: 'First' })
    await board.cards.update(1, { priority: 1 })
    api.offline = false
    const report = await board.sync()
    expect(report).toMatchObject({ sent: 2, conflicts: 0, remaining: 0 })
    // The second was checked against the version the first one left.
    expect(seen).toEqual(['1', '2'])
  })

  it('reports a conflict with the card that replaced the local change', async () => {
    const api = new FakeApi()
    const winner = card(1, { title: 'Theirs', version: 3 })
    api.on('PATCH', /^\/boards\/b\/cards\/1$/, () =>
      reply(409, problem('version_conflict', 409, { number: 1, current: winner })),
    )
    const board = await connectHttpOnly(api, 'queue')
    api.offline = true
    await board.cards.update(1, { title: 'Mine' })
    expect(board.state.cards[1]?.title).toBe('Mine')
    api.offline = false
    const report = await board.sync()
    expect(report).toMatchObject({ conflicts: 1, remaining: 0 })
    expect(report.outcomes[0]).toMatchObject({
      kind: 'conflict',
      cardNo: 1,
      current: { title: 'Theirs' },
    })
    expect(board.state.cards[1]?.title).not.toBe('Mine')
  })

  it('a queued write shows in the next process too, until it is sent (shadows)', async () => {
    const { openCache } = await import('@yuzie/store')
    const cache = openCache({ boardSlug: 'b', location: ':memory:' })
    const api = new FakeApi()
    const open = () =>
      createClient({
        baseUrl: 'https://api.test/v1',
        token: 'yz_t',
        fetch: api.fetch,
        retries: 0,
      }).connect('b', { realtime: false, offline: 'queue', cache })
    const first = await open()
    api.offline = true
    await first.cards.move(1, 'done')
    const created = await first.cards.create({ title: 'Made offline' })
    expect(created.number).toBeLessThan(0)
    await first.close()

    // A new process, still offline: the cache holds the server's truth, and
    // the queue replays on top of it.
    const second = await open()
    expect(second.online).toBe(false)
    expect(second.state.cards[1]?.column).toBe('done')
    expect(Object.values(second.state.cards).map((c) => c.title)).toContain('Made offline')
    expect([...second.queuedCards].sort()).toEqual([created.number, 1].sort())
    // Another offline create does not reuse the first one's provisional number.
    const again = await second.cards.create({ title: 'Also offline' })
    expect(again.number).toBeLessThan(created.number)
    await second.close()

    // Back online: opening sends the queue first, and the overlay gives way to the truth.
    api.offline = false
    api.on('POST', /^\/boards\/b\/cards\/1\/move$/, () => {
      api.cards.set(1, card(1, { column: 'done', version: 2 }))
      return reply(200, api.cards.get(1))
    })
    api.on('POST', /^\/boards\/b\/cards$/, (init) => {
      const title = (JSON.parse(String(init.body)) as { title: string }).title
      const number = api.cards.size + 1
      api.cards.set(number, card(number, { title }))
      return reply(201, api.cards.get(number))
    })
    const third = await open()
    expect(third.lastDrain).toMatchObject({ sent: 3, remaining: 0 })
    expect(third.queuedCards.size).toBe(0)
    expect(Object.values(third.state.cards).every((c) => c.number > 0)).toBe(true)
    expect(
      Object.values(third.state.cards)
        .map((c) => c.title)
        .sort(),
    ).toEqual(['Also offline', 'Card 1', 'Made offline'])
    await third.close()
    cache.close()
  })

  it('a probe that fails means nothing waits on the network', async () => {
    const { openCache } = await import('@yuzie/store')
    const cache = openCache({ boardSlug: 'b', location: ':memory:' })
    cache.columns.putMany('b', COLUMNS)
    cache.cards.put('b', card(1))
    const api = new FakeApi()
    let requests = 0
    const counting: typeof api.fetch = async (url, init) => {
      requests += 1
      return api.fetch(url, init)
    }
    const board = new Board({
      slug: 'b',
      http: createHttp({ baseUrl: 'https://api.test/v1', fetch: counting, retries: 0 }),
      offline: 'queue',
      realtime: false,
      token: () => 'yz_t',
      connectTimeoutMs: 1_000,
      cache,
      probe: async () => false,
    })
    await board.open()
    expect(board.online).toBe(false)
    expect(board.state.cards[1]).toBeDefined()
    await board.cards.move(1, 'done')
    expect(board.state.cards[1]?.column).toBe('done')
    expect(requests).toBe(0)
    expect(board.queued).toBe(1)
    expect((await board.sync()).reachable).toBe(false)
    expect(requests).toBe(0)
    await board.close()
    cache.close()
  })

  it('throws OfflineError instead when offline is "fail"', async () => {
    const api = new FakeApi()
    const board = await connectHttpOnly(api, 'fail')
    api.offline = true
    await expect(board.cards.move(1, 'done')).rejects.toBeInstanceOf(OfflineError)
    expect(board.state.cards[1]?.column).toBe('todo')
    expect(board.queued).toBe(0)
  })

  it('answers reads from local state while offline', async () => {
    const api = new FakeApi()
    const board = await connectHttpOnly(api, 'queue')
    api.offline = true
    expect((await board.cards.list({ column: 'to' })).map((c) => c.number)).toEqual([1])
    expect((await board.cards.get(1)).title).toBe('Card 1')
    await expect(board.cards.get(99)).rejects.toBeInstanceOf(OfflineError)
  })

  it('searches comments, and filters watching and stale, from local state (§18 Session 14)', async () => {
    const { openCache } = await import('@yuzie/store')
    const cache = openCache({ boardSlug: 'b', location: ':memory:' })
    const day = 86_400_000
    const now = Date.parse('2026-08-20T09:00:00Z')
    cache.columns.putMany('b', COLUMNS)
    cache.cards.putMany('b', [
      card(1, {
        watchers: ['rahul'],
        updatedAt: new Date(now).toISOString(),
        comments: [
          {
            id: '55555555-5555-4555-8555-000000000001',
            cardNumber: 1,
            author: 'priya',
            body: 'Only on Safari',
            createdAt: new Date(now).toISOString(),
            editedAt: null,
          },
        ],
      }),
      card(2, { updatedAt: new Date(now - 3 * day).toISOString() }),
    ])
    const board = new Board({
      slug: 'b',
      http: createHttp({ baseUrl: 'https://api.test/v1', fetch: new FakeApi().fetch, retries: 0 }),
      offline: 'queue',
      realtime: false,
      token: () => 'yz_t',
      connectTimeoutMs: 1_000,
      cache,
      probe: async () => false,
    })
    await board.open()
    const numbers = (filter: Parameters<typeof board.cards.listLocal>[0]) =>
      board.cards.listLocal(filter, now).map((c) => c.number)
    expect(numbers({ search: 'safari' })).toEqual([1])
    expect(numbers({ stale: '2d' })).toEqual([2])
    expect(numbers({ stale: '4d' })).toEqual([])
    // Who "me" is is not known without the network: nothing is mine or watched.
    expect(numbers({ watching: true })).toEqual([])
    await board.close()
    cache.close()
  })
})

describe('helpers', () => {
  it('matchColumn: exact key, else a unique case-insensitive prefix', () => {
    expect(matchColumn(COLUMNS, 'Review')?.key).toBe('review')
    expect(matchColumn(COLUMNS, 'do')).toBeUndefined()
    expect(matchColumn(COLUMNS, 'doi')?.key).toBe('doing')
    expect(matchColumn(COLUMNS, 'nope')).toBeUndefined()
  })

  it('check refuses a checklist position the card does not have', async () => {
    const board = await connectHttpOnly(new FakeApi())
    await expect(board.cards.check(1, 3, true)).rejects.toBeInstanceOf(ValidationError)
  })

  it('the memory outbox collapses a re-queued idempotency key', () => {
    const outbox = createMemoryOutbox(() => 0)
    const op = { method: 'POST' as const, path: '/x', idempotencyKey: 'k' }
    const first = outbox.enqueue('b', op)
    expect(outbox.enqueue('b', op)).toBe(first)
    expect(outbox.size('b')).toBe(1)
    outbox.recordFailure(first.id, 'nope')
    expect(outbox.list('b')[0]).toMatchObject({ attempts: 1, lastError: 'nope' })
    expect(outbox.remove(first.id)).toBe(true)
    expect(outbox.remove(first.id)).toBe(false)
  })

  it('a throwing listener does not stop the others', () => {
    const emitter = new Emitter<{ ping: number }>()
    const seen: number[] = []
    emitter.on('ping', () => {
      throw new Error('broken')
    })
    const off = emitter.on('ping', (value) => seen.push(value))
    emitter.emit('ping', 1)
    off()
    emitter.emit('ping', 2)
    expect(seen).toEqual([1])
  })
})

describe('@yuzie/sdk/node', () => {
  it('refuses to connect when no token is passed or stored', async () => {
    await expect(
      NodeYuzie.connect('b', {
        baseUrl: 'https://api.test/v1',
        credentials: { env: {}, home: '/nonexistent-yuzie-home', keychain: false },
        fetch: new FakeApi().fetch,
      }),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('finds YUZIE_TOKEN itself and sends it', async () => {
    const api = new FakeApi()
    const board = await NodeYuzie.connect('b', {
      baseUrl: 'https://api.test/v1',
      credentials: { env: { YUZIE_TOKEN: 'yz_from_env' }, keychain: false },
      fetch: api.fetch,
      realtime: false,
    })
    expect(api.calls[0]?.init.headers.authorization).toBe('Bearer yz_from_env')
    await board.close()
  })
})

describe('client.health', () => {
  const healthy: FetchLike = async (url) => {
    expect(url).toBe('https://api.test/healthz')
    return reply(200, { status: 'ok', version: 'yuzie/v1' })
  }

  it('checks /healthz beside the versioned API and times the round trip', async () => {
    const client = createClient({ baseUrl: 'https://api.test/v1/', fetch: healthy })
    const health = await client.health()
    expect(health.version).toBe('yuzie/v1')
    expect(health.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('is OfflineError when nothing answers, and internal when something else does', async () => {
    const down = createClient({
      baseUrl: 'https://api.test/v1',
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    })
    await expect(down.health()).rejects.toBeInstanceOf(OfflineError)
    const wrong = createClient({ baseUrl: 'https://api.test/v1', fetch: async () => reply(502) })
    await expect(wrong.health()).rejects.toMatchObject({ code: 'internal', status: 502 })
  })
})
