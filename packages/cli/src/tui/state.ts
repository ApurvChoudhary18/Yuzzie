/**
 * The board view's navigation state machine (SPEC.md §8.4), as a pure reducer.
 *
 * It knows nothing about React or the terminal: given the state, an action and
 * the card numbers in each column, it returns the next state and the effects
 * to perform. Every board-view keybinding in §8.4 either moves the selection or
 * names an effect, and is tested here without rendering anything.
 */
import { boardGeometry, isNarrow, type ListEntry, listEntries, listRows } from './layout.js'

export interface NavState {
  /** Index into the board's columns. */
  readonly column: number
  /** Selected card index in each column. */
  readonly selected: readonly number[]
  /** First visible card index in each column (board mode). */
  readonly scroll: readonly number[]
  /** First visible column (board mode, horizontal overflow). */
  readonly firstColumn: number
  /** First visible line (list mode). */
  readonly listScroll: number
  /** `g` was pressed and may become `gg`. */
  readonly pendingG: boolean
  readonly help: boolean
  readonly width: number
  readonly height: number
}

export type Effect =
  | { readonly type: 'quit' }
  | { readonly type: 'refresh' }
  | { readonly type: 'search' }
  | { readonly type: 'filter' }
  | { readonly type: 'new'; readonly column: number }
  | {
      readonly type:
        | 'open'
        | 'move'
        | 'assign'
        | 'claim'
        | 'comment'
        | 'edit'
        | 'openAnchor'
        | 'openBranch'
        | 'watch'
        | 'done'
        | 'delete'
      readonly cardNo: number
    }

export type NavAction =
  | { readonly type: 'key'; readonly key: string }
  | { readonly type: 'resize'; readonly width: number; readonly height: number }
  /** The board changed: re-clamp the selection to what exists now. */
  | { readonly type: 'data' }
  /** A lone `g` was not followed by another `g`: it meant "open branch". */
  | { readonly type: 'gTimeout' }

export interface Step {
  readonly state: NavState
  readonly effects: readonly Effect[]
}

/** Card numbers per column, in display order. */
export type Numbers = ReadonlyArray<readonly number[]>

export function initialNav(width: number, height: number, columns: number): NavState {
  return {
    column: 0,
    selected: Array.from({ length: columns }, () => 0),
    scroll: Array.from({ length: columns }, () => 0),
    firstColumn: 0,
    listScroll: 0,
    pendingG: false,
    help: false,
    width,
    height,
  }
}

/** Keys that act on the selected card, and what they do (§8.4, board column). */
const CARD_KEYS: Record<string, Exclude<Effect, { cardNo?: never }>['type']> = {
  enter: 'open',
  m: 'move',
  a: 'assign',
  c: 'claim',
  C: 'comment',
  e: 'edit',
  o: 'openAnchor',
  w: 'watch',
  d: 'done',
  D: 'delete',
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high))
}

function selectedCard(state: NavState, numbers: Numbers): number | undefined {
  return numbers[state.column]?.[state.selected[state.column] ?? 0]
}

/** Make the state consistent with the data and viewport, and keep the selection in view. */
export function settle(state: NavState, numbers: Numbers): NavState {
  const columns = numbers.length
  const column = columns === 0 ? 0 : clamp(state.column, 0, columns - 1)
  const selected = numbers.map((cards, index) =>
    clamp(state.selected[index] ?? 0, 0, Math.max(0, cards.length - 1)),
  )

  if (isNarrow(state.width)) {
    const entries = listEntries(numbers.map((cards) => cards.length))
    const target = entries.findIndex(
      (entry: ListEntry) =>
        (entry.kind === 'card' && entry.column === column && entry.index === selected[column]) ||
        (entry.kind === 'empty' && entry.column === column),
    )
    const rows = listRows(state.height)
    let listScroll = clamp(state.listScroll, 0, Math.max(0, entries.length - rows))
    // Keep the selection on screen, and its column's header with it when possible.
    const header = entries.findIndex((entry) => entry.kind === 'column' && entry.column === column)
    if (target !== -1 && target < listScroll) listScroll = Math.max(0, Math.min(target, header))
    if (target !== -1 && target >= listScroll + rows) listScroll = target - rows + 1
    return { ...state, column, selected, listScroll, scroll: selected.map(() => 0) }
  }

  const geometry = boardGeometry(state.width, state.height, columns)
  let firstColumn = clamp(state.firstColumn, 0, Math.max(0, columns - geometry.visible))
  if (column < firstColumn) firstColumn = column
  if (column >= firstColumn + geometry.visible) firstColumn = column - geometry.visible + 1

  const scroll = numbers.map((cards, index) => {
    const pick = selected[index] ?? 0
    let first = clamp(state.scroll[index] ?? 0, 0, Math.max(0, cards.length - geometry.slots))
    if (pick < first) first = pick
    if (pick >= first + geometry.slots) first = pick - geometry.slots + 1
    return first
  })

  return { ...state, column, selected, scroll, firstColumn }
}

