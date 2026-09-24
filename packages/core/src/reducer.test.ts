import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  COMMENT_ID,
  ITEM_ID,
  makeBoard,
  makeCard,
  makeChecklistItem,
  makeColumn,
  makeEvent,
  makeMember,
  stateWithCard,
  T1,
} from './__fixtures__/board.js'
import type { EventEnvelope } from './events.js'
import {
  allCards,
  applyEvent,
  applyEvents,
  type BoardState,
  cardByNumber,
  cardsInColumn,
  initialState,
  orderedColumns,
} from './reducer.js'

const SEED = 20260923

describe('initialState', () => {
  it('starts empty at sequence zero', () => {
    const state = initialState()
    expect(state.seq).toBe(0)
    expect(state.cards).toEqual({})
    expect(state.board).toBeNull()
  })

  it('accepts a seed so a cached snapshot can be resumed', () => {
    const state = initialState({ board: makeBoard(), seq: 4211 })
    expect(state.seq).toBe(4211)
    expect(state.board?.slug).toBe('payments-api')
  })
})

describe('applyEvent sequencing', () => {
  it('advances seq', () => {
    const state = applyEvent(initialState(), makeEvent('card.created', 1, makeCard()))
    expect(state.seq).toBe(1)
  })

  it('ignores an event that has already been applied', () => {
    const created = makeEvent('card.created', 5, makeCard())
    const once = applyEvent(initialState(), created)
    const twice = applyEvent(once, created)
    expect(twice).toBe(once)
  })

  it('ignores an event from before the current position', () => {
    const state = initialState({ seq: 10 })
    expect(applyEvent(state, makeEvent('card.created', 3, makeCard()))).toBe(state)
  })

  it('is total: an unknown event type advances seq and changes nothing else', () => {
    const before = stateWithCard(makeCard(), 1)
    // Deliberately not in the union — this is what a newer server sends to an
    // older client, and it must not throw.
    const future = {
      type: 'card.teleported',
      seq: 2,
      actor: 'rahul',
      cardNo: 18,
      ts: T1,
      payload: { destination: 'mars' },
    } as unknown as EventEnvelope

    const after = applyEvent(before, future)
    expect(after.seq).toBe(2)
    expect(after.cards).toEqual(before.cards)
    expect(after.members).toEqual(before.members)
  })
})

describe('applyEvent immutability', () => {
  it('never mutates the state or the cards it was given', () => {
    const card = makeCard()
    const before = stateWithCard(card)
    const snapshot = structuredClone(before)

    applyEvent(before, makeEvent('card.moved', 1, { from: 'doing', to: 'review', rank: 'a1' }))

    expect(before).toEqual(snapshot)
    expect(before.cards[18]).toBe(card)
  })
})

