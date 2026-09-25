import type { Card } from '@yuzie/core'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createBoard,
  createCard,
  createUser,
  issueToken,
  startTestServer,
  type TestBoard,
  type TestServer,
  unique,
} from './__tests__/harness.js'
import { hashToken } from './auth/tokens.js'
import { apiTokens } from './db/schema.js'

describe('route behaviour at the edges', () => {
  let server: TestServer
  let board: TestBoard

  beforeAll(async () => {
    server = await startTestServer()
    board = await createBoard(server)
  })

  afterAll(async () => {
    await server?.close()
  })

  const post = (url: string, body: unknown, token = board.owner.token) =>
    call<Record<string, unknown>>(server, { method: 'POST', url, token, body })

  describe('column resolution (§7.2)', () => {
    it('matches a column case-insensitively by prefix', async () => {
      const response = await post(`/v1/boards/${board.slug}/cards`, {
        title: 'Prefix match',
        column: 'REV',
      })
      expect(response.status).toBe(201)
      expect((response.body as unknown as Card).column).toBe('review')
    })

    it('refuses an ambiguous prefix rather than guessing', async () => {
      const ambiguous = await createBoard(server, undefined, {
        columns: ['Doing', 'Done', 'Draft'],
      })
      const response = await call<{ error: { code: string; message: string } }>(server, {
        method: 'POST',
        url: `/v1/boards/${ambiguous.slug}/cards`,
        token: ambiguous.owner.token,
        body: { title: 'Ambiguous', column: 'do' },
      })
      expect(response.status).toBe(400)
      expect(response.body.error.message).toMatch(/doing, done/)
    })

    it('reports an unknown column with column_not_found', async () => {
      const response = await call<{ error: { code: string } }>(server, {
        method: 'POST',
        url: `/v1/boards/${board.slug}/cards`,
        token: board.owner.token,
        body: { title: 'Nowhere', column: 'shipped' },
      })
      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('column_not_found')
    })

    it('defaults to the first column when none is given', async () => {
      const response = await post(`/v1/boards/${board.slug}/cards`, { title: 'Default column' })
      expect((response.body as unknown as Card).column).toBe('todo')
    })
  })

  describe('WIP limits (§12.1 wip_limit_exceeded)', () => {
    it('refuses a card that would exceed a column limit', async () => {
      const limited = await createBoard(server)
      const column = await post(
        `/v1/boards/${limited.slug}/columns`,
        { name: 'Capped', wipLimit: 1 },
        limited.owner.token,
      )
      expect(column.status).toBe(201)

      const first = await post(
        `/v1/boards/${limited.slug}/cards`,
        { title: 'first', column: 'capped' },
        limited.owner.token,
      )
      expect(first.status).toBe(201)

      const second = await call<{ error: { code: string; message: string } }>(server, {
        method: 'POST',
        url: `/v1/boards/${limited.slug}/cards`,
        token: limited.owner.token,
        body: { title: 'second', column: 'capped' },
      })
      expect(second.status).toBe(422)
      expect(second.body.error.code).toBe('wip_limit_exceeded')
      expect(second.body.error.message).toContain('Move something out')
    })

    it('refuses a move into a full column but allows reordering within it', async () => {
      const limited = await createBoard(server)
      await post(
        `/v1/boards/${limited.slug}/columns`,
        { name: 'Capped', wipLimit: 1 },
        limited.owner.token,
      )
      const resident = await createCard(server, limited, limited.owner.token, {
        title: 'resident',
        column: 'capped',
      })
      const outsider = await createCard(server, limited, limited.owner.token, { title: 'outsider' })

      const blocked = await call<{ error: { code: string } }>(server, {
        method: 'POST',
        url: `/v1/boards/${limited.slug}/cards/${outsider.number}/move`,
        token: limited.owner.token,
        body: { column: 'capped' },
      })
      expect(blocked.status).toBe(422)

      // Moving a card within the column it already occupies must not count it twice.
      const reorder = await call(server, {
        method: 'POST',
        url: `/v1/boards/${limited.slug}/cards/${resident.number}/move`,
        token: limited.owner.token,
        body: { column: 'capped' },
      })
      expect(reorder.status).toBe(200)
    })
  })

  describe('placement', () => {
    it('honours beforeCard and afterCard', async () => {
      const ordered = await createBoard(server)
      const first = await createCard(server, ordered, ordered.owner.token, { title: 'A' })
      const last = await createCard(server, ordered, ordered.owner.token, { title: 'C' })

      const middle = await post(
        `/v1/boards/${ordered.slug}/cards`,
        { title: 'B', beforeCard: last.number },
        ordered.owner.token,
      )
      expect(middle.status).toBe(201)

      const listed = await call<{ cards: Card[] }>(server, {
        method: 'GET',
        url: `/v1/boards/${ordered.slug}/cards`,
        token: ordered.owner.token,
      })
      expect(listed.body.cards.map((card) => card.title)).toEqual(['A', 'B', 'C'])

      const moved = await call(server, {
        method: 'POST',
        url: `/v1/boards/${ordered.slug}/cards/${first.number}/move`,
        token: ordered.owner.token,
        body: { column: 'todo', afterCard: last.number },
      })
      expect(moved.status).toBe(200)

      const reordered = await call<{ cards: Card[] }>(server, {
        method: 'GET',
        url: `/v1/boards/${ordered.slug}/cards`,
        token: ordered.owner.token,
      })
      expect(reordered.body.cards.map((card) => card.title)).toEqual(['B', 'C', 'A'])
    })

    it('reports a placement anchor that does not exist', async () => {
      const response = await call<{ error: { code: string } }>(server, {
        method: 'POST',
        url: `/v1/boards/${board.slug}/cards`,
        token: board.owner.token,
        body: { title: 'floating', beforeCard: 9999 },
      })
      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('card_not_found')
    })
  })

  describe('card ids', () => {
    it('accepts #18 as well as 18 (§7.5)', async () => {
      const card = await createCard(server, board, board.owner.token)
      const withHash = await call(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/cards/%23${card.number}`,
        token: board.owner.token,
      })
      expect(withHash.status).toBe(200)
    })

    it('rejects something that is not a card number', async () => {
      const response = await call<{ error: { code: string } }>(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/cards/oauth`,
        token: board.owner.token,
      })
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('validation_failed')
    })

    it('reports a card that does not exist', async () => {
      const response = await call<{ error: { code: string } }>(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/cards/9999`,
        token: board.owner.token,
      })
      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('card_not_found')
    })
  })

  describe('partial updates', () => {
    it('clears nullable fields when asked to', async () => {
      const card = await createCard(server, board, board.owner.token, {
        description: 'something',
        priority: 2,
        dueAt: new Date().toISOString(),
      })

      const cleared = await call<Card>(server, {
        method: 'PATCH',
        url: `/v1/boards/${board.slug}/cards/${card.number}`,
        token: board.owner.token,
        body: { description: null, priority: null, dueAt: null },
      })
      expect(cleared.status).toBe(200)
      expect(cleared.body.description).toBeNull()
      expect(cleared.body.priority).toBeNull()
      expect(cleared.body.dueAt).toBeNull()
    })

    it('replaces labels rather than merging them', async () => {
      const card = await createCard(server, board, board.owner.token, { labels: ['bug', 'auth'] })
      const updated = await call<Card>(server, {
        method: 'PATCH',
        url: `/v1/boards/${board.slug}/cards/${card.number}`,
        token: board.owner.token,
        body: { labels: ['perf'] },
      })
      expect(updated.body.labels).toEqual(['perf'])
    })

    it('accepts a partial git summary', async () => {
      const card = await createCard(server, board, board.owner.token)
      const first = await call<{ commits: number; branch: string | null }>(server, {
        method: 'PUT',
        url: `/v1/boards/${board.slug}/cards/${card.number}/git`,
        token: board.owner.token,
        body: { commits: 2 },
      })
      expect(first.status).toBe(200)
      expect(first.body.commits).toBe(2)
      expect(first.body.branch).toBeNull()

      const second = await call<{ commits: number; branch: string | null }>(server, {
        method: 'PUT',
        url: `/v1/boards/${board.slug}/cards/${card.number}/git`,
        token: board.owner.token,
        body: { branch: 'task/1-thing' },
      })
      expect(second.body.branch).toBe('task/1-thing')
      expect(second.body.commits).toBe(2)
    })

    it('deduplicates attached commits', async () => {
      const card = await createCard(server, board, board.owner.token)
      const url = `/v1/boards/${board.slug}/cards/${card.number}/commits`
      const body = { commits: [{ sha: 'abc1234', message: 'x', author: null, committedAt: null }] }

      await call(server, { method: 'POST', url, token: board.owner.token, body })
      const again = await call<{ commits: unknown[] }>(server, {
        method: 'POST',
        url,
        token: board.owner.token,
        body,
      })
      expect(again.body.commits).toHaveLength(1)
    })

    it('replaces the primary anchor instead of accumulating anchors', async () => {
      const card = await createCard(server, board, board.owner.token)
      const url = `/v1/boards/${board.slug}/cards/${card.number}/anchor`

      await call(server, {
        method: 'PUT',
        url,
        token: board.owner.token,
        body: { path: 'src/a.ts', line: 1 },
      })
      await call(server, {
        method: 'PUT',
        url,
        token: board.owner.token,
        body: { path: 'src/b.ts', line: 2 },
      })

      const read = await call<Card>(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/cards/${card.number}`,
        token: board.owner.token,
      })
      expect(read.body.anchor?.path).toBe('src/b.ts')
    })

    it('unwatches', async () => {
      const card = await createCard(server, board, board.owner.token)
      const url = `/v1/boards/${board.slug}/cards/${card.number}/watch`
      await call(server, {
        method: 'POST',
        url,
        token: board.owner.token,
        body: { watching: true },
      })
      await call(server, {
        method: 'POST',
        url,
        token: board.owner.token,
        body: { watching: false },
      })

      const read = await call<Card>(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/cards/${card.number}`,
        token: board.owner.token,
      })
      expect(read.body.watchers).toEqual([])
    })

    it('edits checklist text and position without toggling it', async () => {
      const card = await createCard(server, board, board.owner.token)
      const added = await post(`/v1/boards/${board.slug}/cards/${card.number}/checklist`, {
        text: 'original',
      })
      const itemId = (added.body as { id: string }).id

      const edited = await call<{ text: string; position: number; doneAt: string | null }>(server, {
        method: 'PATCH',
        url: `/v1/boards/${board.slug}/cards/${card.number}/checklist/${itemId}`,
        token: board.owner.token,
        body: { text: 'edited', position: 3 },
      })
      expect(edited.body.text).toBe('edited')
      expect(edited.body.position).toBe(3)
      expect(edited.body.doneAt).toBeNull()
    })

    it('reports a checklist item that is not on the card', async () => {
      const card = await createCard(server, board, board.owner.token)
      const response = await call<{ error: { code: string } }>(server, {
        method: 'PATCH',
        url: `/v1/boards/${board.slug}/cards/${card.number}/checklist/11111111-1111-4111-8111-111111111111`,
        token: board.owner.token,
        body: { done: true },
      })
      expect(response.status).toBe(404)
    })

    it('refuses to assign a user who does not exist', async () => {
      const card = await createCard(server, board, board.owner.token)
      const response = await call<{ error: { message: string } }>(server, {
        method: 'POST',
        url: `/v1/boards/${board.slug}/cards/${card.number}/assign`,
        token: board.owner.token,
        body: { add: ['nobody-at-all'] },
      })
      expect(response.status).toBe(400)
      expect(response.body.error.message).toContain('@nobody-at-all')
    })
  })

  describe('columns', () => {
    it('creates with semantics and a wip limit, positioned after another column', async () => {
      const target = await createBoard(server)
      const response = await call<{ key: string; semantics: string; wipLimit: number }>(server, {
        method: 'POST',
        url: `/v1/boards/${target.slug}/columns`,
        token: target.owner.token,
        body: { name: 'Blocked', after: 'doing', semantics: 'in_progress', wipLimit: 3 },
      })
      expect(response.status).toBe(201)
      expect(response.body.semantics).toBe('in_progress')
      expect(response.body.wipLimit).toBe(3)

      const detail = await call<{ columns: { key: string }[] }>(server, {
        method: 'GET',
        url: `/v1/boards/${target.slug}`,
        token: target.owner.token,
      })
      expect(detail.body.columns.map((column) => column.key)).toEqual([
        'todo',
        'doing',
        'blocked',
        'review',
        'done',
      ])
    })

    it('refuses a duplicate key and an unknown anchor', async () => {
      const target = await createBoard(server)
      const duplicate = await call<{ error: { message: string } }>(server, {
        method: 'POST',
        url: `/v1/boards/${target.slug}/columns`,
        token: target.owner.token,
        body: { name: 'Todo' },
      })
      expect(duplicate.status).toBe(400)

      const misplaced = await call<{ error: { code: string } }>(server, {
        method: 'POST',
        url: `/v1/boards/${target.slug}/columns`,
        token: target.owner.token,
        body: { name: 'Later', after: 'nowhere' },
      })
      expect(misplaced.status).toBe(404)
      expect(misplaced.body.error.code).toBe('column_not_found')
    })

    it('only deletes an empty column', async () => {
      const target = await createBoard(server)
      await createCard(server, target, target.owner.token, { column: 'todo' })

      const occupied = await call<{ error: { message: string } }>(server, {
        method: 'DELETE',
        url: `/v1/boards/${target.slug}/columns/todo`,
        token: target.owner.token,
      })
      expect(occupied.status).toBe(400)
      expect(occupied.body.error.message).toContain('Move them out first')

      const empty = await call(server, {
        method: 'DELETE',
        url: `/v1/boards/${target.slug}/columns/done`,
        token: target.owner.token,
      })
      expect(empty.status).toBe(200)

      const missing = await call<{ error: { code: string } }>(server, {
        method: 'DELETE',
        url: `/v1/boards/${target.slug}/columns/done`,
        token: target.owner.token,
      })
      expect(missing.status).toBe(404)
    })
  })

  describe('boards', () => {
    it('refuses a duplicate board slug', async () => {
      const name = unique('dupe')
      await post('/v1/boards', { name })
      const again = await call<{ error: { message: string } }>(server, {
        method: 'POST',
        url: '/v1/boards',
        token: board.owner.token,
        body: { name },
      })
      expect(again.status).toBe(400)
      expect(again.body.error.message).toContain('already exists')
    })

    it('accepts custom columns', async () => {
      const custom = await createBoard(server, undefined, { columns: ['Icebox', 'Shipping'] })
      const detail = await call<{ columns: { key: string; semantics: string | null }[] }>(server, {
        method: 'GET',
        url: `/v1/boards/${custom.slug}`,
        token: custom.owner.token,
      })
      expect(detail.body.columns.map((column) => column.key)).toEqual(['icebox', 'shipping'])
      expect(detail.body.columns[0]?.semantics).toBeNull()
    })
  })

  describe('event replay', () => {
    it('rejects a negative cursor and clamps an oversized limit', async () => {
      const negative = await call<{ error: { code: string } }>(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/events?since=-1`,
        token: board.owner.token,
      })
      expect(negative.status).toBe(400)

      const clamped = await call<{ events: unknown[] }>(server, {
        method: 'GET',
        url: `/v1/boards/${board.slug}/events?since=0&limit=100000`,
        token: board.owner.token,
      })
      // §12.2 puts the snapshot threshold at 500 events.
      expect(clamped.body.events.length).toBeLessThanOrEqual(500)
    })
  })

  describe('tokens and credentials', () => {
    it('refuses to scope a token to a board the caller cannot see', async () => {
      const someoneElses = await createBoard(server)
      const response = await call<{ error: { code: string } }>(server, {
        method: 'POST',
        url: '/v1/tokens',
        token: board.owner.token,
        body: { name: 'sneaky', role: 'owner', boardSlug: someoneElses.slug },
      })
      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('board_not_found')
    })

    it('rejects an expired token', async () => {
      const user = await createUser(server)
      const token = await issueToken(server, user.id, 'owner')
      await server.handle.db
        .update(apiTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(apiTokens.tokenHash, hashToken(token)))

      const response = await call<{ error: { message: string } }>(server, {
        method: 'GET',
        url: '/v1/me',
        token,
      })
      expect(response.status).toBe(401)
      expect(response.body.error.message).toContain('expired')
    })

    it('rejects a malformed Authorization header', async () => {
      for (const header of ['', 'Basic abc', 'Bearer', 'bearer']) {
        const response = await call(server, {
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: header },
        })
        expect(response.status, header).toBe(401)
      }
    })

    it('rejects a token id that is not a uuid', async () => {
      const response = await call<{ error: { code: string } }>(server, {
        method: 'DELETE',
        url: '/v1/tokens/not-a-uuid',
        token: board.owner.token,
      })
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('validation_failed')
    })
  })

  describe('invite-only signup', () => {
    it('refuses an unknown handle when the server is invite-only', async () => {
      const closed = await startTestServer({ signupMode: 'invite' })
      try {
        const started = await call<{ userCode: string }>(closed, {
          method: 'POST',
          url: '/v1/auth/device',
        })
        const response = await call<{ error: { message: string } }>(closed, {
          method: 'POST',
          url: '/v1/auth/device/approve',
          body: { userCode: started.body.userCode, handle: 'a-total-stranger' },
        })
        expect(response.status).toBe(403)
        expect(response.body.error.message).toContain('invited users')
      } finally {
        await closed.close()
      }
    })

    it('rejects an unknown or expired user code', async () => {
      const unknown = await call(server, {
        method: 'POST',
        url: '/v1/auth/device/approve',
        body: { userCode: 'ZZZZ-ZZZZ', handle: 'someone' },
      })
      expect(unknown.status).toBe(404)
    })
  })
})

describe('column semantics for custom column lists', () => {
  it('recognises the standard names in a custom list, so "Done" still means done', async () => {
    const server = await startTestServer()
    try {
      const owner = await createUser(server)
      const created = await call<{ slug: string }>(server, {
        method: 'POST',
        url: '/v1/boards',
        token: owner.token,
        body: { name: unique('custom'), columns: ['Todo', 'Doing', 'QA', 'Done'] },
      })
      const detail = await call<{ columns: Array<{ key: string; semantics: string | null }> }>(
        server,
        {
          method: 'GET',
          url: `/v1/boards/${created.body.slug}`,
          token: owner.token,
        },
      )
      expect(detail.body.columns.map((c) => [c.key, c.semantics])).toEqual([
        ['todo', 'backlog'],
        ['doing', 'in_progress'],
        ['qa', null],
        ['done', 'terminal'],
      ])
    } finally {
      await server.close()
    }
  })
})
