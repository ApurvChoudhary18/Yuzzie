/**
 * The card view (§8.3) and its overlays, rendered through Ink (§18 Session 9
 * acceptance): no description, a long description, 20 checklist items, 50
 * activity entries, no git link — plus every overlay drawn over it.
 */
import type { Card } from '@yuzie/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  card,
  column,
  git,
  hoursAgo,
  mount,
  NOW,
  person,
  settled,
  tick,
  view,
} from './__tests__/fixtures.js'
import type { ActivityEntry, BoardView } from './layout.js'
import { textWidth } from './text.js'

const mounted: Array<{ unmount(): void }> = []
afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount()
})

const COLUMNS = [
  column('todo', 'Todo', 0, 'backlog'),
  column('doing', 'Doing', 1, 'in_progress'),
  column('done', 'Done', 2, 'terminal'),
]

const item = (position: number, text: string, done: boolean) => ({
  id: `99999999-9999-4999-8999-${String(position).padStart(12, '0')}`,
  position,
  text,
  doneAt: done ? hoursAgo(5) : null,
  doneBy: done ? 'rahul' : null,
})

const FULL = card(18, {
  column: 'doing',
  title: 'Fix GitHub OAuth',
  priority: 1,
  labels: ['bug', 'auth'],
  assignees: ['rahul'],
  watchers: ['priya', 'adarsh'],
  dueAt: '2026-08-21T12:00:00.000Z',
  description:
    'OAuth callback drops the `state` param on redirect, so token exchange fails intermittently. Also needs refresh-token handling.',
  anchor: { path: 'src/auth/oauth.ts', line: 42, endLine: null, commitSha: null, primary: true },
  git: {
    ...(git(3, 7, 1) as NonNullable<Card['git']>),
    branch: 'task/18-fix-github-oauth',
    pushed: true,
    prUrl: 'https://github.com/acme/api/pull/204',
    prState: 'open',
  },
  checklist: [
    item(1, 'Fix callback state handling', true),
    item(2, 'Add token refresh', true),
    item(3, 'Add regression tests', false),
  ],
})

const ACTIVITY: ActivityEntry[] = [
  {
    at: NOW.getTime() - 5 * 3_600_000,
    who: '@rahul',
    text: 'claimed and started task/18-fix-github-oauth',
  },
  {
    at: NOW.getTime() - 4 * 3_600_000,
    who: '@rahul',
    text: 'pushed 3 commits (a3f9c21, 8b21e04, 5c7ba91)',
  },
  {
    at: NOW.getTime() - 3 * 3_600_000,
    who: '@adarsh',
    text: 'commented on #18 Fix GitHub OAuth: "Check the redirect_uri whitelist too — staging differs."',
  },
  {
    at: NOW.getTime() - 2 * 3_600_000,
    who: '@rahul',
    text: 'checked an item on #18 Fix GitHub OAuth',
  },
]

const LONG_DESCRIPTION = Array.from(
  { length: 6 },
  (_, index) =>
    `Paragraph ${index + 1}. The callback handler reads the state parameter from the session, but the session cookie is set with SameSite=Strict, so on the redirect back from GitHub the browser does not send it and the check fails.`,
).join('\n\n')

/** One card on a board, with whatever the view around it needs. */
function boardWith(subject: Card, extra: Partial<BoardView> = {}): BoardView {
  return view(COLUMNS, [subject], [], extra)
}

const CARDS: Record<string, BoardView> = {
  'a full card': boardWith(FULL, {
    presence: [person('adarsh', 18), person('rahul', 18)].map((p) =>
      p.handle === 'adarsh' ? { ...p, state: 'viewing' as const } : p,
    ),
    activity: new Map([[18, ACTIVITY]]),
  }),
  'no description': boardWith({ ...FULL, description: null }, { activity: new Map([[18, []]]) }),
  'a long description': boardWith({ ...FULL, description: LONG_DESCRIPTION }),
  '20 checklist items': boardWith({
    ...FULL,
    checklist: Array.from({ length: 20 }, (_, index) =>
      item(index + 1, `Step ${index + 1}: something that needs doing`, index % 3 === 0),
    ),
  }),
  '50 activity entries': boardWith(FULL, {
    activity: new Map([
      [
        18,
        Array.from({ length: 50 }, (_, index) => ({
          at: NOW.getTime() - (50 - index) * 600_000,
          who: index % 2 === 0 ? '@rahul' : '@priya',
          text: `moved #18 Fix GitHub OAuth → ${index % 2 === 0 ? 'Doing' : 'Review'} (${index + 1})`,
        })),
      ],
    ]),
  }),
  'no git link': boardWith({ ...FULL, git: null, anchor: null }),
}

async function openCard(board: BoardView, columns: number, rows: number) {
  const harness = mount(board, columns, rows)
  mounted.push(harness.instance)
  await tick()
  // The card sits in Doing, the second column.
  harness.keyboard.write('l')
  await tick()
  harness.keyboard.write('\r')
  await settled(harness.terminal)
  return harness
}

