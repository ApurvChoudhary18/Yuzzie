import type { Role, UserKind } from '@yuzie/core'
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
} from './__tests__/harness.js'
import { ACTIONS, can } from './auth/permissions.js'

/**
 * SPEC.md §14.2, asserted cell by cell — first as pure logic, then over HTTP so
 * a route that forgets to call `authorize` cannot pass.
 *
 * The agent column is "member role, minus destructive operations": §13.4 puts
 * the `--allow-destructive` gate in the MCP server, and a client-supplied flag
 * is no protection, so the API refuses agent card deletion outright.
 */

type Cell = boolean
interface MatrixRow {
  readonly action: string
  readonly owner: Cell
  readonly member: Cell
  readonly viewer: Cell
  readonly agent: Cell
}

const MATRIX: readonly MatrixRow[] = [
  { action: 'board.read', owner: true, member: true, viewer: true, agent: true },
  { action: 'card.write', owner: true, member: true, viewer: false, agent: true },
  { action: 'comment.create', owner: true, member: true, viewer: true, agent: true },
  { action: 'card.assign', owner: true, member: true, viewer: false, agent: true },
  { action: 'column.manage', owner: true, member: false, viewer: false, agent: false },
  { action: 'label.manage', owner: true, member: false, viewer: false, agent: false },
  { action: 'member.invite', owner: true, member: false, viewer: false, agent: false },
  { action: 'board.archive', owner: true, member: false, viewer: false, agent: false },
]

describe('the §14.2 matrix as pure logic', () => {
  for (const row of MATRIX) {
    it(`${row.action}`, () => {
      const action = row.action as Parameters<typeof can>[0]
      expect(can(action, { role: 'owner', kind: 'human' })).toBe(row.owner)
      expect(can(action, { role: 'member', kind: 'human' })).toBe(row.member)
      expect(can(action, { role: 'viewer', kind: 'human' })).toBe(row.viewer)
      expect(can(action, { role: 'member', kind: 'agent' })).toBe(row.agent)
    })
  }

  it('card.delete: owner any, member own only, viewer never, agent never', () => {
    expect(can('card.delete', { role: 'owner', kind: 'human', ownsCard: false })).toBe(true)
    expect(can('card.delete', { role: 'owner', kind: 'human', ownsCard: true })).toBe(true)

    expect(can('card.delete', { role: 'member', kind: 'human', ownsCard: true })).toBe(true)
    expect(can('card.delete', { role: 'member', kind: 'human', ownsCard: false })).toBe(false)
    expect(can('card.delete', { role: 'member', kind: 'human' })).toBe(false)

    expect(can('card.delete', { role: 'viewer', kind: 'human', ownsCard: true })).toBe(false)

    expect(can('card.delete', { role: 'member', kind: 'agent', ownsCard: true })).toBe(false)
    expect(can('card.delete', { role: 'owner', kind: 'agent', ownsCard: false })).toBe(true)
  })

  it('denies an action it has never heard of, rather than allowing it', () => {
    const unknown = 'card.teleport' as Parameters<typeof can>[0]
    for (const role of ['owner', 'member', 'viewer'] as Role[]) {
      for (const kind of ['human', 'agent'] as UserKind[]) {
        expect(can(unknown, { role, kind })).toBe(false)
      }
    }
  })

  it('has a rule for every action in the union', () => {
    for (const action of ACTIONS) {
      const results = (['owner', 'member', 'viewer'] as Role[]).map((role) =>
        can(action, { role, kind: 'human', ownsCard: true }),
      )
      // An action nobody can ever perform is a missing rule, not a policy.
      expect(results.some(Boolean)).toBe(true)
    }
  })
})

