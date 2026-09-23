import type { Card } from '@yuzie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createBoard,
  createCard,
  startTestServer,
  type TestBoard,
  type TestServer,
} from './__tests__/harness.js'

/**
 * SPEC.md §11.4 and §18 Session 3 acceptance:
 * "two PATCHes with the same version -> one 200, one 409 carrying current state."
 */
describe('optimistic concurrency', () => {
  let server: TestServer
  let board: TestBoard

  beforeAll(async () => {
    server = await startTestServer()
    board = await createBoard(server)
  })

  afterAll(async () => {
    await server?.close()
  })

  it('accepts a PATCH whose If-Match matches the current version', async () => {
    const card = await createCard(server, board, board.owner.token)

    const response = await call<Card>(server, {
      method: 'PATCH',
      url: `/v1/boards/${board.slug}/cards/${card.number}`,
      token: board.owner.token,
      body: { title: 'Fix OAuth callback' },
      headers: { 'if-match': String(card.version) },
    })

    expect(response.status).toBe(200)
    expect(response.body.title).toBe('Fix OAuth callback')
    expect(response.body.version).toBe(card.version + 1)
  })

  it('rejects the loser of two PATCHes at the same version with 409 and current state', async () => {
    const card = await createCard(server, board, board.owner.token, { title: 'Original' })

    const [first, second] = await Promise.all([
      call<Card>(server, {
        method: 'PATCH',
        url: `/v1/boards/${board.slug}/cards/${card.number}`,
        token: board.owner.token,
        body: { title: 'Winner' },
        headers: { 'if-match': String(card.version) },
      }),
      call<{ error: { code: string; details: { current: Card } } }>(server, {
        method: 'PATCH',
        url: `/v1/boards/${board.slug}/cards/${card.number}`,
        token: board.owner.token,
        body: { title: 'Loser' },
        headers: { 'if-match': String(card.version) },
      }),
    ])

    const statuses = [first.status, second.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 409])

    const conflicted = (first.status === 409 ? first : second) as unknown as {
      body: { error: { code: string; message: string; details: { current: Card } } }
    }
    expect(conflicted.body.error.code).toBe('version_conflict')

    // §11.4: "409 with the current card state" — so the client can replace its
    // optimistic state without another round trip.
    // "Current" means what the winner left behind, which is exactly what the
    // loser needs in order to replace its optimistic state (§11.4).
    const current = conflicted.body.error.details.current
    expect(current).toBeDefined()
    expect(current.number).toBe(card.number)
    expect(current.version).toBe(card.version + 1)
    expect(current.title).toBe('Winner')
    expect(conflicted.body.error.message).toContain('changed since you read it')
  })

  it('applies the winner and leaves the loser with no effect', async () => {
    const card = await createCard(server, board, board.owner.token, { title: 'Start' })

    await call(server, {
      method: 'PATCH',
      url: `/v1/boards/${board.slug}/cards/${card.number}`,
      token: board.owner.token,
      body: { title: 'Applied' },
      headers: { 'if-match': String(card.version) },
    })

    const stale = await call(server, {
      method: 'PATCH',
      url: `/v1/boards/${board.slug}/cards/${card.number}`,
      token: board.owner.token,
      body: { title: 'Ignored' },
      headers: { 'if-match': String(card.version) },
    })
    expect(stale.status).toBe(409)

    const read = await call<Card>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/cards/${card.number}`,
      token: board.owner.token,
    })
    expect(read.body.title).toBe('Applied')
  })

  it('treats a PATCH without If-Match as last-writer-wins', async () => {
    const card = await createCard(server, board, board.owner.token)
    const response = await call<Card>(server, {
      method: 'PATCH',
      url: `/v1/boards/${board.slug}/cards/${card.number}`,
      token: board.owner.token,
      body: { title: 'No precondition' },
    })
    expect(response.status).toBe(200)
  })

  it('rejects an If-Match that is not a version number', async () => {
    const card = await createCard(server, board, board.owner.token)
    const response = await call<{ error: { code: string } }>(server, {
      method: 'PATCH',
      url: `/v1/boards/${board.slug}/cards/${card.number}`,
      token: board.owner.token,
      body: { title: 'x' },
      headers: { 'if-match': 'banana' },
    })
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('validation_failed')
  })

  it('counts conflicts on the metrics registry', async () => {
    const metrics = await call<string>(server, { method: 'GET', url: '/metrics' })
    expect(String(metrics.body)).toMatch(/yuzie_conflicts_total \d+/)
  })
})
