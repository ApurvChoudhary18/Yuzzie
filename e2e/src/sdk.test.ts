/**
 * `@yuzie/sdk` against a real server (SPEC.md §18 Session 5 acceptance).
 *
 * Nothing about the network is mocked: "offline" is a TCP proxy that drops
 * every connection, so the SDK sees the same failure a closed laptop lid causes,
 * over both HTTP and the WebSocket.
 */
import { allCards, type Card } from '@yuzie/core'
import {
  type Board,
  ConflictError,
  type ConflictEvent,
  createClient,
  OfflineError,
  Yuzie,
} from '@yuzie/sdk'
import { openCache, type YuzieCache } from '@yuzie/store'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  createBoard,
  eventually,
  Link,
  signIn,
  startWorld,
  type User,
  type World,
} from './__support__/world.js'

let world: World
const open: Array<{ close(): Promise<void> | void }> = []

beforeAll(async () => {
  world = await startWorld()
})

afterEach(async () => {
  for (const resource of open.splice(0).reverse()) await resource.close()
})

afterAll(async () => {
  await world.close()
})

async function connect(
  slug: string,
  user: User,
  options: Parameters<typeof Yuzie.connect>[1] = {},
): Promise<Board> {
  const board = await Yuzie.connect(slug, {
    baseUrl: world.baseUrl,
    token: user.token,
    client: 'e2e/0.0.0',
    ...options,
  })
  open.push(board)
  return board
}

/** The server's cards, read by a separate client with no local state. */
async function serverCards(slug: string, user: User): Promise<Card[]> {
  const client = createClient({ baseUrl: world.baseUrl, token: user.token })
  const board = await client.connect(slug, { realtime: false })
  const cards = await board.cards.list()
  await board.close()
  return cards
}