async function keys(harness: Awaited<ReturnType<typeof openCard>>, ...pressed: string[]) {
  for (const key of pressed) {
    harness.keyboard.write(key)
    await tick()
  }
  await settled(harness.terminal)
}

function checkShape(frame: string, columns: number, rows: number): string[] {
  const lines = frame.split('\n')
  expect(lines).toHaveLength(rows)
  for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(columns)
  expect(lines[0]).toMatch(/┐$/)
  expect(lines.at(-1)).toMatch(/^└─+┘$/)
  return lines
}

describe('card view snapshots', () => {
  for (const [name, board] of Object.entries(CARDS)) {
    for (const [columns, rows] of [
      [100, 40],
      [80, 24],
    ] as const) {
      it(`${name} at ${columns}×${rows}`, async () => {
        const harness = await openCard(board, columns, rows)
        const top = harness.terminal.lastFrame()
        checkShape(top, columns, rows)
        expect(top).toContain('#18 Fix GitHub OAuth')
        expect(`\n${top}`).toMatchSnapshot()

        // And scrolled to the very end: nothing is cut off or overdrawn.
        for (let press = 0; press < 120; press += 1) {
          harness.keyboard.write('j')
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
        await settled(harness.terminal)
        const end = harness.terminal.lastFrame()
        checkShape(end, columns, rows)
        expect(`\n${end}`).toMatchSnapshot()
      })
    }
  }

  it('shows each panel the spec lists (§8.3)', async () => {
    const harness = await openCard(CARDS['a full card'] as BoardView, 100, 50)
    const frame = harness.terminal.lastFrame()
    for (const text of [
      'STATUS     Doing',
      'ASSIGNEE  @rahul ● working',
      'PRIORITY   p1',
      'WATCHERS  @priya, @adarsh',
      'LABELS     bug · auth',
      'DUE       Fri 21 Aug',
      'DESCRIPTION',
      'CODE       src/auth/oauth.ts:42',
      '[o] open in editor',
      'BRANCH     task/18-fix-github-oauth',
      'GIT        3 commits · 7 files · pushed · PR #204 open',
      'CHECKLIST  2/3',
      '✓  1  Fix callback state handling',
      '○  3  Add regression tests',
      'ACTIVITY',
      '@adarsh commented',
      '● @adarsh is viewing this card',
      'C comment  m move  a assign  e edit  x check  w watch  esc back',
    ])
      expect(frame).toContain(text)
  })

  it('says how to link a branch when there is none, and loads activity lazily', async () => {
    const loading = boardWith({ ...FULL, git: null }, { activity: new Map([[18, null]]) })
    const frame = (await openCard(loading, 100, 50)).terminal.lastFrame()
    expect(frame).toContain('not linked — c to claim')
    expect(frame).toContain('loading…')
  })
})

describe('overlays', () => {
  const board = CARDS['a full card'] as BoardView
  const cases: Array<[string, string[], string]> = [
    ['column picker', ['m', 'j'], 'Move #18 to'],
    ['member picker', ['a'], 'Assign #18'],
    [
      'comment composer',
      ['C', 'L', 'o', 'o', 'k', 's', '\r', 'g', 'o', 'o', 'd'],
      'Comment on #18',
    ],
    ['delete confirmation', ['D'], 'Delete #18 Fix GitHub OAuth?'],
    ['checklist', ['x'], 'Checklist #18'],
    ['new checklist item', ['+', 'T', 'e', 's', 't'], 'New checklist item on #18'],
    ['help', ['?'], 'check off an item'],
  ]
  for (const [name, pressed, expected] of cases) {
    it(`${name} over the card view`, async () => {
      const harness = await openCard(board, 100, 30)
      await keys(harness, ...pressed)
      const frame = harness.terminal.lastFrame()
      checkShape(frame, 100, 30)
      expect(frame).toContain(expected)
      expect(`\n${frame}`).toMatchSnapshot()
    })
  }

  it('new card prompt, search and filter over the board', async () => {
    const harness = mount(board, 100, 30)
    mounted.push(harness.instance)
    await tick()
    await keys(harness, 'n', 'S', 'h', 'i', 'p')
    expect(harness.terminal.lastFrame()).toContain('New card in Todo')
    expect(`\n${harness.terminal.lastFrame()}`).toMatchSnapshot()
    await keys(harness, '\u001b')
    await new Promise((resolve) => setTimeout(resolve, 60))

    await keys(harness, '/', 'o', 'a', 'u', 't', 'h')
    const searching = harness.terminal.lastFrame()
    expect(searching).toContain('/oauth▏')
    expect(searching).toContain('#18 Fix GitHub OAuth')
    await keys(harness, '\r')
    expect(harness.terminal.lastFrame()).toContain('/oauth  esc clears')

    await keys(harness, 'f')
    expect(harness.terminal.lastFrame()).toContain('Assigned to @rahul')
    expect(`\n${harness.terminal.lastFrame()}`).toMatchSnapshot()
  })
})
