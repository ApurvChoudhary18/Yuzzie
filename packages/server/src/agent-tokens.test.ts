/**
 * Agent tokens (SPEC.md §18 Session 15): issued by a board owner, acting as
 * the agent, never beyond their role, and never off their board — asserted
 * per §14.2 cell over HTTP, with tokens made through the real route.
 */
import { ApiTokenSchema, type Member, TokenCreateResponseSchema } from '@yuzie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
  unique,
} from './__tests__/harness.js'

let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
})

afterAll(async () => {
  await server?.close()
})

async function issue(
  board: TestBoard,
  body: Record<string, unknown>,
  token = board.owner.token,
): Promise<{ status: number; token: string; body: Record<string, unknown> }> {
  const response = await call<Record<string, unknown>>(server, {
    method: 'POST',
    url: '/v1/tokens',
    token,
    body: { name: 'agent', role: 'member', boardSlug: board.slug, ...body },
  })
  const parsed = TokenCreateResponseSchema.safeParse(response.body)
  return {
    status: response.status,
    token: parsed.success ? parsed.data.token : '',
    body: response.body,
  }
}

describe('issuing an agent token', () => {
  let board: TestBoard
  let handle: string

  beforeAll(async () => {
    board = await createBoard(server)
    handle = unique('claude')
  })

  it('creates the agent, adds it to the board, and shows the plaintext once', async () => {
    const issued = await issue(board, { agent: handle })
    expect(issued.status).toBe(201)
    expect(issued.token).toMatch(/^yz_/)
    expect(issued.body.apiToken).toMatchObject({
      agent: handle,
      role: 'member',
      allowDestructive: false,
    })

    const members = await call<{ members: Member[] }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/members`,
      token: board.owner.token,
    })
    expect(members.body.members.find((m) => m.handle === handle)).toMatchObject({
      kind: 'agent',
      role: 'member',
    })

    // The listing never carries the plaintext again, but does say who it is for.
    const listed = await call<{ tokens: unknown[] }>(server, {
      method: 'GET',
      url: '/v1/tokens',
      token: board.owner.token,
    })
    const tokens = listed.body.tokens.map((token) => ApiTokenSchema.parse(token))
    expect(tokens.find((token) => token.agent === handle)).toBeDefined()
    expect(JSON.stringify(listed.body)).not.toContain(issued.token)
  })

  it('attributes what the agent does to the agent', async () => {
    const issued = await issue(board, { agent: handle, name: 'second' })
    const card = await createCard(server, board, issued.token, { title: 'By the agent' })
    const log = await call<{ events: Array<{ actor: string; type: string }> }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/activity?card=${card.number}`,
      token: board.owner.token,
    })
    expect(log.body.events[0]).toMatchObject({ type: 'card.created', actor: handle })
  })

  it('only an owner may issue one; never as owner; never to a person', async () => {
    const member = await createUser(server)
    await addMember(server, board, member, 'member')
    expect((await issue(board, { agent: unique('bot') }, member.token)).status).toBe(403)
    expect((await issue(board, { agent: unique('bot'), role: 'owner' })).status).toBe(400)
    expect((await issue(board, { agent: member.handle })).status).toBe(400)
    expect((await issue(board, { agent: unique('bot'), boardSlug: undefined })).status).toBe(400)
  })

  it('the person who issued it can revoke it, and then it stops working', async () => {
    const issued = await issue(board, { agent: handle, name: 'short-lived' })
    const id = (issued.body.apiToken as { id: string }).id
    const revoked = await call(server, {
      method: 'DELETE',
      url: `/v1/tokens/${id}`,
      token: board.owner.token,
    })
    expect(revoked.status).toBe(200)
    const after = await call(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}`,
      token: issued.token,
    })
    expect(after.status).toBe(401)
  })
})

describe('an agent token per §14.2 cell', () => {
  let board: TestBoard
  let other: TestBoard
  let agent: string
  let viewerAgent: string
  let destructive: string
  let owner: TestUser

  beforeAll(async () => {
    board = await createBoard(server)
    owner = board.owner
    other = await createBoard(server, owner)
    const handle = unique('claude')
    agent = (await issue(board, { agent: handle })).token
    viewerAgent = (await issue(board, { agent: unique('reader'), role: 'viewer' })).token
    destructive = (await issue(board, { agent: handle, allowDestructive: true, name: 'rm' })).token
  })

  const on = (slug: string, token: string) => ({
    get: (path: string) => call(server, { method: 'GET', url: `/v1/boards/${slug}${path}`, token }),
    post: (path: string, body: unknown) =>
      call(server, { method: 'POST', url: `/v1/boards/${slug}${path}`, token, body }),
    del: (path: string) =>
      call(server, { method: 'DELETE', url: `/v1/boards/${slug}${path}`, token }),
  })

  it('member cells: read, write, move, comment, assign, check', async () => {
    const as = on(board.slug, agent)
    expect((await as.get('/cards')).status).toBe(200)
    const created = await as.post('/cards', { title: 'agent work' })
    expect(created.status).toBe(201)
    const number = (created.body as { number: number }).number
    expect((await as.post(`/cards/${number}/move`, { column: 'doing' })).status).toBe(200)
    expect((await as.post(`/cards/${number}/comments`, { body: 'Starting.' })).status).toBe(201)
    expect((await as.post(`/cards/${number}/assign`, { add: [owner.handle] })).status).toBe(200)
    expect((await as.post(`/cards/${number}/checklist`, { text: 'step 1' })).status).toBe(201)
  })

  it('owner-only cells are refused', async () => {
    const as = on(board.slug, agent)
    expect((await as.post('/columns', { name: 'Agents' })).status).toBe(403)
    expect((await as.post('/invites', { handle: unique('x'), role: 'member' })).status).toBe(403)
    expect(
      (
        await call(server, {
          method: 'PATCH',
          url: `/v1/boards/${board.slug}`,
          token: agent,
          body: { name: 'renamed' },
        })
      ).status,
    ).toBe(403)
    expect((await as.del('')).status).toBe(403)
    // Nor can an agent issue tokens to other agents.
    expect((await issue(board, { agent: unique('bot') }, agent)).status).toBe(403)
  })

  it('deleting needs a token issued with allowDestructive', async () => {
    const card = await createCard(server, board, agent, { title: 'to go' })
    const refused = await on(board.slug, agent).del(`/cards/${card.number}`)
    expect(refused.status).toBe(403)
    expect((refused.body as { error: { message: string } }).error.message).toContain(
      '--allow-destructive',
    )
    expect((await on(board.slug, destructive).del(`/cards/${card.number}`)).status).toBe(200)
  })

  it('a viewer agent reads and comments, and writes nothing else', async () => {
    const as = on(board.slug, viewerAgent)
    const card = await createCard(server, board, owner.token)
    expect((await as.get(`/cards/${card.number}`)).status).toBe(200)
    expect((await as.post(`/cards/${card.number}/comments`, { body: 'seen' })).status).toBe(201)
    expect((await as.post('/cards', { title: 'nope' })).status).toBe(403)
    expect((await as.post(`/cards/${card.number}/move`, { column: 'doing' })).status).toBe(403)
    expect((await as.post(`/cards/${card.number}/assign`, { add: [owner.handle] })).status).toBe(
      403,
    )
  })

  it('never reaches another board, even one its issuer owns', async () => {
    const card = await createCard(server, other, owner.token)
    const as = on(other.slug, agent)
    for (const response of [
      await as.get(''),
      await as.get('/cards'),
      await as.post('/cards', { title: 'elsewhere' }),
      await as.post(`/cards/${card.number}/comments`, { body: 'elsewhere' }),
      await as.post(`/cards/${card.number}/move`, { column: 'doing' }),
    ])
      expect(response.status).toBe(403)
  })
})

describe('last used (§18 Session 16)', () => {
  it('a token says when it was last used', async () => {
    const board = await createBoard(server)
    const issued = await issue(board, { agent: unique('bot'), name: 'used' })
    const listed = async () =>
      (
        await call<{ tokens: Array<{ name: string; lastUsedAt: string | null }> }>(server, {
          method: 'GET',
          url: '/v1/tokens',
          token: board.owner.token,
        })
      ).body.tokens.find((token) => token.name === 'used')
    expect((await listed())?.lastUsedAt).toBeNull()
    await call(server, { method: 'GET', url: `/v1/boards/${board.slug}`, token: issued.token })
    const used = (await listed())?.lastUsedAt
    expect(used).not.toBeNull()
    expect(Date.now() - Date.parse(used as string)).toBeLessThan(60_000)
  })
})