function withSelection(state: NavState, column: number, index: number): NavState {
  return {
    ...state,
    column,
    selected: state.selected.map((value, i) => (i === column ? index : value)),
  }
}

export function reduce(state: NavState, action: NavAction, numbers: Numbers): Step {
  if (action.type === 'resize') {
    return {
      state: settle({ ...state, width: action.width, height: action.height }, numbers),
      effects: [],
    }
  }
  if (action.type === 'data') {
    return { state: settle(state, numbers), effects: [] }
  }
  if (action.type === 'gTimeout') {
    if (!state.pendingG) return { state, effects: [] }
    const cardNo = selectedCard(state, numbers)
    return {
      state: { ...state, pendingG: false },
      effects: cardNo === undefined ? [] : [{ type: 'openBranch', cardNo }],
    }
  }

  const key = action.key

  // `gg` jumps to the top; a lone `g` opens the branch (settled by gTimeout, or
  // by the next key if it is anything else).
  if (state.pendingG) {
    const cleared = { ...state, pendingG: false }
    if (key === 'g')
      return { state: settle(withSelection(cleared, cleared.column, 0), numbers), effects: [] }
    const cardNo = selectedCard(state, numbers)
    const pending: Effect[] = cardNo === undefined ? [] : [{ type: 'openBranch', cardNo }]
    const next = reduce(cleared, action, numbers)
    return { state: next.state, effects: [...pending, ...next.effects] }
  }

  if (key === 'ctrl-c' || key === 'q') return { state, effects: [{ type: 'quit' }] }

  if (state.help) {
    // Any key closes help; `?` too.
    return { state: { ...state, help: false }, effects: [] }
  }
  if (key === '?') return { state: { ...state, help: true }, effects: [] }

  const count = numbers[state.column]?.length ?? 0
  const current = state.selected[state.column] ?? 0

  switch (key) {
    case 'left':
    case 'h':
      return {
        state: settle({ ...state, column: Math.max(0, state.column - 1) }, numbers),
        effects: [],
      }
    case 'right':
    case 'l':
      return {
        state: settle(
          { ...state, column: Math.min(numbers.length - 1, state.column + 1) },
          numbers,
        ),
        effects: [],
      }
    case 'up':
    case 'k':
      return {
        state: settle(withSelection(state, state.column, Math.max(0, current - 1)), numbers),
        effects: [],
      }
    case 'down':
    case 'j':
      return {
        state: settle(
          withSelection(state, state.column, Math.min(count - 1, current + 1)),
          numbers,
        ),
        effects: [],
      }
    case 'G':
      return {
        state: settle(withSelection(state, state.column, Math.max(0, count - 1)), numbers),
        effects: [],
      }
    case 'g':
      return { state: { ...state, pendingG: true }, effects: [] }
    case 'n':
      return { state, effects: [{ type: 'new', column: state.column }] }
    case '/':
      return { state, effects: [{ type: 'search' }] }
    case 'f':
      return { state, effects: [{ type: 'filter' }] }
    case 'r':
      return { state, effects: [{ type: 'refresh' }] }
    default:
      break
  }

  if (/^[1-9]$/.test(key)) {
    const target = Number(key) - 1
    if (target >= numbers.length) return { state, effects: [] }
    return { state: settle({ ...state, column: target }, numbers), effects: [] }
  }

  const effect = CARD_KEYS[key]
  if (effect !== undefined) {
    const cardNo = selectedCard(state, numbers)
    return { state, effects: cardNo === undefined ? [] : [{ type: effect, cardNo } as Effect] }
  }

  return { state, effects: [] }
}