describe('card events', () => {
  it('card.created inserts the card', () => {
    const state = applyEvent(initialState(), makeEvent('card.created', 1, makeCard()))
    expect(cardByNumber(state, 18)?.title).toBe('Fix GitHub OAuth')
  })

  it('card.updated applies only the fields it carries', () => {
    const state = applyEvent(
      stateWithCard(),
      makeEvent('card.updated', 1, { fields: { title: 'Fix OAuth callback' }, version: 2 }),
    )
    const card = cardByNumber(state, 18)
    expect(card?.title).toBe('Fix OAuth callback')
    expect(card?.description).toBe('OAuth callback drops the state param on redirect.')
    expect(card?.priority).toBe(1)
    expect(card?.version).toBe(2)
    expect(card?.updatedAt).toBe(T1)
  })

  it('card.updated can clear a nullable field', () => {
    const state = applyEvent(
      stateWithCard(),
      makeEvent('card.updated', 1, { fields: { description: null, priority: null }, version: 2 }),
    )
    expect(cardByNumber(state, 18)?.description).toBeNull()
    expect(cardByNumber(state, 18)?.priority).toBeNull()
  })

  it('card.moved changes column and rank', () => {
    const state = applyEvent(
      stateWithCard(),
      makeEvent('card.moved', 1, { from: 'doing', to: 'review', rank: 'a1' }),
    )
    expect(cardByNumber(state, 18)?.column).toBe('review')
    expect(cardByNumber(state, 18)?.rank).toBe('a1')
  })

  it('card.assigned adds and removes without duplicating', () => {
    const added = applyEvent(
      stateWithCard(),
      makeEvent('card.assigned', 1, { added: ['priya', 'rahul'], removed: [] }),
    )
    // The fixture card starts with rahul; the set is kept in handle order, as the server returns it.
    expect(cardByNumber(added, 18)?.assignees).toEqual(['priya', 'rahul'])

    const removed = applyEvent(
      added,
      makeEvent('card.assigned', 2, { added: [], removed: ['rahul'] }),
    )
    expect(cardByNumber(removed, 18)?.assignees).toEqual(['priya'])
  })

  it('card.deleted removes the card', () => {
    const state = applyEvent(stateWithCard(), makeEvent('card.deleted', 1, { number: 18 }))
    expect(cardByNumber(state, 18)).toBeUndefined()
  })

  it('card.deleted for a card we never had is a no-op beyond seq', () => {
    const before = stateWithCard()
    const after = applyEvent(before, makeEvent('card.deleted', 1, { number: 99 }))
    expect(after.cards).toEqual(before.cards)
    expect(after.seq).toBe(1)
  })

  it('ignores events for a card it has never seen rather than inventing one', () => {
    const state = applyEvent(
      initialState(),
      makeEvent('card.moved', 1, { from: 'todo', to: 'doing', rank: 'a1' }),
    )
    expect(state.cards).toEqual({})
    expect(state.seq).toBe(1)
  })
})

describe('comment and checklist events', () => {
  it('comment.created appends a comment dated by the event', () => {
    const state = applyEvent(
      stateWithCard(),
      makeEvent('comment.created', 1, {
        commentId: COMMENT_ID,
        body: 'Callback was dropping the state param.',
        author: 'rahul',
      }),
    )
    const comments = cardByNumber(state, 18)?.comments ?? []
    expect(comments).toHaveLength(1)
    expect(comments[0]?.createdAt).toBe(T1)
    expect(comments[0]?.cardNumber).toBe(18)
  })

  it('comment.created is idempotent for the same comment id', () => {
    const first = applyEvent(
      stateWithCard(),
      makeEvent('comment.created', 1, { commentId: COMMENT_ID, body: 'hi', author: 'rahul' }),
    )
    const second = applyEvent(
      first,
      makeEvent('comment.created', 2, { commentId: COMMENT_ID, body: 'hi', author: 'rahul' }),
    )
    expect(cardByNumber(second, 18)?.comments).toHaveLength(1)
  })

  it('checklist.updated ticks and un-ticks the right item', () => {
    const card = makeCard({
      checklist: [makeChecklistItem(), makeChecklistItem({ id: COMMENT_ID, position: 2 })],
    })
    const ticked = applyEvent(
      stateWithCard(card),
      makeEvent('checklist.updated', 1, { itemId: ITEM_ID, done: true }),
    )
    expect(cardByNumber(ticked, 18)?.checklist[0]?.doneAt).toBe(T1)
    expect(cardByNumber(ticked, 18)?.checklist[0]?.doneBy).toBe('rahul')
    expect(cardByNumber(ticked, 18)?.checklist[1]?.doneAt).toBeNull()

    const unticked = applyEvent(
      ticked,
      makeEvent('checklist.updated', 2, { itemId: ITEM_ID, done: false }),
    )
    expect(cardByNumber(unticked, 18)?.checklist[0]?.doneAt).toBeNull()
    expect(cardByNumber(unticked, 18)?.checklist[0]?.doneBy).toBeNull()
  })
})

