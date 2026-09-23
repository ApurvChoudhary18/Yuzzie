/**
 * One suite, both drivers.
 *
 * SPEC.md §18 Session 2 requires the JSON fallback to pass the identical tests as
 * SQLite, so the suite lives here and each driver's test file calls it. If a
 * behaviour is only asserted for one driver, it is not in this file by mistake.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BOARD,
  makeCard,
  makeChecklistItem,
  makeColumn,
  makeComment,
  makeEvent,
  makeFullCard,
  makeGit,
  resetIds,
  T1,
} from '../__fixtures__/cards.js'
import { applyEventsToCache, applyEventToCache } from '../apply-event.js'
import type { CacheDriverKind, OutboxOp, YuzieCache } from '../types.js'

export interface ConformanceHarness {
  readonly kind: CacheDriverKind
  /** Open a cache at `location`, which may be `:memory:`. */
  open(location: string, jitter?: () => number): YuzieCache
}

function op(key: string, path = '/boards/payments-api/cards'): OutboxOp {
  return { method: 'POST', path, body: { title: key }, idempotencyKey: key }
}

export function describeCacheConformance(harness: ConformanceHarness): void {
  describe(`${harness.kind} driver`, () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), `yuzie-${harness.kind}-`))
    let files = 0
    const open = (jitter?: () => number) => harness.open(':memory:', jitter)
    const tempFile = () => {
      files += 1
      return join(temporaryRoot, `cache-${files}.db`)
    }

    afterAll(() => {
      rmSync(temporaryRoot, { recursive: true, force: true })
    })

    let cache: YuzieCache
    beforeEach(() => {
      resetIds()
      cache = open()
    })

    // -----------------------------------------------------------------------
    describe('cards', () => {
      it('round-trips a card with every optional part populated', () => {
        const card = makeFullCard()
        cache.cards.put(BOARD, card)
        expect(cache.cards.get(BOARD, 18)).toEqual(card)
      })

      it('returns undefined for a card it does not hold', () => {
        expect(cache.cards.get(BOARD, 404)).toBeUndefined()
      })

      it('keeps boards separate', () => {
        cache.cards.put(BOARD, makeCard(1))
        cache.cards.put('other-board', makeCard(1, { title: 'Elsewhere' }))
        expect(cache.cards.get(BOARD, 1)?.title).toBe('Card 1')
        expect(cache.cards.get('other-board', 1)?.title).toBe('Elsewhere')
      })

      it('upserts rather than duplicating', () => {
        cache.cards.put(BOARD, makeCard(1, { title: 'First' }))
        cache.cards.put(BOARD, makeCard(1, { title: 'Second' }))
        expect(cache.cards.count(BOARD)).toBe(1)
        expect(cache.cards.get(BOARD, 1)?.title).toBe('Second')
      })

      it('replaces a card’s children on upsert instead of accumulating them', () => {
        const card = makeFullCard()
        cache.cards.put(BOARD, card)
        cache.cards.put(BOARD, { ...card, comments: [], checklist: [], git: null })

        const stored = cache.cards.get(BOARD, 18)
        expect(stored?.comments).toEqual([])
        expect(stored?.checklist).toEqual([])
        expect(stored?.git).toBeNull()
      })

      it('lists in board order: rank, then card number', () => {
        cache.cards.putMany(BOARD, [
          makeCard(3, { rank: 'c' }),
          makeCard(1, { rank: 'a' }),
          makeCard(9, { rank: 'b' }),
          makeCard(4, { rank: 'b' }),
        ])
        expect(cache.cards.list(BOARD).map((card) => card.number)).toEqual([1, 4, 9, 3])
      })

      it('filters by column, assignee, label, and limit', () => {
        cache.cards.putMany(BOARD, [
          makeCard(1, { rank: 'a', column: 'todo', assignees: ['rahul'], labels: ['bug'] }),
          makeCard(2, { rank: 'b', column: 'doing', assignees: ['priya'], labels: ['auth'] }),
          makeCard(3, { rank: 'c', column: 'todo', assignees: ['rahul'], labels: ['auth'] }),
        ])

        expect(cache.cards.list(BOARD, { column: 'todo' }).map((c) => c.number)).toEqual([1, 3])
        expect(cache.cards.list(BOARD, { assignee: 'rahul' }).map((c) => c.number)).toEqual([1, 3])
        expect(cache.cards.list(BOARD, { label: 'auth' }).map((c) => c.number)).toEqual([2, 3])
        expect(cache.cards.list(BOARD, { limit: 2 }).map((c) => c.number)).toEqual([1, 2])
        expect(
          cache.cards.list(BOARD, { column: 'todo', label: 'auth' }).map((c) => c.number),
        ).toEqual([3])
      })

      it('deletes a card and its children', () => {
        cache.cards.put(BOARD, makeFullCard())
        expect(cache.cards.delete(BOARD, 18)).toBe(true)
        expect(cache.cards.get(BOARD, 18)).toBeUndefined()
        expect(cache.comments.listByCard(BOARD, 18)).toEqual([])
        expect(cache.checklist.listByCard(BOARD, 18)).toEqual([])
        expect(cache.git.get(BOARD, 18)).toBeUndefined()
      })

      it('reports a delete that matched nothing', () => {
        expect(cache.cards.delete(BOARD, 404)).toBe(false)
      })

      it('clears one board without touching another', () => {
        cache.cards.put(BOARD, makeCard(1))
        cache.cards.put('other-board', makeCard(1))
        cache.cards.clear(BOARD)
        expect(cache.cards.count(BOARD)).toBe(0)
        expect(cache.cards.count('other-board')).toBe(1)
      })

      it('does not hand out a reference callers can mutate', () => {
        cache.cards.put(BOARD, makeFullCard())
        const first = cache.cards.get(BOARD, 18)
        first?.assignees.push('mallory')
        expect(cache.cards.get(BOARD, 18)?.assignees).toEqual(['rahul', 'claude'])
      })
    })

    // -----------------------------------------------------------------------
    describe('columns', () => {
      it('round-trips and orders by rank', () => {
        cache.columns.putMany(BOARD, [makeColumn('doing', 'b'), makeColumn('todo', 'a')])
        expect(cache.columns.list(BOARD).map((column) => column.key)).toEqual(['todo', 'doing'])
      })

      it('upserts by key and deletes', () => {
        cache.columns.put(BOARD, makeColumn('todo', 'a'))
        cache.columns.put(BOARD, makeColumn('todo', 'a', { name: 'Backlog', semantics: 'backlog' }))
        expect(cache.columns.list(BOARD)).toHaveLength(1)
        expect(cache.columns.list(BOARD)[0]?.name).toBe('Backlog')
        expect(cache.columns.list(BOARD)[0]?.semantics).toBe('backlog')

        expect(cache.columns.delete(BOARD, 'todo')).toBe(true)
        expect(cache.columns.delete(BOARD, 'todo')).toBe(false)
      })

      it('clears every board when no slug is given', () => {
        cache.columns.put(BOARD, makeColumn('todo', 'a'))
        cache.columns.put('other-board', makeColumn('todo', 'a'))
        cache.columns.clear()
        expect(cache.columns.list(BOARD)).toEqual([])
        expect(cache.columns.list('other-board')).toEqual([])
      })
    })

    // -----------------------------------------------------------------------
    describe('comments, checklist and git', () => {
      beforeEach(() => {
        cache.cards.put(BOARD, makeCard(18))
      })

      it('attaches a comment to a card and reads it back on the card', () => {
        const comment = makeComment(18)
        cache.comments.put(BOARD, comment)
        expect(cache.comments.listByCard(BOARD, 18)).toEqual([comment])
        expect(cache.cards.get(BOARD, 18)?.comments).toEqual([comment])
      })

      it('orders comments oldest first', () => {
        const later = makeComment(18, { createdAt: '2026-08-19T10:00:00Z' })
        const earlier = makeComment(18, { createdAt: '2026-08-19T08:00:00Z' })
        cache.comments.put(BOARD, later)
        cache.comments.put(BOARD, earlier)
        expect(cache.comments.listByCard(BOARD, 18).map((c) => c.createdAt)).toEqual([
          earlier.createdAt,
          later.createdAt,
        ])
      })

      it('deletes a comment by id', () => {
        const comment = makeComment(18)
        cache.comments.put(BOARD, comment)
        expect(cache.comments.delete(BOARD, comment.id)).toBe(true)
        expect(cache.comments.delete(BOARD, comment.id)).toBe(false)
        expect(cache.comments.listByCard(BOARD, 18)).toEqual([])
      })

      it('orders checklist items by position', () => {
        const second = makeChecklistItem({ position: 2, text: 'Add token refresh' })
        const first = makeChecklistItem({ position: 1, text: 'Fix callback state' })
        cache.checklist.put(BOARD, 18, second)
        cache.checklist.put(BOARD, 18, first)
        expect(cache.checklist.listByCard(BOARD, 18).map((item) => item.text)).toEqual([
          'Fix callback state',
          'Add token refresh',
        ])
      })

      it('toggles a checklist item by upserting it', () => {
        const item = makeChecklistItem()
        cache.checklist.put(BOARD, 18, item)
        cache.checklist.put(BOARD, 18, { ...item, doneAt: T1, doneBy: 'rahul' })
        expect(cache.checklist.listByCard(BOARD, 18)).toHaveLength(1)
        expect(cache.checklist.listByCard(BOARD, 18)[0]?.doneAt).toBe(T1)
      })

      it('deletes a checklist item by id', () => {
        const item = makeChecklistItem()
        cache.checklist.put(BOARD, 18, item)
        expect(cache.checklist.delete(BOARD, item.id)).toBe(true)
        expect(cache.checklist.delete(BOARD, item.id)).toBe(false)
      })

      it('stores and clears a git summary', () => {
        const git = makeGit()
        cache.git.put(BOARD, 18, git)
        expect(cache.git.get(BOARD, 18)).toEqual(git)
        expect(cache.cards.get(BOARD, 18)?.git).toEqual(git)

        expect(cache.git.delete(BOARD, 18)).toBe(true)
        expect(cache.git.delete(BOARD, 18)).toBe(false)
        expect(cache.cards.get(BOARD, 18)?.git).toBeNull()
      })

      it('clears children across every board when no slug is given', () => {
        cache.cards.put('other-board', makeCard(18))
        cache.comments.put(BOARD, makeComment(18))
        cache.comments.put('other-board', makeComment(18))
        cache.checklist.put(BOARD, 18, makeChecklistItem())
        cache.checklist.put('other-board', 18, makeChecklistItem())
        cache.git.put(BOARD, 18, makeGit())
        cache.git.put('other-board', 18, makeGit())

        cache.comments.clear()
        cache.checklist.clear()
        cache.git.clear()

        for (const slug of [BOARD, 'other-board']) {
          expect(cache.comments.listByCard(slug, 18)).toEqual([])
          expect(cache.checklist.listByCard(slug, 18)).toEqual([])
          expect(cache.git.get(slug, 18)).toBeUndefined()
        }
      })

      it('reports nothing to delete for a card it does not hold', () => {
        expect(cache.comments.delete('unknown-board', 'nope')).toBe(false)
        expect(cache.checklist.delete('unknown-board', 'nope')).toBe(false)
        expect(cache.git.delete('unknown-board', 404)).toBe(false)
      })

      it('preserves the false branch of a boolean git field', () => {
        cache.git.put(BOARD, 18, makeGit({ pushed: false, prUrl: null, prState: null }))
        expect(cache.git.get(BOARD, 18)?.pushed).toBe(false)
      })
    })

    // -----------------------------------------------------------------------
    describe('events', () => {
      it('appends and replays in seq order', () => {
        cache.events.appendMany(BOARD, [
          makeEvent('card.deleted', 3, { number: 3 }),
          makeEvent('card.deleted', 1, { number: 1 }),
          makeEvent('card.deleted', 2, { number: 2 }),
        ])
        expect(cache.events.since(BOARD, 0).map((event) => event.seq)).toEqual([1, 2, 3])
        expect(cache.events.since(BOARD, 1).map((event) => event.seq)).toEqual([2, 3])
        expect(cache.events.since(BOARD, 0, 2).map((event) => event.seq)).toEqual([1, 2])
        expect(cache.events.lastSeq(BOARD)).toBe(3)
        expect(cache.events.count(BOARD)).toBe(3)
      })

      it('is idempotent on the same seq', () => {
        const event = makeEvent('card.deleted', 1, { number: 1 })
        cache.events.append(BOARD, event)
        cache.events.append(BOARD, event)
        expect(cache.events.count(BOARD)).toBe(1)
      })

      it('round-trips the whole envelope, payload included', () => {
        const event = makeEvent('card.moved', 7, { from: 'todo', to: 'doing', rank: 'a1' })
        cache.events.append(BOARD, event)
        expect(cache.events.since(BOARD, 6)[0]).toEqual(event)
      })

      it('reports zero for a board with no events', () => {
        expect(cache.events.lastSeq('empty-board')).toBe(0)
        expect(cache.events.since('empty-board', 0)).toEqual([])
      })
    })

    // -----------------------------------------------------------------------
    describe('sync state', () => {
      it('reads an unknown board as never synced', () => {
        expect(cache.sync.get('unknown')).toEqual({
          boardSlug: 'unknown',
          lastSeq: 0,
          syncedAt: null,
        })
      })

      it('advances the cursor and never moves it backwards', () => {
        cache.sync.advance(BOARD, 10, 1_700_000_000_000)
        expect(cache.sync.get(BOARD).lastSeq).toBe(10)

        cache.sync.advance(BOARD, 4)
        expect(cache.sync.get(BOARD).lastSeq).toBe(10)
        expect(cache.sync.get(BOARD).syncedAt).toBe(1_700_000_000_000)
      })

      it('lists every board it knows about', () => {
        cache.sync.advance('a-board', 1)
        cache.sync.advance('b-board', 2)
        expect(cache.sync.all().map((state) => state.boardSlug)).toEqual(['a-board', 'b-board'])
      })

      it('resets a board on clear', () => {
        cache.sync.advance(BOARD, 10, 1)
        cache.sync.clear(BOARD)
        expect(cache.sync.get(BOARD).lastSeq).toBe(0)
      })
    })

    // -----------------------------------------------------------------------
    describe('outbox', () => {
      it('queues a write and reports the queue size', () => {
        const entry = cache.outbox.enqueue(BOARD, op('write-1'))
        expect(entry.attempts).toBe(0)
        expect(entry.lastError).toBeNull()
        expect(entry.nextAttemptAt).toBeNull()
        expect(cache.outbox.size(BOARD)).toBe(1)
      })

      it('deduplicates by idempotency key instead of queueing twice', () => {
        const first = cache.outbox.enqueue(BOARD, op('write-1'))
        const second = cache.outbox.enqueue(BOARD, op('write-1'))
        expect(second.id).toBe(first.id)
        expect(cache.outbox.size(BOARD)).toBe(1)
      })

      it('treats the same key on a different board as a different write', () => {
        cache.outbox.enqueue(BOARD, op('write-1'))
        cache.outbox.enqueue('other-board', op('write-1'))
        expect(cache.outbox.size()).toBe(2)
        expect(cache.outbox.size(BOARD)).toBe(1)
      })

      it('lists in queue order', () => {
        for (const key of ['a', 'b', 'c']) cache.outbox.enqueue(BOARD, op(key))
        expect(cache.outbox.list(BOARD).map((entry) => entry.op.idempotencyKey)).toEqual([
          'a',
          'b',
          'c',
        ])
      })

      it('drains successfully and empties the queue', async () => {
        for (const key of ['a', 'b', 'c']) cache.outbox.enqueue(BOARD, op(key))
        const seen: string[] = []

        const report = await cache.outbox.drain((entry) => {
          seen.push(entry.op.idempotencyKey)
        })

        expect(seen).toEqual(['a', 'b', 'c'])
        expect(report).toMatchObject({ sent: 3, failed: 0, remaining: 0, stoppedAt: null })
        expect(cache.outbox.size()).toBe(0)
      })

      it('drains at most `limit` entries', async () => {
        for (const key of ['a', 'b', 'c']) cache.outbox.enqueue(BOARD, op(key))
        const report = await cache.outbox.drain(() => {}, { limit: 2 })
        expect(report.sent).toBe(2)
        expect(cache.outbox.size()).toBe(1)
      })

      it('is a no-op the second time, which is what makes retrying safe', async () => {
        for (const key of ['a', 'b']) cache.outbox.enqueue(BOARD, op(key))
        const seen: string[] = []
        const handler = (entry: { op: OutboxOp }) => {
          seen.push(entry.op.idempotencyKey)
        }

        await cache.outbox.drain(handler)
        await cache.outbox.drain(handler)

        expect(seen).toEqual(['a', 'b'])
      })

      it('records a failure with backoff and stops so writes stay ordered', async () => {
        for (const key of ['a', 'b', 'c']) cache.outbox.enqueue(BOARD, op(key))
        const seen: string[] = []
        const now = 1_000_000

        const report = await cache.outbox.drain(
          (entry) => {
            seen.push(entry.op.idempotencyKey)
            if (entry.op.idempotencyKey === 'b') throw new Error('network unreachable')
          },
          { now },
        )

        expect(seen).toEqual(['a', 'b'])
        expect(report.sent).toBe(1)
        expect(report.failed).toBe(1)
        expect(report.stoppedAt?.op.idempotencyKey).toBe('b')

        const failed = cache.outbox.list(BOARD)[0]
        expect(failed?.op.idempotencyKey).toBe('b')
        expect(failed?.attempts).toBe(1)
        expect(failed?.lastError).toBe('network unreachable')
        expect(failed?.nextAttemptAt).toBeGreaterThan(now)
      })

      it('holds a failed entry back until its backoff elapses', async () => {
        cache.outbox.enqueue(BOARD, op('a'))
        const now = 1_000_000

        await cache.outbox.drain(
          () => {
            throw new Error('offline')
          },
          { now },
        )

        expect(cache.outbox.due(now)).toEqual([])
        expect(cache.outbox.due(now + 60_000)).toHaveLength(1)

        const skipped = await cache.outbox.drain(() => {}, { now })
        expect(skipped.sent).toBe(0)
      })

      it('lengthens the delay on each successive failure', () => {
        const entry = cache.outbox.enqueue(BOARD, op('a'))
        cache.outbox.recordFailure(entry.id, 'first', 0)
        const afterFirst = cache.outbox.list(BOARD)[0]?.nextAttemptAt ?? 0
        cache.outbox.recordFailure(entry.id, 'second', 0)
        const afterSecond = cache.outbox.list(BOARD)[0]?.nextAttemptAt ?? 0

        expect(cache.outbox.list(BOARD)[0]?.attempts).toBe(2)
        expect(afterSecond).toBeGreaterThan(afterFirst)
      })

      it('ignores a failure recorded against an entry that is gone', () => {
        expect(() => cache.outbox.recordFailure(9999, 'nope')).not.toThrow()
      })

      it('removes and clears', () => {
        const entry = cache.outbox.enqueue(BOARD, op('a'))
        cache.outbox.enqueue('other-board', op('b'))

        expect(cache.outbox.remove(entry.id)).toBe(true)
        expect(cache.outbox.remove(entry.id)).toBe(false)

        cache.outbox.enqueue(BOARD, op('c'))
        cache.outbox.clear(BOARD)
        expect(cache.outbox.size(BOARD)).toBe(0)
        expect(cache.outbox.size('other-board')).toBe(1)
      })

      it('clears every board when no slug is given', () => {
        cache.outbox.enqueue(BOARD, op('a'))
        cache.outbox.enqueue('other-board', op('b'))
        cache.outbox.clear()
        expect(cache.outbox.size()).toBe(0)
      })

      it('records a thrown non-Error as its string form', async () => {
        cache.outbox.enqueue(BOARD, op('a'))
        await cache.outbox.drain(() => {
          // Handlers are user code; not everything thrown is an Error.
          throw 'connection reset'
        })
        expect(cache.outbox.list(BOARD)[0]?.lastError).toBe('connection reset')
      })

      it('serialises the op body faithfully', () => {
        cache.outbox.enqueue(BOARD, {
          method: 'PATCH',
          path: '/boards/payments-api/cards/18',
          body: { title: 'Fix OAuth', labels: ['bug'], nested: { deep: true } },
          idempotencyKey: 'patch-18',
        })
        expect(cache.outbox.list(BOARD)[0]?.op).toEqual({
          method: 'PATCH',
          path: '/boards/payments-api/cards/18',
          body: { title: 'Fix OAuth', labels: ['bug'], nested: { deep: true } },
          idempotencyKey: 'patch-18',
        })
      })
    })

    // -----------------------------------------------------------------------
    describe('transactions', () => {
      it('commits every write made inside', () => {
        cache.transaction(() => {
          cache.cards.put(BOARD, makeCard(1))
          cache.cards.put(BOARD, makeCard(2))
        })
        expect(cache.cards.count(BOARD)).toBe(2)
      })

      it('rolls every write back when the body throws', () => {
        cache.cards.put(BOARD, makeCard(1, { title: 'Before' }))

        expect(() =>
          cache.transaction(() => {
            cache.cards.put(BOARD, makeCard(1, { title: 'After' }))
            cache.cards.put(BOARD, makeCard(2))
            throw new Error('boom')
          }),
        ).toThrow('boom')

        expect(cache.cards.get(BOARD, 1)?.title).toBe('Before')
        expect(cache.cards.get(BOARD, 2)).toBeUndefined()
      })

      it('returns the body’s value', () => {
        expect(cache.transaction(() => 42)).toBe(42)
      })

      it('nests', () => {
        cache.transaction(() => {
          cache.cards.put(BOARD, makeCard(1))
          cache.transaction(() => {
            cache.cards.put(BOARD, makeCard(2))
          })
        })
        expect(cache.cards.count(BOARD)).toBe(2)
      })
    })

    // -----------------------------------------------------------------------
    describe('applyEventToCache', () => {
      it('creates a card and moves the cursor', () => {
        const card = makeFullCard()
        const result = applyEventToCache(cache, BOARD, makeEvent('card.created', 1, card))

        expect(result).toMatchObject({ applied: true, seq: 1, cardNumber: 18, change: 'created' })
        expect(cache.cards.get(BOARD, 18)).toEqual(card)
        expect(cache.sync.get(BOARD).lastSeq).toBe(1)
      })

      it('mirrors the event so activity stays a projection over the log', () => {
        applyEventToCache(cache, BOARD, makeEvent('card.created', 1, makeCard(18)))
        expect(cache.events.since(BOARD, 0)).toHaveLength(1)
      })

      it('updates a card through the core reducer', () => {
        applyEventToCache(cache, BOARD, makeEvent('card.created', 1, makeCard(18)))
        const result = applyEventToCache(
          cache,
          BOARD,
          makeEvent('card.moved', 2, { from: 'doing', to: 'review', rank: 'a1' }),
        )

        expect(result.change).toBe('updated')
        expect(cache.cards.get(BOARD, 18)?.column).toBe('review')
        expect(cache.cards.get(BOARD, 18)?.rank).toBe('a1')
      })

      it('applies child events through the reducer, not by hand', () => {
        applyEventToCache(cache, BOARD, makeEvent('card.created', 1, makeCard(18)))
        applyEventToCache(
          cache,
          BOARD,
          makeEvent('comment.created', 2, {
            commentId: '99999999-9999-4999-8999-999999999999',
            body: 'Fixed.',
            author: 'rahul',
          }),
        )

        const comments = cache.cards.get(BOARD, 18)?.comments ?? []
        expect(comments).toHaveLength(1)
        expect(comments[0]?.body).toBe('Fixed.')
        expect(comments[0]?.createdAt).toBe(T1)
      })

      it('deletes a card', () => {
        applyEventToCache(cache, BOARD, makeEvent('card.created', 1, makeCard(18)))
        const result = applyEventToCache(cache, BOARD, makeEvent('card.deleted', 2, { number: 18 }))

        expect(result.change).toBe('deleted')
        expect(cache.cards.get(BOARD, 18)).toBeUndefined()
      })

      it('ignores an event at or below the cursor', () => {
        const created = makeEvent('card.created', 1, makeCard(18, { title: 'Original' }))
        applyEventToCache(cache, BOARD, created)

        const replay = applyEventToCache(
          cache,
          BOARD,
          makeEvent('card.created', 1, makeCard(18, { title: 'Replayed' })),
        )

        expect(replay).toMatchObject({ applied: false, seq: 1, change: 'none' })
        expect(cache.cards.get(BOARD, 18)?.title).toBe('Original')
      })

      it('advances the cursor for an event with nothing to persist locally', () => {
        const result = applyEventToCache(
          cache,
          BOARD,
          makeEvent('member.joined', 1, { handle: 'priya', role: 'owner' }, { cardNo: undefined }),
        )
        expect(result).toMatchObject({ applied: true, seq: 1, change: 'none' })
        expect(cache.sync.get(BOARD).lastSeq).toBe(1)
      })

      it('reports no change when the reducer leaves the card untouched', () => {
        applyEventToCache(cache, BOARD, makeEvent('card.created', 1, makeCard(18)))
        applyEventToCache(
          cache,
          BOARD,
          makeEvent('card.commits.attached', 2, { shas: ['a3f9c21'] }),
        )

        const repeat = applyEventToCache(
          cache,
          BOARD,
          makeEvent('card.commits.attached', 3, { shas: ['a3f9c21'] }),
        )

        expect(repeat).toMatchObject({ applied: true, seq: 3, change: 'none' })
        expect(cache.cards.get(BOARD, 18)?.commits).toHaveLength(1)
      })

      it('is total for an event type it has never heard of', () => {
        const future = {
          type: 'card.teleported',
          seq: 1,
          actor: 'rahul',
          cardNo: 18,
          ts: T1,
          payload: {},
        } as unknown as Parameters<typeof applyEventToCache>[2]

        expect(() => applyEventToCache(cache, BOARD, future)).not.toThrow()
        expect(cache.sync.get(BOARD).lastSeq).toBe(1)
      })

      it('applies a batch in seq order whatever order it arrives in', () => {
        const results = applyEventsToCache(cache, BOARD, [
          makeEvent('card.moved', 2, { from: 'doing', to: 'review', rank: 'a1' }),
          makeEvent('card.created', 1, makeCard(18)),
          makeEvent('card.assigned', 3, { added: ['priya'], removed: [] }),
        ])

        expect(results.map((result) => result.seq)).toEqual([1, 2, 3])
        expect(cache.cards.get(BOARD, 18)?.column).toBe('review')
        expect(cache.cards.get(BOARD, 18)?.assignees).toEqual(['priya'])
        expect(cache.sync.get(BOARD).lastSeq).toBe(3)
      })
    })

    // -----------------------------------------------------------------------
    describe('durability across restarts', () => {
      it('persists cards, events, sync state and the outbox to disk', () => {
        const file = tempFile()
        const card = makeFullCard()
        const first = harness.open(file)
        first.cards.put(BOARD, card)
        first.columns.put(BOARD, makeColumn('doing', 'b'))
        first.events.append(BOARD, makeEvent('card.deleted', 4, { number: 4 }))
        first.sync.advance(BOARD, 4, 1_700_000_000_000)
        first.outbox.enqueue(BOARD, op('survives-restart'))
        first.close()

        const second = harness.open(file)
        try {
          expect(second.cards.get(BOARD, 18)).toEqual(card)
          expect(second.columns.list(BOARD).map((column) => column.key)).toEqual(['doing'])
          expect(second.events.lastSeq(BOARD)).toBe(4)
          expect(second.sync.get(BOARD)).toEqual({
            boardSlug: BOARD,
            lastSeq: 4,
            syncedAt: 1_700_000_000_000,
          })
          expect(second.outbox.list(BOARD).map((entry) => entry.op.idempotencyKey)).toEqual([
            'survives-restart',
          ])
        } finally {
          second.close()
        }
      })

      it('keeps outbox retry bookkeeping across a restart', async () => {
        const file = tempFile()
        const first = harness.open(file)
        first.outbox.enqueue(BOARD, op('will-fail'))
        await first.outbox.drain(
          () => {
            throw new Error('offline')
          },
          { now: 1_000_000 },
        )
        first.close()

        const second = harness.open(file)
        try {
          const entry = second.outbox.list(BOARD)[0]
          expect(entry?.attempts).toBe(1)
          expect(entry?.lastError).toBe('offline')
          expect(entry?.nextAttemptAt).toBeGreaterThan(1_000_000)
        } finally {
          second.close()
        }
      })

      it('starts empty rather than failing when the file does not exist yet', () => {
        const fresh = harness.open(tempFile())
        try {
          expect(fresh.cards.count(BOARD)).toBe(0)
          expect(fresh.sync.get(BOARD).lastSeq).toBe(0)
        } finally {
          fresh.close()
        }
      })
    })
  })
}
