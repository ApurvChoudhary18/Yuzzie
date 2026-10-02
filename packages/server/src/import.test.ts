import type { Card } from '@yuzie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMember,
  call,
  createBoard,
  createUser,
  startTestServer,
  type TestBoard,
  type TestServer,
} from './__tests__/harness.js'

describe('POST /boards/:slug/cards/import (yuzie import, §7.2)', () => {
  let server: TestServer
  let board: TestBoard

  beforeAll(async () => {
    server = await startTestServer()
    board = await createBoard(server)
  })

  afterAll(async () => {
    await server?.close()
  })

  const importCards = (cards: unknown[], token = board.owner.token, slug = board.slug) =>
    call<{ cards: Card[]; count: number; error?: { code: string; message: string } }>(server, {
      method: 'POST',
      url: `/v1/boards/${slug}/cards/import`,
      token,
      body: { cards },
    })

  it('creates every card, in order, with columns, labels, people and checklists', async () => {
    const response = await importCards([
      { title: 'Rate limits', column: 'todo', labels: ['api'], priority: 1 },
      {
        title: 'Fix GitHub OAuth',
        column: 'doi',
        assignees: [board.owner.handle],
        checklist: [{ text: 'Reproduce', done: true }, { text: 'Fix' }],
      },
    ])
    expect(response.status).toBe(201)
    expect(response.body.count).toBe(2)
    const [first, second] = response.body.cards
    expect(first).toMatchObject({ title: 'Rate limits', column: 'todo', labels: ['api'] })
    expect(second).toMatchObject({ column: 'doing', assignees: [board.owner.handle] })
    expect(
      second?.checklist.map((item) => [item.position, item.text, item.doneAt !== null]),
    ).toEqual([
      [1, 'Reproduce', true],
      [2, 'Fix', false],
    ])
    expect((second?.number ?? 0) - (first?.number ?? 0)).toBe(1)

    // One event per card, on the board's log, like any other create.
    const events = await call<{ events: Array<{ type: string; cardNo: number }> }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/events`,
      token: board.owner.token,
    })
    const created = events.body.events.filter((event) => event.type === 'card.created')
    expect(created.map((event) => event.cardNo)).toEqual(
      expect.arrayContaining([first?.number, second?.number]),
    )
  })

  it('is all or nothing: one bad row and the board is unchanged', async () => {
    const before = await call<{ count: number }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/cards`,
      token: board.owner.token,
    })
    const response = await importCards([
      { title: 'Fine' },
      { title: 'Nobody', assignees: ['no-such-person-at-all'] },
    ])
    expect(response.status).toBe(400)
    expect(response.body.error?.message).toContain('@no-such-person-at-all')
    const after = await call<{ count: number }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/cards`,
      token: board.owner.token,
    })
    expect(after.body.count).toBe(before.body.count)
  })

  it('refuses viewers, empty files and oversized batches', async () => {
    const viewer = await createUser(server)
    await addMember(server, board, viewer, 'viewer')
    expect((await importCards([{ title: 'x' }], viewer.token)).status).toBe(403)
    expect((await importCards([])).status).toBe(400)
    const many = Array.from({ length: 501 }, (_, index) => ({ title: `Card ${index}` }))
    expect((await importCards(many)).status).toBe(400)
  })
})