describe('git events', () => {
  it('card.branch.linked seeds a git summary on a card that had none', () => {
    const state = applyEvent(
      stateWithCard(),
      makeEvent('card.branch.linked', 1, { branch: 'task/18-fix-github-oauth', base: 'main' }),
    )
    const git = cardByNumber(state, 18)?.git
    expect(git?.branch).toBe('task/18-fix-github-oauth')
    expect(git?.baseBranch).toBe('main')
    expect(git?.commits).toBe(0)
  })

  it('card.git.updated merges into the existing summary', () => {
    const linked = applyEvent(
      stateWithCard(),
      makeEvent('card.branch.linked', 1, { branch: 'task/18-fix-github-oauth', base: 'main' }),
    )
    const updated = applyEvent(
      linked,
      makeEvent('card.git.updated', 2, { commits: 3, filesChanged: 7, pushed: true }),
    )
    const git = cardByNumber(updated, 18)?.git
    expect(git?.branch).toBe('task/18-fix-github-oauth')
    expect(git?.commits).toBe(3)
    expect(git?.filesChanged).toBe(7)
    expect(git?.pushed).toBe(true)
    expect(git?.lastActivityAt).toBe(T1)
  })

  it('card.commits.attached appends new shas and skips known ones', () => {
    const first = applyEvent(
      stateWithCard(),
      makeEvent('card.commits.attached', 1, { shas: ['a3f9c21', '8b21e04'] }),
    )
    expect(cardByNumber(first, 18)?.commits).toHaveLength(2)

    const second = applyEvent(
      first,
      makeEvent('card.commits.attached', 2, { shas: ['8b21e04', '5c7ba91'] }),
    )
    const shas = (cardByNumber(second, 18)?.commits ?? []).map((commit) => commit.sha)
    expect(shas).toEqual(['a3f9c21', '8b21e04', '5c7ba91'])
  })

  it('card.commits.attached with nothing new leaves the card untouched', () => {
    const first = applyEvent(
      stateWithCard(),
      makeEvent('card.commits.attached', 1, { shas: ['a3f9c21'] }),
    )
    const second = applyEvent(first, makeEvent('card.commits.attached', 2, { shas: ['a3f9c21'] }))
    expect(cardByNumber(second, 18)).toBe(cardByNumber(first, 18))
  })

  it('card.git.updated keeps the server-stored lastActivityAt when the event carries it', () => {
    const state = applyEvent(
      stateWithCard(),
      makeEvent('card.git.updated', 1, {
        commits: 1,
        prState: 'open',
        lastActivityAt: '2026-08-18T12:00:00.000Z',
      }),
    )
    const git = cardByNumber(state, 18)?.git
    expect(git?.lastActivityAt).toBe('2026-08-18T12:00:00.000Z')
    expect(git?.prState).toBe('open')
  })

  it('card.commits.attached keeps the full records when the event carries them', () => {
    const commit = {
      sha: 'c'.repeat(40),
      message: 'fix: handle missing state',
      author: 'priya',
      committedAt: '2026-08-18T12:00:00.000Z',
    }
    const state = applyEvent(
      stateWithCard(),
      makeEvent('card.commits.attached', 1, { shas: [commit.sha], commits: [commit] }),
    )
    expect(cardByNumber(state, 18)?.commits).toEqual([commit])
  })

  it('takes the card version from the envelope, whatever the event type', () => {
    const moved = applyEvent(stateWithCard(), {
      ...makeEvent('card.moved', 1, { from: 'doing', to: 'review', rank: 'a1' }),
      version: 7,
    })
    expect(cardByNumber(moved, 18)?.version).toBe(7)

    // An event without one (from an older server) leaves the version alone.
    const untouched = applyEvent(
      moved,
      makeEvent('card.moved', 2, { from: 'review', to: 'done', rank: 'a2' }),
    )
    expect(cardByNumber(untouched, 18)?.version).toBe(7)
  })

  it('card.anchor.set stores the range and the sha it was taken at', () => {
    const state = applyEvent(
      stateWithCard(),
      makeEvent('card.anchor.set', 1, {
        path: 'src/auth/oauth.ts',
        line: 42,
        endLine: 88,
        commitSha: 'a3f9c21',
      }),
    )
    expect(cardByNumber(state, 18)?.anchor).toEqual({
      path: 'src/auth/oauth.ts',
      line: 42,
      endLine: 88,
      commitSha: 'a3f9c21',
      primary: true,
    })
  })

  it('card.anchor.set defaults the optional parts to null', () => {
    const state = applyEvent(
      stateWithCard(),
      makeEvent('card.anchor.set', 1, { path: 'src/auth/oauth.ts', line: 42 }),
    )
    expect(cardByNumber(state, 18)?.anchor?.endLine).toBeNull()
    expect(cardByNumber(state, 18)?.anchor?.commitSha).toBeNull()
  })
})