describe('the §14.2 matrix over HTTP', () => {
  let server: TestServer
  let board: TestBoard
  let owner: TestUser
  let member: TestUser
  let viewer: TestUser
  let agent: TestUser

  beforeAll(async () => {
    server = await startTestServer()
    board = await createBoard(server)
    owner = board.owner

    member = await createUser(server, { role: 'member' })
    viewer = await createUser(server, { role: 'viewer' })
    agent = await createUser(server, { kind: 'agent', role: 'member' })

    await addMember(server, board, member, 'member')
    await addMember(server, board, viewer, 'viewer')
    await addMember(server, board, agent, 'member')
  })

  afterAll(async () => {
    await server?.close()
  })

  const actors = () => [
    { name: 'owner', user: owner },
    { name: 'member', user: member },
    { name: 'viewer', user: viewer },
    { name: 'agent', user: agent },
  ]

  it('lets every member read the board and its cards', async () => {
    for (const { name, user } of actors()) {
      const detail = await call(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}`,
        token: user.token,
      })
      const cards = await call(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/cards`,
        token: user.token,
      })
      expect(detail.status, name).toBe(200)
      expect(cards.status, name).toBe(200)
    }
  })

  it('lets everyone but a viewer create and move cards', async () => {
    const expected: Record<string, number> = { owner: 201, member: 201, viewer: 403, agent: 201 }
    for (const { name, user } of actors()) {
      const response = await call(server, {
        method: 'POST',
        url: `/v1/boards/${board.slug}/cards`,
        token: user.token,
        body: { title: `Created by ${name}` },
      })
      expect(response.status, name).toBe(expected[name])
    }
  })

  it('lets everyone comment, including a viewer', async () => {
    const card = await createCard(server, board, owner.token)
    for (const { name, user } of actors()) {
      const response = await call(server, {
        method: 'POST',
        url: `/v1/boards/${board.slug}/cards/${card.number}/comments`,
        token: user.token,
        body: { body: `hello from ${name}` },
      })
      expect(response.status, name).toBe(201)
    }
  })

  it('lets everyone but a viewer assign others', async () => {
    const card = await createCard(server, board, owner.token)
    const expected: Record<string, number> = { owner: 200, member: 200, viewer: 403, agent: 200 }
    for (const { name, user } of actors()) {
      const response = await call(server, {
        method: 'POST',
        url: `/v1/boards/${board.slug}/cards/${card.number}/assign`,
        token: user.token,
        body: { add: [member.handle] },
      })
      expect(response.status, name).toBe(expected[name])
    }
  })

  it('lets a member delete only their own card', async () => {
    const own = await createCard(server, board, member.token, { title: "member's own" })
    const removedOwn = await call(server, {
      method: 'DELETE',
      url: `/v1/boards/${board.slug}/cards/${own.number}`,
      token: member.token,
    })
    expect(removedOwn.status).toBe(200)

    const someoneElses = await createCard(server, board, owner.token, { title: "owner's" })
    const refused = await call<{ error: { code: string } }>(server, {
      method: 'DELETE',
      url: `/v1/boards/${board.slug}/cards/${someoneElses.number}`,
      token: member.token,
    })
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('forbidden')
  })

  it('lets an owner delete any card', async () => {
    const card = await createCard(server, board, member.token, { title: 'anyone can be deleted' })
    const response = await call(server, {
      method: 'DELETE',
      url: `/v1/boards/${board.slug}/cards/${card.number}`,
      token: owner.token,
    })
    expect(response.status).toBe(200)
  })

  it('refuses card deletion by a viewer and by an agent', async () => {
    for (const { name, user } of [
      { name: 'viewer', user: viewer },
      { name: 'agent', user: agent },
    ]) {
      const card = await createCard(server, board, owner.token)
      const response = await call<{ error: { message: string } }>(server, {
        method: 'DELETE',
        url: `/v1/boards/${board.slug}/cards/${card.number}`,
        token: user.token,
      })
      expect(response.status, name).toBe(403)
    }
  })

  it('tells an agent where the destructive capability actually lives', async () => {
    const card = await createCard(server, board, agent.token, { title: "agent's own card" })
    const response = await call<{ error: { message: string } }>(server, {
      method: 'DELETE',
      url: `/v1/boards/${board.slug}/cards/${card.number}`,
      token: agent.token,
    })
    expect(response.status).toBe(403)
    expect(response.body.error.message).toContain('--allow-destructive')
  })

  it('reserves column management for the owner', async () => {
    const expected: Record<string, number> = { owner: 201, member: 403, viewer: 403, agent: 403 }
    for (const { name, user } of actors()) {
      const response = await call(server, {
        method: 'POST',
        url: `/v1/boards/${board.slug}/columns`,
        token: user.token,
        body: { name: `Column by ${name}` },
      })
      expect(response.status, name).toBe(expected[name])
    }
  })

  it('reserves invites and role changes for the owner', async () => {
    const expected: Record<string, number> = { owner: 201, member: 403, viewer: 403, agent: 403 }
    for (const { name, user } of actors()) {
      const response = await call(server, {
        method: 'POST',
        url: `/v1/boards/${board.slug}/invites`,
        token: user.token,
        body: { handle: `invitee-by-${name}`, role: 'member' },
      })
      expect(response.status, name).toBe(expected[name])
    }
  })

  it('reserves board settings and archival for the owner', async () => {
    for (const { name, user } of actors().filter((actor) => actor.name !== 'owner')) {
      const patched = await call(server, {
        method: 'PATCH',
        url: `/v1/boards/${board.slug}`,
        token: user.token,
        body: { name: 'Renamed' },
      })
      const archived = await call(server, {
        method: 'DELETE',
        url: `/v1/boards/${board.slug}`,
        token: user.token,
      })
      expect(patched.status, name).toBe(403)
      expect(archived.status, name).toBe(403)
    }

    const ownerArchive = await call(server, {
      method: 'DELETE',
      url: `/v1/boards/${board.slug}`,
      token: owner.token,
    })
    expect(ownerArchive.status).toBe(200)
  })
})