/** What a board shows, reduced to the fields a user sees. */
function visible(cards: readonly Card[]) {
  return cards
    .map((card) => ({
      title: card.title,
      column: card.column,
      assignees: [...card.assignees].sort(),
      comments: card.comments.map((comment) => comment.body),
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
}

describe('Yuzie.connect', () => {
  it('opens a board with its columns, members and a live stream', async () => {
    const alice = await signIn(world.baseUrl)
    const slug = await createBoard(world.baseUrl, alice)
    const board = await connect(slug, alice)

    expect(board.status).toBe('live')
    expect(board.state.board?.slug).toBe(slug)
    expect(board.state.columns.map((column) => column.key)).toEqual([
      'todo',
      'doing',
      'review',
      'done',
    ])
    expect(board.state.members.map((member) => member.handle)).toEqual([alice.handle])
    await eventually(() => board.presence.some((p) => p.handle === alice.handle), 'own presence')
  })

  it('refuses a bad token with a typed error', async () => {
    const alice = await signIn(world.baseUrl)
    const slug = await createBoard(world.baseUrl, alice)
    await expect(connect(slug, { handle: 'x', token: 'yz_not-a-token' })).rejects.toMatchObject({
      code: 'unauthenticated',
    })
  })

  it('does the whole of §13.1, and a second client sees every write live', async () => {
    const alice = await signIn(world.baseUrl)
    const rahul = await signIn(world.baseUrl)
    const slug = await createBoard(world.baseUrl, alice, [rahul])
    const board = await connect(slug, alice)
    const watcher = await connect(slug, rahul)

    const moves: string[] = []
    watcher.on('card.moved', (event) => {
      moves.push(
        `${event.actor} moved #${event.cardNo}: ${event.payload.from} → ${event.payload.to}`,
      )
    })

    const created = await board.cards.create({
      title: 'Fix OAuth',
      assignee: rahul.handle,
      column: 'todo',
      labels: ['bug'],
    })
    expect(created).toMatchObject({ title: 'Fix OAuth', column: 'todo', assignees: [rahul.handle] })

    await board.cards.move(created.number, 'review')
    await board.cards.assign(created.number, [alice.handle])
    await board.cards.comment(created.number, 'OAuth callback is broken')
    await board.cards.addChecklistItem(created.number, 'Reproduce')
    await board.cards.check(created.number, 1, true)
    await board.cards.linkBranch(created.number, 'task/1-fix-oauth')
    await board.cards.updateGit(created.number, { commits: 3, filesChanged: 7 })
    await board.cards.setAnchor(created.number, { path: 'src/auth/callback.ts', line: 42 })
    await board.cards.attachCommits(created.number, [
      {
        sha: 'a'.repeat(40),
        message: 'fix: handle missing state param',
        author: 'alice',
        committedAt: '2026-08-19T09:00:00.000Z',
      },
    ])
    await board.cards.watch(created.number)
    await board.cards.update(created.number, { description: 'Callback 500s on missing state' })

    const final = await board.cards.get(created.number)
    expect(final).toMatchObject({
      column: 'review',
      assignees: [alice.handle, rahul.handle].sort(),
      git: { branch: 'task/1-fix-oauth', commits: 3, filesChanged: 7 },
    })
    expect(final.comments.map((comment) => comment.body)).toEqual(['OAuth callback is broken'])
    expect(final.checklist[0]?.doneAt).not.toBeNull()

    // The other client, folding nothing but events, converges on exactly the card
    // the server returns — every field, including versions and timestamps. If a
    // route stores something its events do not carry, this is where it shows.
    await eventually(
      () => JSON.stringify(watcher.state.cards[created.number]) === JSON.stringify(final),
      'the event-folded card to equal the server card',
    )
    expect(moves).toEqual([`${alice.handle} moved #${created.number}: todo → review`])
  })

  it('shows a write in board.state synchronously, before the server has answered', async () => {
    const alice = await signIn(world.baseUrl)
    const slug = await createBoard(world.baseUrl, alice)
    const board = await connect(slug, alice)
    const card = await board.cards.create({ title: 'Existing' })

    const moving = board.cards.move(card.number, 'done')
    // No await: the reducer has already applied the move locally.
    expect(board.state.cards[card.number]?.column).toBe('done')
    expect(board.unconfirmed).toBe(1)

    const creating = board.cards.create({ title: 'Brand new', column: 'doing' })
    const provisional = allCards(board.state).find((c) => c.title === 'Brand new')
    expect(provisional?.number).toBeLessThan(0)
    expect(provisional?.column).toBe('doing')

    await Promise.all([moving, creating])
    expect(board.unconfirmed).toBe(0)
    const real = allCards(board.state).find((c) => c.title === 'Brand new')
    expect(real?.number).toBeGreaterThan(0)
    expect(allCards(board.state).filter((c) => c.title === 'Brand new')).toHaveLength(1)
  })
})

describe('offline (acceptance)', () => {
  it('queues 5 writes while disconnected; sync() makes the server match, with no duplicates', async () => {
    const alice = await signIn(world.baseUrl)
    const rahul = await signIn(world.baseUrl)
    const slug = await createBoard(world.baseUrl, alice, [rahul])
    const link = await Link.open(world.baseUrl)
    open.push(link)
    const cache: YuzieCache = openCache({ boardSlug: slug, location: ':memory:', driver: 'json' })
    open.push(cache)

    const board = await Yuzie.connect(slug, {
      baseUrl: link.baseUrl,
      token: alice.token,
      offline: 'queue',
      cache,
    })
    open.push(board)
    const existing = await board.cards.create({ title: 'Existing card', column: 'todo' })

    link.cut()
    await eventually(() => board.status === 'reconnecting', 'the stream to notice')

    // Five writes of four kinds, all while the server is unreachable.
    const first = await board.cards.create({ title: 'Written offline 1', column: 'doing' })
    const second = await board.cards.create({ title: 'Written offline 2' })
    await board.cards.move(existing.number, 'review')
    await board.cards.assign(existing.number, [rahul.handle])
    await board.cards.comment(existing.number, 'Noted on a plane')

    // They resolved locally, are visible, and are queued durably in the cache.
    expect(first.number).toBeLessThan(0)
    expect(second.number).toBeLessThan(0)
    expect(board.queued).toBe(5)
    expect(cache.outbox.size(slug)).toBe(5)
    expect(board.state.cards[existing.number]).toMatchObject({
      column: 'review',
      assignees: [rahul.handle],
    })

    link.restore()
    const report = await board.sync()
    expect(report).toEqual({ sent: 5, conflicts: 0, rejected: 0, remaining: 0 })
    expect(cache.outbox.size(slug)).toBe(0)

    // The server now holds exactly what the client showed, and nothing twice.
    const onServer = await serverCards(slug, alice)
    expect(onServer.filter((c) => c.title === 'Written offline 1')).toHaveLength(1)
    expect(onServer.filter((c) => c.title === 'Written offline 2')).toHaveLength(1)
    expect(onServer).toHaveLength(3)
    expect(onServer.find((c) => c.number === existing.number)?.comments).toHaveLength(1)

    await eventually(() => board.unconfirmed === 0, 'optimistic writes to settle')
    await eventually(
      () => JSON.stringify(visible(allCards(board.state))) === JSON.stringify(visible(onServer)),
      'client state to equal the server',
    )
    expect(allCards(board.state).every((card) => card.number > 0)).toBe(true)
  })

  it('does not duplicate a queued write that reached the server before its response was lost', async () => {
    const alice = await signIn(world.baseUrl)
    const slug = await createBoard(world.baseUrl, alice)
    const link = await Link.open(world.baseUrl)
    open.push(link)
    const cache = openCache({ boardSlug: slug, location: ':memory:', driver: 'json' })
    open.push(cache)
    const board = await Yuzie.connect(slug, {
      baseUrl: link.baseUrl,
      token: alice.token,
      offline: 'queue',
      cache,
      realtime: false,
    })
    open.push(board)

    link.cut()
    await board.cards.create({ title: 'Exactly once' })
    const [entry] = cache.outbox.list(slug)
    if (entry === undefined) throw new Error('nothing was queued')
    link.restore()
    await board.sync()

    // The client crashed before it could forget the entry, so it is sent again
    // with the same idempotency key — as it would be after a restart.
    cache.outbox.enqueue(slug, entry.op)
    const again = await board.sync()
    expect(again.sent).toBe(1)

    const titles = (await serverCards(slug, alice)).map((card) => card.title)
    expect(titles).toEqual(['Exactly once'])
  })

  it('throws OfflineError instead of queueing when offline is "fail"', async () => {
    const alice = await signIn(world.baseUrl)
    const slug = await createBoard(world.baseUrl, alice)
    const link = await Link.open(world.baseUrl)
    open.push(link)
    const board = await Yuzie.connect(slug, {
      baseUrl: link.baseUrl,
      token: alice.token,
      realtime: false,
      retries: 0,
    })
    open.push(board)

    link.cut()
    const card = board.cards.create({ title: 'Never sent' })
    await expect(card).rejects.toBeInstanceOf(OfflineError)
    expect(board.unconfirmed).toBe(0)
    expect(allCards(board.state)).toHaveLength(0)
  })

  it('serves reads from the cache when opened without a network', async () => {
    const alice = await signIn(world.baseUrl)
    const slug = await createBoard(world.baseUrl, alice)
    const cache = openCache({ boardSlug: slug, location: ':memory:', driver: 'json' })
    open.push(cache)
    const online = await connect(slug, alice, { cache })
    await online.cards.create({ title: 'Cached', column: 'doing' })
    await eventually(() => cache.cards.count(slug) === 1, 'the cache to hold the card')
    await online.close()

    const link = await Link.open(world.baseUrl)
    open.push(link)
    link.cut()
    const offline = await Yuzie.connect(slug, {
      baseUrl: link.baseUrl,
      token: alice.token,
      offline: 'queue',
      cache,
      retries: 0,
      connectTimeoutMs: 200,
    })
    open.push(offline)

    // Readable synchronously, from the cache, with no server at all.
    expect(allCards(offline.state).map((card) => card.title)).toEqual(['Cached'])
    expect((await offline.cards.list({ column: 'doi' })).map((card) => card.title)).toEqual([
      'Cached',
    ])
  })
})

describe('conflicts (acceptance)', () => {
  it('rolls back an optimistic edit on 409 and emits a conflict event', async () => {
    const alice = await signIn(world.baseUrl)
    const bob = await signIn(world.baseUrl)
    const slug = await createBoard(world.baseUrl, alice, [bob])

    const aliceBoard = await connect(slug, alice)
    const card = await aliceBoard.cards.create({ title: 'Original' })
    // Bob does not stream, so he keeps his stale copy and his edit races Alice's.
    const bobBoard = await connect(slug, bob, { realtime: false })
    await bobBoard.cards.get(card.number)

    await aliceBoard.cards.update(card.number, { title: "Alice's title" })

    const conflicts: ConflictEvent[] = []
    bobBoard.on('conflict', (conflict) => conflicts.push(conflict))

    const editing = bobBoard.cards.update(card.number, { title: "Bob's title" })
    expect(bobBoard.state.cards[card.number]?.title).toBe("Bob's title")
    await expect(editing).rejects.toBeInstanceOf(ConflictError)

    // Rolled back — not to Bob's old copy, but to the server's winning version.
    expect(bobBoard.state.cards[card.number]?.title).toBe("Alice's title")
    expect(bobBoard.unconfirmed).toBe(0)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ cardNo: card.number, current: { title: "Alice's title" } })
  })

  it('reports a queued edit that lost the race as a conflict at sync, and keeps going', async () => {
    const alice = await signIn(world.baseUrl)
    const bob = await signIn(world.baseUrl)
    const slug = await createBoard(world.baseUrl, alice, [bob])
    const link = await Link.open(world.baseUrl)
    open.push(link)

    const aliceBoard = await connect(slug, alice)
    const card = await aliceBoard.cards.create({ title: 'Shared' })
    const other = await aliceBoard.cards.create({ title: 'Untouched' })

    const bobBoard = await Yuzie.connect(slug, {
      baseUrl: link.baseUrl,
      token: bob.token,
      offline: 'queue',
      realtime: false,
    })
    open.push(bobBoard)
    await bobBoard.cards.get(card.number)

    link.cut()
    await bobBoard.cards.update(card.number, { title: 'Bob, offline' })
    await bobBoard.cards.move(other.number, 'doing')
    await aliceBoard.cards.update(card.number, { title: 'Alice, online' })

    const conflicts: ConflictEvent[] = []
    bobBoard.on('conflict', (conflict) => conflicts.push(conflict))
    link.restore()
    const report = await bobBoard.sync()

    expect(report).toEqual({ sent: 1, conflicts: 1, rejected: 0, remaining: 0 })
    expect(conflicts.map((c) => c.cardNo)).toEqual([card.number])
    expect(bobBoard.state.cards[card.number]?.title).toBe('Alice, online')
    // The write queued after the conflict still went through.
    expect((await serverCards(slug, alice)).find((c) => c.number === other.number)?.column).toBe(
      'doing',
    )
  })
})

describe('realtime resilience', () => {
  it('catches up on everything it missed while the link was down', async () => {
    const alice = await signIn(world.baseUrl)
    const bob = await signIn(world.baseUrl)
    const slug = await createBoard(world.baseUrl, alice, [bob])
    const link = await Link.open(world.baseUrl)
    open.push(link)

    const bobBoard = await Yuzie.connect(slug, { baseUrl: link.baseUrl, token: bob.token })
    open.push(bobBoard)
    const aliceBoard = await connect(slug, alice)

    link.cut()
    await eventually(() => bobBoard.status === 'reconnecting', 'bob to lose the stream')
    for (const index of [1, 2, 3, 4, 5])
      await aliceBoard.cards.create({ title: `While away ${index}` })

    link.restore()
    await eventually(() => bobBoard.status === 'live', 'bob to reconnect', 20_000)
    await eventually(() => allCards(bobBoard.state).length === 5, 'bob to catch up')
    expect(bobBoard.state.seq).toBe(aliceBoard.state.seq)
    expect(visible(allCards(bobBoard.state))).toEqual(visible(allCards(aliceBoard.state)))
  })
})