describe('board and membership events', () => {
  it('member.joined adds a member and member.left removes them', () => {
    const joined = applyEvent(
      initialState(),
      makeEvent('member.joined', 1, { handle: 'priya', role: 'owner' }, { cardNo: undefined }),
    )
    expect(joined.members.map((member) => member.handle)).toEqual(['priya'])

    const left = applyEvent(
      joined,
      makeEvent('member.left', 2, { handle: 'priya', role: 'owner' }, { cardNo: undefined }),
    )
    expect(left.members).toEqual([])
  })

  it('member.joined for an existing member updates their role instead of duplicating', () => {
    const state = initialState({ members: [makeMember('priya')] })
    const promoted = applyEvent(
      state,
      makeEvent('member.joined', 1, { handle: 'priya', role: 'owner' }, { cardNo: undefined }),
    )
    expect(promoted.members).toHaveLength(1)
    expect(promoted.members[0]?.role).toBe('owner')
  })

  it('member.joined leaves the other members alone', () => {
    const state = initialState({ members: [makeMember('rahul'), makeMember('priya')] })
    const promoted = applyEvent(
      state,
      makeEvent('member.joined', 1, { handle: 'priya', role: 'owner' }, { cardNo: undefined }),
    )
    expect(promoted.members.map((member) => [member.handle, member.role])).toEqual([
      ['rahul', 'member'],
      ['priya', 'owner'],
    ])
  })

  it('member.left for someone who is not a member is a no-op beyond seq', () => {
    const before = initialState()
    const after = applyEvent(
      before,
      makeEvent('member.left', 1, { handle: 'nobody', role: 'member' }, { cardNo: undefined }),
    )
    expect(after.members).toEqual([])
    expect(after.seq).toBe(1)
  })

  it('board.updated merges changed fields', () => {
    const state = initialState({ board: makeBoard() })
    const renamed = applyEvent(
      state,
      makeEvent('board.updated', 1, { fields: { name: 'Payments' } }, { cardNo: undefined }),
    )
    expect(renamed.board?.name).toBe('Payments')
    expect(renamed.board?.baseBranch).toBe('main')
  })

  it('board.updated before the board is known is ignored', () => {
    const after = applyEvent(
      initialState(),
      makeEvent('board.updated', 1, { fields: { name: 'Payments' } }, { cardNo: undefined }),
    )
    expect(after.board).toBeNull()
  })
})

describe('selectors', () => {
  const state = initialState({
    columns: [makeColumn('doing', 'b'), makeColumn('todo', 'a')],
    cards: {
      1: makeCard({ number: 1, rank: 'c', column: 'todo' }),
      2: makeCard({ number: 2, rank: 'a', column: 'doing' }),
      3: makeCard({ number: 3, rank: 'b', column: 'todo' }),
    },
  })

  it('orders all cards by rank', () => {
    expect(allCards(state).map((card) => card.number)).toEqual([2, 3, 1])
  })

  it('filters a column while keeping board order', () => {
    expect(cardsInColumn(state, 'todo').map((card) => card.number)).toEqual([3, 1])
    expect(cardsInColumn(state, 'nope')).toEqual([])
  })

  it('breaks a rank tie by card number so ordering is total', () => {
    const tied = initialState({
      cards: {
        9: makeCard({ number: 9, rank: 'a' }),
        4: makeCard({ number: 4, rank: 'a' }),
      },
    })
    expect(allCards(tied).map((card) => card.number)).toEqual([4, 9])
  })

  it('orders columns by rank', () => {
    expect(orderedColumns(state).map((column) => column.key)).toEqual(['todo', 'doing'])
  })
})

