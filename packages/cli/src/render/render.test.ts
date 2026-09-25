import type { Card, Column, EventEnvelope, Presence } from '@yuzie/core'
import { initialState } from '@yuzie/core'
import { describe, expect, it } from 'vitest'
import { renderCardDetail, renderCardList } from './cards.js'
import { actor, describeEvent } from './events.js'
import { ago, shortAge, truncate, width } from './text.js'

const NOW = new Date('2026-08-19T12:00:00.000Z')
const BOARD_ID = '11111111-1111-4111-8111-111111111111'
const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString()

function column(
  key: string,
  name: string,
  rank: string,
  semantics: Column['semantics'] = null,
): Column {
  return {
    id: `66666666-6666-4666-8666-${rank.padStart(12, '0')}`,
    boardId: BOARD_ID,
    key,
    name,
    rank,
    semantics,
    wipLimit: null,
  }
}

const COLUMNS = [
  column('todo', 'Todo', 'a', 'backlog'),
  column('doing', 'Doing', 'b', 'in_progress'),
  column('review', 'Review', 'c', 'review'),
  column('done', 'Done', 'd', 'terminal'),
]

function card(number: number, overrides: Partial<Card>): Card {
  return {
    id: `33333333-3333-4333-8333-${String(number).padStart(12, '0')}`,
    boardId: BOARD_ID,
    number,
    column: 'todo',
    rank: 'a',
    title: `Card ${number}`,
    description: null,
    priority: null,
    dueAt: null,
    assignees: [],
    labels: [],
    watchers: [],
    checklist: [],
    comments: [],
    commits: [],
    git: null,
    anchor: null,
    createdBy: 'rahul',
    archivedAt: null,
    createdAt: minutes(60 * 24 * 10),
    updatedAt: minutes(60),
    version: 1,
    ...overrides,
  }
}

function git(branch: string, lastActivityAt: string): Card['git'] {
  return {
    branch,
    baseBranch: 'main',
    commits: 3,
    filesChanged: 7,
    additions: 0,
    deletions: 0,
    pushed: false,
    prUrl: null,
    prState: null,
    lastActivityAt,
  }
}

function person(handle: string, state: Presence['state'], cardNo: number | null = null): Presence {
  return { handle, kind: 'human', state, cardNo, branch: null, since: null }
}

/** The four cards behind the §7.3 sample, in the order the sample shows them. */
const SAMPLE_CARDS = [
  card(18, {
    title: 'Fix GitHub OAuth',
    column: 'doing',
    assignees: ['rahul'],
    updatedAt: minutes(60),
    git: git('task/18-fix-github-oauth', minutes(2)),
  }),
  card(21, {
    title: 'Fix websocket reconnect',
    column: 'doing',
    assignees: ['adarsh'],
    updatedAt: minutes(60 * 3),
    git: git('task/21-websocket', minutes(60 * 5)),
  }),
  card(13, {
    title: 'Write tests for auth',
    column: 'todo',
    assignees: ['priya'],
    updatedAt: minutes(60 * 24),
  }),
  card(15, {
    title: 'Login flow',
    column: 'done',
    assignees: ['priya'],
    updatedAt: minutes(60 * 48),
    git: git('task/15-login-flow', minutes(60 * 72)),
  }),
]

const SAMPLE_PRESENCE = [
  person('rahul', 'working', 18),
  person('priya', 'online'),
  person('sam', 'viewing', 13),
]

/** SPEC.md §7.3, copied exactly. */
const SAMPLE = `#    TITLE                     ASSIGNEE   COLUMN    BRANCH                 ACT
18   Fix GitHub OAuth          @rahul  ●  Doing     task/18-fix-github…    2m
21   Fix websocket reconnect   @adarsh    Doing     task/21-websocket      3h
13   Write tests for auth      @priya     Todo      —                      1d
15   Login flow                @priya  ✓  Done      task/15-login-flow     2d

4 cards · 3 online · synced
`

