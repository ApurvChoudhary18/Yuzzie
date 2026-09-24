/**
 * The event log is the source of truth for every client (SPEC.md §11.4, §12.3).
 *
 * A client that folds `GET /events` through `@yuzie/core`'s reducer must end up
 * with exactly the cards `GET /cards` returns — every field, including versions
 * and timestamps. If a route stores something its events do not carry, or
 * stamps a row with a different clock reading than its event, clients drift from
 * the server one millisecond or one version at a time. This test exercises every
 * card mutation and demands equality.
 */
import { applyEvents, type Card, type EventEnvelope, initialState } from '@yuzie/core'
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

describe('folding the event log', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startTestServer()
  })

  afterAll(async () => {
    await server.close()
  })

  it('reproduces GET /cards exactly, after every kind of card mutation', async () => {
    const board = await createBoard(server)
    const rahul = await createUser(server)
    await addMember(server, board, rahul, 'member')
    const owner = board.owner.token
    const base = `/v1/boards/${board.slug}/cards`

    const one = await createCard(server, board, owner, { title: 'First', labels: ['bug'] })
    const two = await createCard(server, board, owner, { title: 'Second', column: 'doing' })
    const three = await createCard(server, board, owner, { title: 'Doomed' })

    const writes: Array<{
      method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'
      url: string
      body?: unknown
    }> = [
      {
        method: 'PATCH',
        url: `${base}/${one.number}`,
        body: { title: 'First, renamed', priority: 1 },
      },
      { method: 'POST', url: `${base}/${one.number}/move`, body: { column: 'review' } },
      {
        method: 'POST',
        url: `${base}/${two.number}/move`,
        body: { column: 'review', beforeCard: one.number },
      },
      {
        method: 'POST',
        url: `${base}/${one.number}/assign`,
        body: { add: [rahul.handle, board.owner.handle] },
      },
      {
        method: 'POST',
        url: `${base}/${one.number}/assign`,
        body: { remove: [board.owner.handle] },
      },
      { method: 'POST', url: `${base}/${one.number}/comments`, body: { body: 'Looks wrong' } },
      { method: 'POST', url: `${base}/${one.number}/checklist`, body: { text: 'Reproduce' } },
      {
        method: 'PUT',
        url: `${base}/${one.number}/git`,
        body: { branch: 'task/1-first', baseBranch: 'main' },
      },
      {
        method: 'PUT',
        url: `${base}/${one.number}/git`,
        body: { commits: 2, filesChanged: 3, prState: 'open' },
      },
      { method: 'PUT', url: `${base}/${one.number}/git`, body: { branch: 'task/1-first-v2' } },
      {
        method: 'POST',
        url: `${base}/${one.number}/commits`,
        body: {
          commits: [
            {
              sha: 'b'.repeat(40),
              message: 'fix: it',
              author: null,
              committedAt: '2026-08-19T09:00:00.000Z',
            },
          ],
        },
      },
      {
        method: 'PUT',
        url: `${base}/${one.number}/anchor`,
        body: { path: 'src/a.ts', line: 3, endLine: 9 },
      },
      { method: 'POST', url: `${base}/${one.number}/watch`, body: { watching: true } },
      { method: 'DELETE', url: `${base}/${three.number}` },
    ]
    for (const write of writes) {
      const response = await call(server, { ...write, token: owner })
      expect(response.status, `${write.method} ${write.url}`).toBeLessThan(300)
    }

    // Tick the checklist item, which needs its id.
    const card = await call<Card>(server, {
      method: 'GET',
      url: `${base}/${one.number}`,
      token: owner,
    })
    const item = card.body.checklist[0]
    await call(server, {
      method: 'PATCH',
      url: `${base}/${one.number}/checklist/${item?.id}`,
      token: owner,
      body: { done: true },
    })

    const log = await call<{ events: EventEnvelope[] }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/events?since=0`,
      token: owner,
    })
    const folded = applyEvents(initialState(), log.body.events)

    const truth = await call<{ cards: Card[] }>(server, { method: 'GET', url: base, token: owner })
    const byNumber = (cards: readonly Card[]) =>
      Object.fromEntries([...cards].sort((a, b) => a.number - b.number).map((c) => [c.number, c]))

    expect(byNumber(Object.values(folded.cards))).toEqual(byNumber(truth.body.cards))
    // And it is not vacuous: the fold really did see every kind of event.
    expect(new Set(log.body.events.map((event) => event.type))).toEqual(
      new Set([
        'card.created',
        'card.updated',
        'card.moved',
        'card.assigned',
        'comment.created',
        'card.branch.linked',
        'card.git.updated',
        'card.commits.attached',
        'card.anchor.set',
        'checklist.updated',
        'card.deleted',
      ]),
    )
  })

  it('stamps every card event with the version the card ended on, and replays it', async () => {
    const board = await createBoard(server)
    const card = await createCard(server, board, board.owner.token)
    await call(server, {
      method: 'POST',
      url: `/v1/boards/${board.slug}/cards/${card.number}/move`,
      token: board.owner.token,
      body: { column: 'done' },
    })
    const log = await call<{ events: EventEnvelope[] }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/events?since=0`,
      token: board.owner.token,
    })
    expect(log.body.events.map((event) => [event.type, event.version])).toEqual([
      ['card.created', 1],
      ['card.moved', 2],
    ])
  })

  it('does not bump the version when someone merely watches a card', async () => {
    const board = await createBoard(server)
    const card = await createCard(server, board, board.owner.token)
    await call(server, {
      method: 'POST',
      url: `/v1/boards/${board.slug}/cards/${card.number}/watch`,
      token: board.owner.token,
      body: { watching: true },
    })
    const after = await call<Card>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/cards/${card.number}`,
      token: board.owner.token,
    })
    expect(after.body.version).toBe(card.version)
    expect(after.body.watchers).toEqual([board.owner.handle])
  })
})