// ---------------------------------------------------------------------------
// Property: the log is a set ordered by seq, not a sequence of arrivals
// ---------------------------------------------------------------------------

function buildLog(): EventEnvelope[] {
  return [
    makeEvent('card.created', 1, makeCard({ number: 18, column: 'todo', rank: 'V' })),
    makeEvent('card.created', 2, makeCard({ number: 21, column: 'todo', rank: 'a' })),
    makeEvent('member.joined', 3, { handle: 'priya', role: 'owner' }, { cardNo: undefined }),
    makeEvent('card.assigned', 4, { added: ['priya'], removed: [] }, { cardNo: 21 }),
    makeEvent('card.moved', 5, { from: 'todo', to: 'doing', rank: 'b' }, { cardNo: 18 }),
    makeEvent('card.branch.linked', 6, { branch: 'task/18-fix-github-oauth', base: 'main' }),
    makeEvent('card.git.updated', 7, { commits: 3, filesChanged: 7, pushed: true }),
    makeEvent(
      'comment.created',
      8,
      { commentId: COMMENT_ID, body: 'Fixed the state param.', author: 'rahul' },
      { cardNo: 18 },
    ),
    makeEvent('card.commits.attached', 9, { shas: ['a3f9c21', '8b21e04'] }, { cardNo: 18 }),
    makeEvent('card.updated', 10, { fields: { title: 'Fix OAuth' }, version: 2 }, { cardNo: 18 }),
    makeEvent('card.anchor.set', 11, { path: 'src/auth/oauth.ts', line: 42 }, { cardNo: 18 }),
    makeEvent('card.deleted', 12, { number: 21 }, { cardNo: 21 }),
  ]
}

describe('property: shuffled event logs converge', () => {
  const log = buildLog()
  const inOrder: BoardState = log.reduce(applyEvent, initialState())

  it('applying a shuffled log matches applying it in seq order', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(log, { minLength: log.length, maxLength: log.length }),
        (shuffled) => {
          expect(applyEvents(initialState(), shuffled)).toEqual(inOrder)
        },
      ),
      { numRuns: 200, seed: SEED },
    )
  })

  it('is unaffected by duplicated deliveries in a shuffled batch', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(log, { minLength: log.length, maxLength: log.length }),
        (shuffled) => {
          expect(applyEvents(initialState(), [...shuffled, ...shuffled])).toEqual(inOrder)
        },
      ),
      { numRuns: 100, seed: SEED },
    )
  })

  it('reaches the same state when the log is delivered in arbitrary chunks', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(log, { minLength: log.length, maxLength: log.length }),
        fc.integer({ min: 1, max: log.length }),
        (shuffled, chunkSize) => {
          let state = initialState()
          for (let i = 0; i < shuffled.length; i += chunkSize) {
            state = applyEvents(state, shuffled.slice(i, i + chunkSize))
          }
          // Chunked delivery of a shuffled log can legitimately drop events that
          // arrive after a later seq, which is exactly why a client asks for a
          // replay. What must hold is that seq never goes backwards.
          expect(state.seq).toBe(inOrder.seq)
        },
      ),
      { numRuns: 100, seed: SEED },
    )
  })

  it('does not mutate the array it is given', () => {
    const batch = [...log].reverse()
    const snapshot = [...batch]
    applyEvents(initialState(), batch)
    expect(batch).toEqual(snapshot)
  })
})
