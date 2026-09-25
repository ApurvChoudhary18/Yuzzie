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
    /** `event`: something happened (✓); `info`: a hint about a key (→). */
    readonly kind?: 'event' | 'info'
  } | null
  readonly now: number
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
