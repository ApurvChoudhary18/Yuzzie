/**
 * Geometry for the board view (SPEC.md §8.2, §8.6), shared by the navigation
 * reducer (to keep the selection in view) and the frame (to draw it).
 *
 * Board mode, from the top:
 *
 *     ┌ yuzie · slug ───────── status ─┐   header
 *     │                                │   spacer
 *     │ ┌──── TODO (3) ────┬─── … ───┐ │   column titles
 *     │ │                  │         │ │   ↑ n more, when scrolled
 *     │ │ …card rows…      │         │ │   3 rows per card, last row ↓ n more
 *     │ └──────────────────┴─────────┘ │
 *     │                                │   spacer
 *     │ ✓ @priya moved #15 → Review    │   toast
 *     │ ? help  / search  …  q quit    │   hints
 *     └────────────────────────────────┘
 *
 * Under 100 columns it is a single list grouped by column (§8.6).
 */
import type { Card, Column, ColumnSemantics, Presence } from '@yuzie/core'

export const NARROW_WIDTH = 100
export const MIN_COLUMN_WIDTH = 24
export const CARD_ROWS = 3
/** Rows the board frame takes that are not card rows. */
export const BOARD_CHROME = 9
/** Rows the list frame takes that are not list rows. */
export const LIST_CHROME = 6
/** Below this the frame is replaced by a one-line "too small" notice. */
export const MIN_WIDTH = 30
export const MIN_HEIGHT = 12

export interface ViewColumn {
  readonly key: string
  readonly name: string
  readonly semantics: ColumnSemantics | null
  readonly wipLimit: number | null
  readonly cards: readonly Card[]
}

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline'

/** One line of a card's activity panel (§8.3). */
export interface ActivityEntry {
  readonly at: number
  readonly who: string
  readonly text: string
}

export interface BoardView {
  readonly slug: string
  readonly columns: readonly ViewColumn[]
  readonly presence: readonly Presence[]
  readonly connection: Connection
  readonly queued: number
  /** The latest live event, shown for 3 s (§8.2). */
  readonly toast: {
    readonly text: string
    readonly at: number
    /**
     * `event`: something happened (✓); `info`: a hint about a key (→);
     * `warn`: something failed (⚠); `conflict`: your change was undone (⟳).
     */
    readonly kind?: 'event' | 'info' | 'warn' | 'conflict'
    /** Toasts waiting behind this one (the queue holds at most 3). */
    readonly waiting?: number
  } | null
  readonly now: number
  /** Board members' handles, for the member picker. */
  readonly members: readonly string[]
  /** The signed-in user's handle, once known. */
  readonly me: string | null
  /** Cards with a write painted optimistically and not yet confirmed. */
  readonly pending: ReadonlySet<number>
  /** Cards whose last write was refused by the server: when, and who changed it first. */
  readonly conflicts: ReadonlyMap<number, Touch>
  /** Cards someone else just changed, for `⟳ updated by @x` in the card view. */
  readonly touched: ReadonlyMap<number, Touch>
  /** Cards that just moved, and when: they flash once (§18 Session 10). */
  readonly flashes: ReadonlyMap<number, number>
  /** Commits recently pushed to a card's branch: the `↑3` badge for 10 minutes (§8.5). */
  readonly pushes: ReadonlyMap<number, { readonly count: number; readonly at: number }>
  /** Loaded activity per card; `null` while it is loading. */
  readonly activity: ReadonlyMap<number, readonly ActivityEntry[] | null>
}

/** Something that happened to a card, and who did it (`null` when not known). */
export interface Touch {
  readonly at: number
  readonly by: string | null
}

/** How long a card keeps its conflict marker. */
export const CONFLICT_MS = 10_000
/** How long `⟳ updated by @x` stays on an open card. */
export const TOUCH_MS = 5_000
/** A moved card's single flash. */
export const FLASH_MS = 700
/** How long the `↑3` pushed badge stays (§8.5). */
export const PUSH_MS = 10 * 60_000

/** What `f` can narrow the board to (§8.4). */
export type Filter =
  | { readonly kind: 'mine' }
  | { readonly kind: 'assignee'; readonly handle: string }
  | { readonly kind: 'label'; readonly label: string }