describe('yuzie list (§7.3)', () => {
  it('matches the sample byte for byte at 80 columns', () => {
    const output = renderCardList(SAMPLE_CARDS, {
      columns: COLUMNS,
      presence: SAMPLE_PRESENCE,
      now: NOW,
      width: 80,
      status: 'synced',
    })
    expect(output).toBe(SAMPLE)
  })

  it('gives a wider terminal’s room to the title, and never exceeds the width', () => {
    const long = card(7, {
      title: 'A'.repeat(80),
      column: 'doing',
      git: git(`task/7-${'b'.repeat(60)}`, minutes(1)),
    })
    for (const total of [60, 80, 100, 140]) {
      const lines = renderCardList([long], {
        columns: COLUMNS,
        presence: [],
        now: NOW,
        width: total,
        status: 'synced',
      })
        .split('\n')
        .filter((line) => line.startsWith('7 '))
      expect(width(lines[0] ?? ''), `width ${total}`).toBeLessThanOrEqual(total)
    }
    const wide = renderCardList([long], {
      columns: COLUMNS,
      presence: [],
      now: NOW,
      width: 120,
      status: 'synced',
    })
    expect(wide).toContain(`${'A'.repeat(50)}…`)
  })

  it('shows more than one assignee compactly', () => {
    const shared = card(9, { assignees: ['rahul', 'priya'] })
    const output = renderCardList([shared], {
      columns: COLUMNS,
      presence: [],
      now: NOW,
      width: 80,
      status: 'synced',
    })
    expect(output).toContain('@rahul+1')
  })
})

describe('yuzie card (§6.6)', () => {
  it('shows branch and code the way Journey F does', () => {
    const output = renderCardDetail(
      card(18, {
        title: 'Fix GitHub OAuth',
        column: 'doing',
        assignees: ['rahul'],
        priority: 1,
        labels: ['bug', 'auth'],
        description: 'The callback 500s.',
        git: git('task/18-fix-github-oauth', minutes(2)),
        anchor: {
          path: 'src/auth/oauth.ts',
          line: 42,
          endLine: null,
          commitSha: null,
          primary: true,
        },
        checklist: [
          {
            id: '44444444-4444-4444-8444-444444444441',
            position: 1,
            text: 'Reproduce',
            doneAt: minutes(5),
            doneBy: 'rahul',
          },
          {
            id: '44444444-4444-4444-8444-444444444442',
            position: 2,
            text: 'Fix',
            doneAt: null,
            doneBy: null,
          },
        ],
      }),
      { columns: COLUMNS, presence: [person('rahul', 'working', 18)], now: NOW },
    )
    expect(output).toContain('#18  Fix GitHub OAuth\nDoing · @rahul · p1 · bug, auth\n')
    expect(output).toContain('● @rahul is working on this')
    expect(output).toContain('Branch  task/18-fix-github-oauth  (3 commits · 7 files)')
    expect(output).toContain('Code    src/auth/oauth.ts:42')
    expect(output).toContain('Checklist  1/2\n  ✓ 1. Reproduce\n  ○ 2. Fix')
    expect(output).toContain('The callback 500s.')
  })
})

describe('event lines', () => {
  it('reads like Journey D: "@priya moved #15 Login flow → Done"', () => {
    const state = initialState({ columns: COLUMNS, cards: { 15: SAMPLE_CARDS[3] as Card } })
    const event: EventEnvelope = {
      seq: 9,
      type: 'card.moved',
      actor: 'priya',
      cardNo: 15,
      payload: { from: 'review', to: 'done', rank: 'z' },
      ts: NOW.toISOString(),
    }
    expect(`${actor(event)} ${describeEvent(event, state)}`).toBe(
      '@priya moved #15 Login flow → Done',
    )
  })
})

describe('text helpers', () => {
  it('formats ages the way ACT does', () => {
    expect(
      [5_000, 120_000, 3 * 3_600_000, 86_400_000, 9 * 86_400_000, 40 * 86_400_000].map(shortAge),
    ).toEqual(['5s', '2m', '3h', '1d', '1w', '1mo'])
    expect(ago(3_000)).toBe('just now')
  })

  it('truncates by character, with an ellipsis', () => {
    expect(truncate('task/18-fix-github-oauth', 19)).toBe('task/18-fix-github…')
    expect(truncate('short', 19)).toBe('short')
    expect(width('●✓…')).toBe(3)
  })
})