describe('board scoping and membership', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startTestServer()
  })

  afterAll(async () => {
    await server?.close()
  })

  it('hides a board the caller is not a member of behind 404, not 403', async () => {
    const board = await createBoard(server)
    const stranger = await createUser(server)

    const response = await call<{ error: { code: string } }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}`,
      token: stranger.token,
    })

    // §14.1: membership must not be probeable by watching status codes.
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('board_not_found')
  })

  it('refuses a board-scoped token on any other board', async () => {
    const mine = await createBoard(server)
    const other = await createBoard(server)
    await addMember(server, other, mine.owner, 'owner')

    const scoped = await createUser(server, { role: 'owner', boardId: mine.id })
    await addMember(server, mine, scoped, 'owner')
    await addMember(server, other, scoped, 'owner')

    const allowed = await call(server, {
      method: 'GET',
      url: `/v1/boards/${mine.slug}`,
      token: scoped.token,
    })
    const refused = await call<{ error: { code: string } }>(server, {
      method: 'GET',
      url: `/v1/boards/${other.slug}`,
      token: scoped.token,
    })

    expect(allowed.status).toBe(200)
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('forbidden')
  })

  it('never lets a token widen the role its membership grants', async () => {
    const board = await createBoard(server)
    const user = await createUser(server, { role: 'owner' })
    await addMember(server, board, user, 'viewer')

    // The token says owner; the membership says viewer. The narrower wins.
    const response = await call(server, {
      method: 'POST',
      url: `/v1/boards/${board.slug}/cards`,
      token: user.token,
      body: { title: 'should be refused' },
    })
    expect(response.status).toBe(403)
  })

  it('rejects a request with no credentials with exit-code-3 semantics', async () => {
    const board = await createBoard(server)
    const response = await call<{ error: { code: string; message: string } }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}`,
    })
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('unauthenticated')
    expect(response.body.error.message).toContain('yuzie login')
  })
})
