import { describe, expect, it } from 'vitest'
import { COMMENT_ID, ITEM_ID, makeCard, makeEvent, T1 } from './__fixtures__/board.js'
import {
  compareEvents,
  EVENT_TYPES,
  EventEnvelopeSchema,
  EventsReplayQuerySchema,
  EventsReplayResponseSchema,
  type EventType,
  isEventType,
  PresenceBroadcastSchema,
  PresenceFrameSchema,
  parseEvent,
  safeParseEvent,
} from './events.js'

/** SPEC.md §12.3, transcribed. `presence.*` is excluded: it is never persisted. */
const CATALOGUE: readonly EventType[] = [
  'card.created',
  'card.updated',
  'card.moved',
  'card.assigned',
  'card.deleted',
  'comment.created',
  'checklist.updated',
  'card.branch.linked',
  'card.git.updated',
  'card.commits.attached',
  'card.anchor.set',
  'member.joined',
  'member.left',
  'board.updated',
]

describe('the event catalogue', () => {
  it('matches §12.3 exactly, in order', () => {
    expect([...EVENT_TYPES]).toEqual([...CATALOGUE])
  })

  it('recognises its own types and nothing else', () => {
    for (const type of CATALOGUE) {
      expect(isEventType(type)).toBe(true)
    }
    expect(isEventType('presence.view')).toBe(false)
    expect(isEventType('card.teleported')).toBe(false)
    expect(isEventType(7)).toBe(false)
  })
})

