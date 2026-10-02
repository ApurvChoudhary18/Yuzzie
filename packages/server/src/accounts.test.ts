import { eq } from 'drizzle-orm'
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
import { cards, comments, events, memberships, users } from './db/schema.js'
import { ACCOUNT_PURGE_AFTER_MS, purgeDeletedAccounts } from './services/accounts.js'

describe('deleting an account (§14.3)', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startTestServer()
  })

  afterAll(async () => {
    await server?.close()
  })

  const remove = (token: string, handle: string) =>
    call<{ handle: string; purgeBy: string; error?: { code: string; message: string } }>(server, {
      method: 'DELETE',
      url: '/v1/me',
      token,
      body: { handle },
    })

  it('needs the handle typed again', async () => {
    const user = await createUser(server)
    const response = await remove(user.token, 'someone-else')
    expect(response.status).toBe(400)
    expect(response.body.error?.message).toContain(`@${user.handle}`)
  })

  it('refuses while the account is the only owner of a live board', async () => {
    const owner = await createUser(server)
    const board = await createBoard(server, owner)
    const response = await remove(owner.token, owner.handle)
    expect(response.status).toBe(400)
    expect(response.body.error?.message).toContain(board.slug)

    // With a second owner, it goes ahead.
    const second = await createUser(server)
    await addMember(server, board, second, 'owner')
    expect((await remove(owner.token, `@${owner.handle}`)).status).toBe(200)
  })

  it('stops the account at once, and removes every row that is theirs after 30 days', async () => {
    const owner = await createUser(server)
    const board = await createBoard(server, owner)
    const leaving = await createUser(server)
    await addMember(server, board, leaving, 'member')
    const card = await createCard(server, board, leaving.token, { assignees: [leaving.handle] })
    await call(server, {
      method: 'POST',
      url: `/v1/boards/${board.slug}/cards/${card.number}/comments`,
      token: leaving.token,
      body: { body: 'On it' },
    })

    const response = await remove(leaving.token, leaving.handle)
    expect(response.status).toBe(200)
    const purgeBy = Date.parse(response.body.purgeBy)
    expect(purgeBy - Date.now()).toBeGreaterThan(ACCOUNT_PURGE_AFTER_MS - 60_000)

    // At once: no token works, and the handle cannot sign in again.
    const me = await call(server, { method: 'GET', url: '/v1/me', token: leaving.token })
    expect(me.status).toBe(401)

    // Not yet due: nothing is purged.
    expect(await purgeDeletedAccounts(server.handle.db)).not.toContain(leaving.handle)

    // Thirty days on: the user and everything of theirs is gone; the card stays.
    const later = new Date(Date.now() + ACCOUNT_PURGE_AFTER_MS + 1_000)
    expect(await purgeDeletedAccounts(server.handle.db, later)).toContain(leaving.handle)
    const db = server.handle.db
    expect(await db.select().from(users).where(eq(users.id, leaving.id))).toHaveLength(0)
    expect(
      await db.select().from(memberships).where(eq(memberships.userId, leaving.id)),
    ).toHaveLength(0)
    expect(await db.select().from(comments).where(eq(comments.authorId, leaving.id))).toHaveLength(
      0,
    )
    expect(await db.select().from(events).where(eq(events.actorId, leaving.id))).toHaveLength(0)
    const [kept] = await db.select().from(cards).where(eq(cards.boardId, board.id))
    expect(kept?.createdBy).toBeNull()

    const view = await call<{ assignees: string[]; comments: unknown[] }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/cards/${card.number}`,
      token: owner.token,
    })
    expect(view.status).toBe(200)
    expect(view.body.assignees).toEqual([])
    expect(view.body.comments).toEqual([])
  })

  it('a deleted handle cannot be approved for a new login', async () => {
    const user = await createUser(server)
    expect((await remove(user.token, user.handle)).status).toBe(200)
    const started = await call<{ userCode: string }>(server, {
      method: 'POST',
      url: '/v1/auth/device',
    })
    const approved = await call<{ error: { message: string } }>(server, {
      method: 'POST',
      url: '/v1/auth/device/approve',
      body: { userCode: started.body.userCode, handle: user.handle },
    })
    expect(approved.status).toBe(403)
    expect(approved.body.error.message).toContain('was deleted')
  })
})
