import type { Board, Member } from '@yuzie/core'
import { describe, expect, it } from 'vitest'
import {
  type BoardExport,
  formatOf,
  parseCsv,
  parseCsvRows,
  parseJson,
  parseMarkdown,
  plan,
  toCsv,
  toMarkdown,
} from './transfer.js'
import { card, column } from './tui/__tests__/fixtures.js'

const columns = [
  column('todo', 'Todo', 0, 'backlog'),
  column('doing', 'Doing', 1, 'in_progress'),
  column('review', 'Review', 2, 'review'),
  column('done', 'Done', 3, 'terminal'),
]
const members: Member[] = [
  { handle: 'rahul', displayName: null, kind: 'human', role: 'owner', lastSeenAt: null },
  { handle: 'priya', displayName: null, kind: 'human', role: 'member', lastSeenAt: null },
]

const dump: BoardExport = {
  apiVersion: 'yuzie/v1',
  kind: 'BoardExport',
  exportedAt: '2026-10-02T10:00:00.000Z',
  board: { slug: 'payments-api', name: 'payments-api' } as Board,
  columns,
  labels: [],
  members,
  cards: [
    card(4, {
      title: 'Fix GitHub OAuth, again',
      column: 'doing',
      assignees: ['rahul'],
      priority: 0,
      labels: ['auth'],
      dueAt: '2026-10-10T12:00:00.000Z',
      description: 'The callback drops "state".\nSecond line.',
      checklist: [
        {
          id: 'a',
          position: 1,
          text: 'Reproduce',
          doneAt: '2026-10-01T00:00:00.000Z',
          doneBy: 'rahul',
        },
        { id: 'b', position: 2, text: 'Fix', doneAt: null, doneBy: null },
      ],
    }),
    card(7, { title: 'Ship the CLI', column: 'done' }),
    card(9, { title: 'Archived', archivedAt: '2026-09-01T00:00:00.000Z' }),
  ],
  events: [],
}

describe('export formats (§7.2)', () => {
  it('markdown: columns, facts, description, checklist; archived cards left out', () => {
    expect(toMarkdown(dump)).toBe(`# payments-api

<!-- yuzie export of payments-api, 2026-10-02T10:00:00.000Z -->

## Todo

## Doing

- [ ] Fix GitHub OAuth, again (#4, @rahul, p0, auth, due 2026-10-10)
  > The callback drops "state".
  > Second line.
  - [x] Reproduce
  - [ ] Fix

## Review

## Done

- [x] Ship the CLI (#7)
`)
  })

  it('csv: one row per card, quoted where it must be', () => {
    const rows = parseCsvRows(toCsv(dump))
    expect(rows[0]).toEqual([
      'number',
      'title',
      'column',
      'assignees',
      'labels',
      'priority',
      'due',
      'description',
      'checklist',
      'created',
      'updated',
    ])
    expect(rows[1]?.slice(0, 9)).toEqual([
      '4',
      'Fix GitHub OAuth, again',
      'doing',
      '@rahul',
      'auth',
      'p0',
      '2026-10-10',
      'The callback drops "state".\nSecond line.',
      '1/2',
    ])
    expect(rows).toHaveLength(3)
  })

  it('knows formats by extension', () => {
    expect(formatOf('board.JSON')).toBe('json')
    expect(formatOf('cards.markdown')).toBe('md')
    expect(formatOf('x.csv')).toBe('csv')
    expect(formatOf('notes.txt')).toBe(null)
  })
})

describe('import formats (§7.2)', () => {
  it('markdown round-trips what export writes', () => {
    const drafts = parseMarkdown(toMarkdown(dump))
    expect(drafts).toEqual([
      {
        title: 'Fix GitHub OAuth, again',
        column: 'Doing',
        done: false,
        assignees: ['rahul'],
        labels: ['auth'],
        priority: 0,
        due: '2026-10-10',
        description: 'The callback drops "state".\nSecond line.',
        checklist: [
          { text: 'Reproduce', done: true },
          { text: 'Fix', done: false },
        ],
      },
      { title: 'Ship the CLI', column: 'Done', done: true },
    ])
  })

  it('a plain markdown checklist: ticked items with no column are done', () => {
    const drafts = parseMarkdown(
      '# Launch\n\n- [ ] Write the docs\n- [x] Pick a name\n* Tweet it\n',
    )
    const { items } = plan(drafts, { columns, members })
    expect(items.map((item) => [item.title, item.column])).toEqual([
      ['Write the docs', 'todo'],
      ['Pick a name', 'done'],
      ['Tweet it', 'todo'],
    ])
  })

  it('csv by header name, in any order, with aliases', () => {
    const drafts = parseCsv(
      'Status,Title,Assignee,Tags,Priority,Due Date\nreview,"Cache, snapshots",@priya,perf;api,P2,2026-11-01\n,Blank status,,,,\n',
    )
    expect(drafts).toEqual([
      {
        title: 'Cache, snapshots',
        column: 'review',
        assignees: ['priya'],
        labels: ['perf', 'api'],
        priority: 2,
        due: '2026-11-01',
      },
      { title: 'Blank status' },
    ])
    expect(() => parseCsv('name2,x\n1,2\n')).toThrow('no "title" column')
  })

  it('json: our own export, or a bare array', () => {
    const own = parseJson(JSON.stringify(dump))
    expect(own.map((draft) => draft.title)).toEqual(['Fix GitHub OAuth, again', 'Ship the CLI'])
    expect(own[0]?.checklist).toEqual([
      { text: 'Reproduce', done: true },
      { text: 'Fix', done: false },
    ])
    expect(parseJson('["Just a title", {"title": "With status", "status": "done"}]')).toEqual([
      { title: 'Just a title' },
      { title: 'With status', column: 'done' },
    ])
    expect(() => parseJson('{"nope": 1}')).toThrow('yuzie export')
  })

  it('fits drafts to the board, and says what it could not keep', () => {
    const { items, warnings } = plan(
      [
        { title: 'A', column: 'Backlog', assignees: ['rahul', 'stranger'] },
        { title: 'B', column: 'rev', due: 'someday' },
        { title: 'C', column: 'Backlog' },
      ],
      { columns, members },
      'doing',
    )
    expect(items).toEqual([
      { title: 'A', column: 'doing', assignees: ['rahul'] },
      { title: 'B', column: 'review' },
      { title: 'C', column: 'doing' },
    ])
    expect(warnings).toEqual([
      '"B": cannot read the due date "someday"; left unset',
      'no column "Backlog" on this board: 2 cards to Doing',
      'not members of this board, so not assigned: @stranger',
    ])
    expect(() => plan([{ title: 'x' }], { columns, members }, 'nowhere')).toThrow('nowhere')
  })
})
