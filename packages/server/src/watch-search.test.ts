/**
 * Watching, activity and search on the server (SPEC.md §18 Session 14).
 */
import {
  ActivityPageSchema,
  type Card,
  CardListResponseSchema,
  type EventEnvelope,
} from '@yuzie/core'
import { and, eq } from 'drizzle-orm'
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
import { cards, events } from './db/schema.js'

const DAY = 86_400_000

describe('watching, activity and search', () => {
  let server: TestServer
  let board: TestBoard
  let priya: TestUser

  beforeAll(async () => {
    server = await startTestServer()
    board = await createBoard(server)
    priya = await createUser(server)
    await addMember(server, board, priya, 'member')
  })

  afterAll(async () => {
    await server?.close()
  })

  const get = <T>(url: string, token = board.owner.token) =>
    call<T>(server, { method: 'GET', url: `/v1/boards/${board.slug}${url}`, token })
  const post = <T>(url: string, body: unknown, token = board.owner.token) =>
    call<T>(server, { method: 'POST', url: `/v1/boards/${board.slug}${url}`, token, body })
  const list = async (query: string, token = board.owner.token) => {
    const response = await get<unknown>(`/cards?${query}`, token)
    expect(response.status).toBe(200)
    return CardListResponseSchema.parse(response.body).cards.map((card) => card.number)
  }

  describe('auto-watch', () => {
    it('commenting on a card starts watching it, and the event says so', async () => {
      const { number } = await createCard(server, board, board.owner.token, { title: 'Watch me' })
      const comment = await post(`/cards/${number}/comments`, { body: 'on it' }, priya.token)
      expect(comment.status).toBe(201)

      const card = (await get<Card>(`/cards/${number}`)).body
      expect(card.watchers).toContain(priya.handle)
      const log = (await get<{ events: EventEnvelope[] }>(`/activity?card=${number}`)).body.events
      const created = log.find((event) => event.type === 'comment.created')
      expect(created?.payload).toMatchObject({ watch: [priya.handle] })

      // A second comment does not claim to start watching again.
      await post(`/cards/${number}/comments`, { body: 'still on it' }, priya.token)
      const again = (await get<{ events: EventEnvelope[] }>(`/activity?card=${number}`)).body.events
      const last = again.filter((event) => event.type === 'comment.created').at(-1)
      expect(last?.payload).not.toHaveProperty('watch')
    })

    it('being assigned starts watching', async () => {
      const { number } = await createCard(server, board, board.owner.token, { title: 'Assign me' })
      await post(`/cards/${number}/assign`, { add: [priya.handle] })
      expect((await get<Card>(`/cards/${number}`)).body.watchers).toEqual([priya.handle])
    })

    it('a board can turn it off', async () => {
      const quiet = await createBoard(server)
      const patched = await call<{ autoWatch: boolean }>(server, {
        method: 'PATCH',
        url: `/v1/boards/${quiet.slug}`,
        token: quiet.owner.token,
        body: { autoWatch: false },
      })
      expect(patched.body.autoWatch).toBe(false)
      const { number } = await createCard(server, quiet, quiet.owner.token)
      await call(server, {
        method: 'POST',
        url: `/v1/boards/${quiet.slug}/cards/${number}/comments`,
        token: quiet.owner.token,
        body: { body: 'no watching' },
      })
      const card = await call<Card>(server, {
        method: 'GET',
        url: `/v1/boards/${quiet.slug}/cards/${number}`,
        token: quiet.owner.token,
      })
      expect(card.body.watchers).toEqual([])
    })
  })

  describe('search', () => {
    let searchBoard: TestBoard
    beforeAll(async () => {
      searchBoard = await createBoard(server)
      const token = searchBoard.owner.token
      await createCard(server, searchBoard, token, { title: 'Fix OAuth', labels: ['auth'] })
      const safari = await createCard(server, searchBoard, token, { title: 'Checkout bug' })
      await call(server, {
        method: 'POST',
        url: `/v1/boards/${searchBoard.slug}/cards/${safari.number}/comments`,
        token,
        body: { body: 'Only on Safari 17' },
      })
      await createCard(server, searchBoard, token, {
        title: 'Rate limits',
        description: 'Back off on 429 with 100% jitter',
      })
    })
    const find = async (query: string) => {
      const response = await call<unknown>(server, {
        method: 'GET',
        url: `/v1/boards/${searchBoard.slug}/cards?search=${encodeURIComponent(query)}`,
        token: searchBoard.owner.token,
      })
      return CardListResponseSchema.parse(response.body).cards.map((card) => card.title)
    }

    it('matches titles, descriptions, comments, labels and assignees', async () => {
      expect(await find('oauth')).toEqual(['Fix OAuth'])
      expect(await find('SAFARI')).toEqual(['Checkout bug'])
      expect(await find('429')).toEqual(['Rate limits'])
      expect(await find('auth')).toEqual(['Fix OAuth'])
      expect(await find(`@${searchBoard.owner.handle}`)).toEqual([])
    })

    it('needs every word, and treats % and _ literally', async () => {
      expect(await find('checkout safari')).toEqual(['Checkout bug'])
      expect(await find('checkout oauth')).toEqual([])
      expect(await find('100%')).toEqual(['Rate limits'])
      expect(await find('%')).toEqual(['Rate limits'])
      expect(await find('_')).toEqual([])
    })
  })

  describe('filters', () => {
    it('--mine and --watching are about the caller', async () => {
      const { number } = await createCard(server, board, board.owner.token, { title: 'Mine' })
      await post(`/cards/${number}/assign`, { add: [priya.handle] })
      expect(await list('mine=true', priya.token)).toContain(number)
      expect(await list('mine=true')).not.toContain(number)
      expect(await list('watching=true', priya.token)).toContain(number)
    })

    it('--stale means claimed N days ago with no commits since', async () => {
      const staleBoard = await createBoard(server)
      const token = staleBoard.owner.token
      const idle = await createCard(server, staleBoard, token, { title: 'Idle' })
      const busy = await createCard(server, staleBoard, token, { title: 'Busy' })
      const fresh = await createCard(server, staleBoard, token, { title: 'Fresh' })
      for (const card of [idle, busy, fresh]) {
        await call(server, {
          method: 'POST',
          url: `/v1/boards/${staleBoard.slug}/cards/${card.number}/move`,
          token,
          body: { column: 'doing' },
        })
        await call(server, {
          method: 'POST',
          url: `/v1/boards/${staleBoard.slug}/cards/${card.number}/assign`,
          token,
          body: { add: [staleBoard.owner.handle] },
        })
      }
      // Busy has committed since; the claims on Idle and Busy happened days ago.
      await call(server, {
        method: 'PUT',
        url: `/v1/boards/${staleBoard.slug}/cards/${busy.number}/git`,
        token,
        body: {
          branch: 'task/busy',
          commits: 2,
          filesChanged: 1,
          additions: 3,
          deletions: 0,
          pushed: false,
          lastActivityAt: new Date(Date.now() - DAY).toISOString(),
        },
      })
      const db = server.handle.db
      for (const card of [idle, busy]) {
        await db
          .update(events)
          .set({ createdAt: new Date(Date.now() - 3 * DAY) })
          .where(and(eq(events.boardId, staleBoard.id), eq(events.cardNo, card.number)))
      }

      const response = await call<unknown>(server, {
        method: 'GET',
        url: `/v1/boards/${staleBoard.slug}/cards?stale=2d`,
        token,
      })
      const stale = CardListResponseSchema.parse(response.body).cards.map((card) => card.number)
      expect(stale).toEqual([idle.number])
      // The card rows were touched just now; only the log knows the claim is old.
      const [row] = await db.select().from(cards).where(eq(cards.boardId, staleBoard.id))
      expect(Date.now() - (row?.updatedAt.getTime() ?? 0)).toBeLessThan(DAY)
    })

    it('refuses a duration it cannot read', async () => {
      const response = await get<{ error: { code: string } }>('/cards?stale=soon')
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('validation_failed')
    })
  })

  describe('activity', () => {
    it('pages backwards with a stable cursor, filtered by card and author', async () => {
      const paged = await createBoard(server)
      await addMember(server, paged, priya, 'member')
      const { number } = await createCard(server, paged, paged.owner.token)
      for (let i = 0; i < 5; i += 1) {
        await call(server, {
          method: 'POST',
          url: `/v1/boards/${paged.slug}/cards/${number}/comments`,
          token: i % 2 === 0 ? priya.token : paged.owner.token,
          body: { body: `comment ${i}` },
        })
      }
      const page = async (query: string) =>
        ActivityPageSchema.parse(
          (
            await call<unknown>(server, {
              method: 'GET',
              url: `/v1/boards/${paged.slug}/activity?${query}`,
              token: paged.owner.token,
            })
          ).body,
        )

      const first = await page(`card=${number}&limit=4`)
      expect(first.events.map((event) => event.seq)).toEqual(
        [...first.events.map((event) => event.seq)].sort((a, b) => a - b),
      )
      expect(first.events).toHaveLength(4)
      expect(first.next).toBe(first.events[0]?.seq)
      const second = await page(`card=${number}&limit=4&before=${first.next}`)
      expect(second.next).toBeNull()
      const all = [...second.events, ...first.events].map((event) => event.seq)
      expect(new Set(all).size).toBe(all.length)
      expect(all).toHaveLength(6)

      const byPriya = await page(`actor=${priya.handle}`)
      expect(byPriya.events.map((event) => event.actor)).toEqual([
        priya.handle,
        priya.handle,
        priya.handle,
      ])
      const recent = await page(`from=${new Date(Date.now() + DAY).toISOString()}`)
      expect(recent.events).toEqual([])
    })
  })
})
