/**
 * Boards for the TUI tests, and a sized Ink harness: ink-testing-library's
 * stdout is always 100 columns wide, and the snapshots need 80, 100 and 160.
 */
import { EventEmitter } from 'node:events'
import type { Card, Column, Presence } from '@yuzie/core'
import { render } from 'ink'
import { createElement } from 'react'
import { App, type BoardSource } from '../App.js'
import { type BoardView, viewColumns } from '../layout.js'
import type { Effect } from '../state.js'
import { makeTheme } from '../theme.js'

export const NOW = new Date('2026-08-19T12:00:00.000Z')
const BOARD_ID = '11111111-1111-4111-8111-111111111111'
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()

export function column(
  key: string,
  name: string,
  index: number,
  semantics: Column['semantics'] = null,
  wipLimit: number | null = null,
): Column {
  return {
    id: `66666666-6666-4666-8666-${String(index).padStart(12, '0')}`,
    boardId: BOARD_ID,
    key,
    name,
    rank: String.fromCharCode(97 + index),
    semantics,
    wipLimit,
  }
}

export function card(number: number, overrides: Partial<Card> = {}): Card {
  return {
    id: `33333333-3333-4333-8333-${String(number).padStart(12, '0')}`,
    boardId: BOARD_ID,
    number,
    column: 'todo',
    rank: `a${String(number).padStart(4, '0')}`,
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
    createdAt: hoursAgo(24 * 10),
    updatedAt: hoursAgo(2),
    version: 1,
    ...overrides,
  }
}

function git(commits: number, filesChanged: number, idleHours: number): Card['git'] {
  return {
    branch: 'feat/x',
    baseBranch: 'main',
    commits,
    filesChanged,
    additions: 0,
    deletions: 0,
    pushed: false,
    prUrl: null,
    prState: null,
    lastActivityAt: hoursAgo(idleHours),
  }
}

const person = (handle: string, cardNo: number | null): Presence => ({
  handle,
  kind: 'human',
  state: cardNo === null ? 'online' : 'working',
  cardNo,
  branch: null,
  since: null,
})

function view(columns: Column[], cards: Card[], presence: Presence[] = []): BoardView {
  return {
    slug: 'yuzie-dev',
    columns: viewColumns(columns, cards),
    presence,
    connection: 'live',
    queued: 0,
    toast: null,
    now: NOW.getTime(),
  }
}

const STANDARD = [
  column('todo', 'Todo', 0, 'backlog'),
  column('doing', 'Doing', 1, 'in_progress', 2),
  column('done', 'Done', 2, 'terminal'),
]

/** The four boards of the §18 Session 8 snapshot matrix. */
export const FIXTURES: Record<string, BoardView> = {
  empty: view(STANDARD, []),

  'three columns': view(
    STANDARD,
    [
      card(12, { title: 'Fix login redirect loop', priority: 1, labels: ['bug', 'auth'] }),
      card(14, { title: 'Write the onboarding guide for new contributors' }),
      card(15, {
        column: 'doing',
        title: 'Rate-limit the public API',
        assignees: ['priya'],
        git: git(3, 7, 2),
      }),
      card(18, {
        column: 'doing',
        title: 'Retry webhook deliveries with backoff',
        assignees: ['rahul', 'sam'],
        labels: ['infra'],
        updatedAt: hoursAgo(24 * 4),
        git: git(1, 2, 24 * 4),
      }),
      card(9, { column: 'done', title: 'Ship v0.1', updatedAt: hoursAgo(30) }),
    ],
    [person('priya', 15), person('rahul', null)],
  ),

  'twelve columns': view(
    Array.from({ length: 12 }, (_, index) => column(`c${index}`, `Stage ${index + 1}`, index)),
    Array.from({ length: 24 }, (_, index) =>
      card(index + 1, {
        column: `c${index % 12}`,
        title: `Task ${index + 1} in stage ${(index % 12) + 1}`,
      }),
    ),
  ),

  '200-card column': view(
    STANDARD,
    Array.from({ length: 200 }, (_, index) =>
      card(index + 1, { title: `Backlog item ${index + 1}` }),
    ),
  ),
}

export const SIZES = [
  [80, 24],
  [100, 30],
  [160, 50],
] as const

/** A stdout Ink can render into at any size, and resize like a terminal. */
export class Terminal extends EventEmitter {
  frames: string[] = []
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }
  write = (frame: string): boolean => {
    this.frames.push(frame)
    return true
  }
  lastFrame(): string {
    return this.frames.at(-1) ?? ''
  }
  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
}

export class Keyboard extends EventEmitter {
  isTTY = true
  private data: string | null = null
  write(data: string): void {
    this.data = data
    this.emit('readable')
    this.emit('data', data)
  }
  read = (): string | null => {
    const { data } = this
    this.data = null
    return data
  }
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

export function staticSource(board: BoardView): BoardSource {
  return { view: () => board, subscribe: () => () => {} }
}

/** Render the app into a terminal of the given size, following its resizes. */
export function mount(board: BoardView, columns: number, rows: number) {
  const terminal = new Terminal(columns, rows)
  const keyboard = new Keyboard()
  const effects: Effect[] = []
  const instance = render(
    createElement(App, {
      source: staticSource(board),
      theme: makeTheme('plain', 'unicode'),
      onEffect: (effect: Effect) => effects.push(effect),
    }),
    {
      stdout: terminal as unknown as NodeJS.WriteStream,
      stdin: keyboard as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  return { terminal, keyboard, effects, instance }
}

/** Let React commit and Ink repaint. */
export const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