describe('event payloads', () => {
  const samples: ReadonlyArray<[EventType, unknown, { cardNo?: number }]> = [
    ['card.created', makeCard(), {}],
    ['card.updated', { fields: { title: 'Fix OAuth' }, version: 2 }, {}],
    ['card.moved', { from: 'review', to: 'done', rank: 'a0m' }, {}],
    ['card.assigned', { added: ['rahul'], removed: [] }, {}],
    ['card.deleted', { number: 18 }, {}],
    ['comment.created', { commentId: COMMENT_ID, body: 'Fixed.', author: 'rahul' }, {}],
    ['checklist.updated', { itemId: ITEM_ID, done: true }, {}],
    ['card.branch.linked', { branch: 'task/18-fix-github-oauth', base: 'main' }, {}],
    ['card.git.updated', { commits: 3, filesChanged: 7, pushed: true, prUrl: null }, {}],
    ['card.commits.attached', { shas: ['a3f9c21'] }, {}],
    ['card.anchor.set', { path: 'src/auth/oauth.ts', line: 42 }, {}],
    ['member.joined', { handle: 'priya', role: 'owner' }, { cardNo: undefined }],
    ['member.left', { handle: 'priya', role: 'owner' }, { cardNo: undefined }],
    ['board.updated', { fields: { name: 'Payments' } }, { cardNo: undefined }],
  ]

  it('covers every catalogued type', () => {
    expect(samples.map(([type]) => type)).toEqual([...CATALOGUE])
  })

  for (const [type, payload, extra] of samples) {
    it(`${type} parses a well-formed envelope`, () => {
      const parsed = EventEnvelopeSchema.safeParse(makeEvent(type, 1, payload as never, extra))
      if (!parsed.success) throw new Error(`${type}: ${parsed.error.message}`)
      expect(parsed.data.type).toBe(type)
    })
  }

  it('requires a cardNo on card events', () => {
    const parsed = EventEnvelopeSchema.safeParse({
      type: 'card.moved',
      seq: 1,
      actor: 'rahul',
      ts: T1,
      payload: { from: 'todo', to: 'doing', rank: 'a1' },
    })
    expect(parsed.success).toBe(false)
  })

  it('allows a board event to omit cardNo', () => {
    const parsed = EventEnvelopeSchema.safeParse({
      type: 'board.updated',
      seq: 1,
      actor: null,
      ts: T1,
      payload: { fields: { name: 'Payments' } },
    })
    expect(parsed.success).toBe(true)
  })

  it('allows a null actor for events the server originated', () => {
    expect(
      EventEnvelopeSchema.safeParse(makeEvent('card.deleted', 1, { number: 18 }, { actor: null }))
        .success,
    ).toBe(true)
  })

  it('carries an idempotency key so a client can drop its own echo (§12.2)', () => {
    const parsed = EventEnvelopeSchema.safeParse({
      ...makeEvent('card.deleted', 1, { number: 18 }),
      idempotencyKey: 'write_01J8',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a payload that does not match its type', () => {
    expect(
      EventEnvelopeSchema.safeParse({
        type: 'card.moved',
        seq: 1,
        actor: 'rahul',
        cardNo: 18,
        ts: T1,
        payload: { from: 'todo' },
      }).success,
    ).toBe(false)
  })

  it('rejects a negative sequence number', () => {
    expect(
      EventEnvelopeSchema.safeParse(makeEvent('card.deleted', -1, { number: 18 })).success,
    ).toBe(false)
  })

  it('carries an anchor range, which §9.7 requires', () => {
    const parsed = EventEnvelopeSchema.safeParse(
      makeEvent('card.anchor.set', 1, {
        path: 'src/auth/oauth.ts',
        line: 42,
        endLine: 88,
        commitSha: 'a3f9c21',
      }),
    )
    expect(parsed.success).toBe(true)
  })
})

describe('parseEvent', () => {
  it('returns the narrowed event', () => {
    const event = parseEvent(makeEvent('card.moved', 3, { from: 'a', to: 'b', rank: 'V' }))
    expect(event.type).toBe('card.moved')
    if (event.type === 'card.moved') {
      expect(event.payload.to).toBe('b')
    }
  })

  it('throws on a malformed event', () => {
    expect(() => parseEvent({ type: 'nope' })).toThrow()
  })
})

describe('safeParseEvent', () => {
  it('returns null instead of throwing', () => {
    expect(safeParseEvent({ type: 'nope' })).toBeNull()
    expect(safeParseEvent(makeEvent('card.deleted', 1, { number: 18 }))).not.toBeNull()
  })
})

describe('compareEvents', () => {
  it('orders ascending by seq', () => {
    const first = makeEvent('card.deleted', 1, { number: 1 })
    const second = makeEvent('card.deleted', 2, { number: 2 })
    expect(compareEvents(first, second)).toBeLessThan(0)
    expect(compareEvents(second, first)).toBeGreaterThan(0)
    expect(compareEvents(first, first)).toBe(0)
  })
})

describe('presence frames', () => {
  it('accept the client frames in §12.2', () => {
    expect(PresenceFrameSchema.safeParse({ state: 'viewing', cardNo: 18 }).success).toBe(true)
    expect(
      PresenceFrameSchema.safeParse({ state: 'working', cardNo: 18, branch: 'task/18-x' }).success,
    ).toBe(true)
    expect(PresenceFrameSchema.safeParse({ state: 'dancing' }).success).toBe(false)
  })

  it('accept a presence broadcast', () => {
    const parsed = PresenceBroadcastSchema.safeParse({
      users: [
        { handle: 'rahul', kind: 'human', state: 'working', cardNo: 18, branch: null, since: T1 },
      ],
    })
    expect(parsed.success).toBe(true)
  })
})

describe('event replay (§12.1)', () => {
  it('accepts a since cursor and caps the page at the snapshot threshold', () => {
    expect(EventsReplayQuerySchema.safeParse({ since: 0 }).success).toBe(true)
    expect(EventsReplayQuerySchema.safeParse({ since: 4211, limit: 500 }).success).toBe(true)
    expect(EventsReplayQuerySchema.safeParse({ since: 4211, limit: 501 }).success).toBe(false)
    expect(EventsReplayQuerySchema.safeParse({ since: -1 }).success).toBe(false)
  })

  it('accepts a replay body with the board head', () => {
    const parsed = EventsReplayResponseSchema.safeParse({
      events: [makeEvent('card.deleted', 4212, { number: 18 })],
      seq: 4212,
    })
    expect(parsed.success).toBe(true)
  })
})