export function describeFilter(filter: Filter): string {
  switch (filter.kind) {
    case 'mine':
      return 'mine'
    case 'assignee':
      return `@${filter.handle}`
    case 'label':
      return filter.label
  }
}

function matchesQuery(card: Card, query: string): boolean {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
  const haystack = [
    `#${card.number}`,
    card.title,
    ...card.labels,
    ...card.assignees.map((handle) => `@${handle}`),
  ]
    .join(' ')
    .toLowerCase()
  return words.every((word) => haystack.includes(word))
}

function matchesFilter(card: Card, filter: Filter, me: string | null): boolean {
  switch (filter.kind) {
    case 'mine':
      return me !== null && card.assignees.includes(me)
    case 'assignee':
      return card.assignees.includes(filter.handle)
    case 'label':
      return card.labels.includes(filter.label)
  }
}

/** The board as the user asked to see it: search (`/`) and filter (`f`) applied. */
export function visibleView(view: BoardView, query: string, filter: Filter | null): BoardView {
  if (query.trim().length === 0 && filter === null) return view
  return {
    ...view,
    columns: view.columns.map((column) => ({
      ...column,
      cards: column.cards.filter(
        (card) =>
          matchesQuery(card, query) && (filter === null || matchesFilter(card, filter, view.me)),
      ),
    })),
  }
}

export function findCard(view: BoardView, cardNo: number): Card | undefined {
  for (const column of view.columns) {
    const card = column.cards.find((candidate) => candidate.number === cardNo)
    if (card !== undefined) return card
  }
  return undefined
}

export function viewColumns(columns: readonly Column[], cards: readonly Card[]): ViewColumn[] {
  const ordered = [...columns].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
  return ordered.map((column) => ({
    key: column.key,
    name: column.name,
    semantics: column.semantics,
    wipLimit: column.wipLimit,
    cards: cards
      .filter((card) => card.column === column.key)
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.number - b.number)),
  }))
}

/** Card numbers per column, in display order: what the navigation reducer needs. */
export function numbersOf(view: BoardView): number[][] {
  return view.columns.map((column) => column.cards.map((card) => card.number))
}

export function isNarrow(width: number): boolean {
  return width < NARROW_WIDTH
}

export function isTooSmall(width: number, height: number): boolean {
  return width < MIN_WIDTH || height < MIN_HEIGHT
}

export interface BoardGeometry {
  /** How many columns fit side by side. */
  readonly visible: number
  /** Content width of each visible column, left to right. */
  readonly widths: readonly number[]
  /** Card slots per column, after the ↓ indicator row. */
  readonly slots: number
  readonly cardRows: number
}

export function boardGeometry(width: number, height: number, columnCount: number): BoardGeometry {
  // The board box sits inside the outer frame, one space in from each side.
  const boardWidth = width - 4
  const fits = Math.max(1, Math.floor((boardWidth - 1) / (MIN_COLUMN_WIDTH + 1)))
  const visible = Math.max(1, Math.min(fits, Math.max(1, columnCount)))
  const content = boardWidth - (visible + 1)
  const base = Math.floor(content / visible)
  const extra = content - base * visible
  const widths = Array.from({ length: visible }, (_, index) => base + (index < extra ? 1 : 0))
  const cardRows = Math.max(1, height - BOARD_CHROME)
  const slots = Math.max(1, Math.floor((cardRows - 1) / CARD_ROWS))
  return { visible, widths, slots, cardRows }
}

export function listRows(height: number): number {
  return Math.max(1, height - LIST_CHROME)
}

/** The list view's lines: a header per column, then its cards. */
export type ListEntry =
  | { readonly kind: 'column'; readonly column: number }
  | { readonly kind: 'card'; readonly column: number; readonly index: number }
  | { readonly kind: 'empty'; readonly column: number }

export function listEntries(counts: readonly number[]): ListEntry[] {
  const entries: ListEntry[] = []
  counts.forEach((count, column) => {
    entries.push({ kind: 'column', column })
    if (count === 0) entries.push({ kind: 'empty', column })
    for (let index = 0; index < count; index += 1) entries.push({ kind: 'card', column, index })
  })
  return entries
}
