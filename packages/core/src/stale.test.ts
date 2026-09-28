import { describe, expect, it } from 'vitest'
import { makeCard, makeColumn, makeEvent } from './__fixtures__/board.js'
import { claimTimes, isStale, lastProgressAt } from './stale.js'

const DAY = 86_400_000
const columns = [
  makeColumn('todo', 'a'),
  makeColumn('doing', 'b', { semantics: 'in_progress' }),
  makeColumn('done', 'c', { semantics: 'terminal' }),
]
const now = Date.parse('2026-08-20T09:00:00Z')
const ago = (days: number) => new Date(now - days * DAY).toISOString()

describe('isStale', () => {
  it('claimed N days ago with no commits since is stale', () => {
    const card = makeCard({ updatedAt: ago(0) })
    const context = { now, columns, claimedAt: now - 3 * DAY }
    expect(isStale(card, 2 * DAY, context)).toBe(true)
    expect(isStale(card, 4 * DAY, context)).toBe(false)
  })

  it('a commit after the claim resets the clock', () => {
    const card = makeCard({
      git: {
        branch: 'task/18-x',
        baseBranch: 'main',
        commits: 1,
        filesChanged: 1,
        additions: 1,
        deletions: 0,
        pushed: false,
        prUrl: null,
        prState: null,
        lastActivityAt: ago(1),
      },
    })
    expect(isStale(card, 2 * DAY, { now, columns, claimedAt: now - 3 * DAY })).toBe(false)
    expect(lastProgressAt(card, { now, columns, claimedAt: now - 3 * DAY })).toBe(now - DAY)
  })

  it('other unfinished cards go by their last update; finished ones never go stale', () => {
    expect(
      isStale(makeCard({ column: 'todo', updatedAt: ago(5) }), 2 * DAY, { now, columns }),
    ).toBe(true)
    expect(isStale(makeCard({ column: 'done', updatedAt: ago(50) }), DAY, { now, columns })).toBe(
      false,
    )
  })
})

describe('claimTimes', () => {
  it('takes the latest move into progress or assignment per card', () => {
    const events = [
      makeEvent('card.moved', 1, { from: 'todo', to: 'doing', rank: 'V' }, { ts: ago(5) }),
      makeEvent('card.assigned', 2, { added: ['rahul'], removed: [] }, { ts: ago(3) }),
      makeEvent('card.moved', 3, { from: 'doing', to: 'todo', rank: 'V' }, { ts: ago(1) }),
      makeEvent('card.assigned', 4, { added: [], removed: ['rahul'] }, { ts: ago(0) }),
    ]
    expect(claimTimes(events, columns).get(18)).toBe(now - 3 * DAY)
  })
})
