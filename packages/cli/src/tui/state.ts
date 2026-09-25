/**
 * The TUI's navigation state machine (SPEC.md §8.4), as a pure reducer.
 *
 * It knows nothing about React or the terminal: given the state, an action and
 * the board as it stands, it returns the next state and the effects to
 * perform. Every keybinding in §8.4 — board view, card view and every overlay
 * — either changes this state or names an effect, and is tested here without
 * rendering anything.
 */
import { cardBodyHeight } from './card.js'
import {
  type BoardView,
  boardGeometry,
  describeFilter,
  type Filter,
  findCard,
  isNarrow,
  type ListEntry,
  listEntries,
  listRows,
  numbersOf,
  visibleView,
} from './layout.js'

export interface PickOption {
  readonly label: string
  readonly value: string
  /** Marked with ✓: the card's current column, an existing assignee, the active filter. */
  readonly current?: boolean
}

export type Overlay =
  | {
      readonly kind: 'pick'
      readonly purpose: 'move' | 'assign' | 'filter'
      readonly cardNo: number | null
      readonly title: string
      readonly options: readonly PickOption[]
      readonly index: number
    }
  | {
      readonly kind: 'input'
      readonly purpose: 'new' | 'comment' | 'item' | 'search'
      readonly cardNo: number | null
      /** For `new`: the column the card goes in. */
      readonly column: string | null
      readonly title: string
      readonly text: string
      /** Enter adds a line; Ctrl-D sends (§8.4, the comment composer). */
      readonly multiline: boolean
    }
  | { readonly kind: 'confirm'; readonly cardNo: number; readonly title: string }
  | { readonly kind: 'checklist'; readonly cardNo: number; readonly index: number }

export interface NavState {
  readonly screen: 'board' | 'card'
  /** The card open in the card view. */
  readonly cardNo: number | null
  /** First visible line of the card view's body. */
  readonly cardScroll: number
  readonly overlay: Overlay | null
  /** `/` search text; empty when not searching. */
  readonly query: string
  /** `f` filter. */
  readonly filter: Filter | null
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

type CardEffectType =
  | 'open'
  | 'close'
  | 'claim'
  | 'edit'
  | 'openAnchor'
  | 'openBranch'
  | 'watch'
  | 'done'
  | 'delete'

export type Effect =
  | { readonly type: 'quit' }
  | { readonly type: 'refresh' }
  | { readonly type: CardEffectType; readonly cardNo: number }
  | { readonly type: 'move'; readonly cardNo: number; readonly column: string }
  | {
      readonly type: 'assign'
      readonly cardNo: number
      readonly handle: string
      /** Add the handle, or take it off. */
      readonly on: boolean
    }
  | { readonly type: 'comment'; readonly cardNo: number; readonly body: string }
  | { readonly type: 'create'; readonly column: string; readonly title: string }
  | {
      readonly type: 'check'
      readonly cardNo: number
      readonly position: number
      readonly done: boolean
    }
  | { readonly type: 'addItem'; readonly cardNo: number; readonly text: string }

export type NavAction =
  | { readonly type: 'key'; readonly key: string }
  /** Several characters at once: a paste, typed into whichever input is open. */
  | { readonly type: 'paste'; readonly text: string }
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

/** Rows the card view takes that are not its scrolling body. */
export const CARD_CHROME = 5

export function initialNav(width: number, height: number, columns: number): NavState {
  return {
    screen: 'board',
    cardNo: null,
    cardScroll: 0,
    overlay: null,
    query: '',
    filter: null,
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

/** Keys that act on one card, in both views (§8.4). */
const CARD_KEYS: Record<string, CardEffectType> = {
  c: 'claim',
  e: 'edit',
  o: 'openAnchor',
  w: 'watch',
  d: 'done',
}

const NONE: readonly Effect[] = []

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high))
}

function step(state: NavState, effects: readonly Effect[] = NONE): Step {
  return { state, effects }
}

/** A key that types itself into an input: one printable character. */
function printable(key: string): boolean {
  return [...key].length === 1 && key >= ' ' && key !== '\u007f'
}

/** What the reducer reads off the board: the filtered view and its card numbers. */
function shown(view: BoardView, state: NavState): { view: BoardView; numbers: Numbers } {
  const visible = visibleView(view, state.query, state.filter)
  return { view: visible, numbers: numbersOf(visible) }
}

function selectedCard(state: NavState, numbers: Numbers): number | undefined {
  return numbers[state.column]?.[state.selected[state.column] ?? 0]
}

/** The card the keys act on: the open one in the card view, else the selection. */
function targetCard(state: NavState, numbers: Numbers): number | undefined {
  return state.screen === 'card' ? (state.cardNo ?? undefined) : selectedCard(state, numbers)
}

/** Make the state consistent with the data and viewport, and keep the selection in view. */
export function settle(state: NavState, view: BoardView): NavState {
  const { view: visible, numbers } = shown(view, state)
  const columns = numbers.length
  const column = columns === 0 ? 0 : clamp(state.column, 0, columns - 1)
  const selected = numbers.map((cards, index) =>
    clamp(state.selected[index] ?? 0, 0, Math.max(0, cards.length - 1)),
  )

  // The open card went away (deleted, here or elsewhere): back to the board.
  let screen = state.screen
  let cardNo = state.cardNo
  let cardScroll = state.cardScroll
  let overlay = state.overlay
  if (screen === 'card') {
    const card = cardNo === null ? undefined : findCard(view, cardNo)
    if (card === undefined) {
      screen = 'board'
      cardNo = null
      cardScroll = 0
      if (overlay !== null && overlay.kind !== 'input') overlay = null
    } else {
      const body = cardBodyHeight(card, view, state.width)
      cardScroll = clamp(cardScroll, 0, body - (state.height - CARD_CHROME))
      if (overlay?.kind === 'checklist')
        overlay = { ...overlay, index: clamp(overlay.index, 0, card.checklist.length - 1) }
    }
  }
  const base = { ...state, screen, cardNo, cardScroll, overlay, column, selected }

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
    return { ...base, listScroll, scroll: selected.map(() => 0) }
  }

  const geometry = boardGeometry(state.width, state.height, visible.columns.length)
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

  return { ...base, scroll, firstColumn }
}

function withSelection(state: NavState, column: number, index: number): NavState {
  return {
    ...state,
    column,
    selected: state.selected.map((value, i) => (i === column ? index : value)),
  }
}

// ---------------------------------------------------------------------------
// Opening overlays
// ---------------------------------------------------------------------------

function movePicker(view: BoardView, cardNo: number): Overlay {
  const card = findCard(view, cardNo)
  const options = view.columns.map((column) => ({
    label: column.name,
    value: column.key,
    current: card?.column === column.key,
  }))
  return {
    kind: 'pick',
    purpose: 'move',
    cardNo,
    title: `Move #${cardNo} to`,
    options,
    index: Math.max(
      0,
      options.findIndex((option) => option.current),
    ),
  }
}

function assignPicker(view: BoardView, cardNo: number): Overlay {
  const card = findCard(view, cardNo)
  const handles = [
    ...new Set([
      ...(view.me === null ? [] : [view.me]),
      ...view.members,
      ...(card?.assignees ?? []),
    ]),
  ]
  return {
    kind: 'pick',
    purpose: 'assign',
    cardNo,
    title: `Assign #${cardNo}`,
    options: handles.map((handle) => ({
      label: `@${handle}${handle === view.me ? ' (you)' : ''}`,
      value: handle,
      current: card?.assignees.includes(handle) === true,
    })),
    index: 0,
  }
}

function filterPicker(view: BoardView, active: Filter | null): Overlay {
  const cards = view.columns.flatMap((column) => column.cards)
  const assignees = [...new Set(cards.flatMap((card) => card.assignees))].sort()
  const labels = [...new Set(cards.flatMap((card) => card.labels))].sort()
  const current = active === null ? 'all' : filterValue(active)
  const options: PickOption[] = [
    { label: 'Everything', value: 'all' },
    ...(view.me === null ? [] : [{ label: 'Mine', value: 'mine' }]),
    ...assignees.map((handle) => ({ label: `Assigned to @${handle}`, value: `@${handle}` })),
    ...labels.map((label) => ({ label: `Label: ${label}`, value: `#${label}` })),
  ].map((option) => ({ ...option, current: option.value === current }))
  return {
    kind: 'pick',
    purpose: 'filter',
    cardNo: null,
    title: 'Show',
    options,
    index: Math.max(
      0,
      options.findIndex((option) => option.current),
    ),
  }
}

function filterValue(filter: Filter): string {
  return filter.kind === 'mine'
    ? 'mine'
    : `${filter.kind === 'label' ? '#' : ''}${describeFilter(filter)}`
}

function parseFilter(value: string): Filter | null {
  if (value === 'all') return null
  if (value === 'mine') return { kind: 'mine' }
  if (value.startsWith('@')) return { kind: 'assignee', handle: value.slice(1) }
  return { kind: 'label', label: value.slice(1) }
}

function input(
  purpose: 'new' | 'comment' | 'item' | 'search',
  title: string,
  options: { cardNo?: number; column?: string; text?: string } = {},
): Overlay {
  return {
    kind: 'input',
    purpose,
    cardNo: options.cardNo ?? null,
    column: options.column ?? null,
    title,
    text: options.text ?? '',
    multiline: purpose === 'comment',
  }
}

// ---------------------------------------------------------------------------
// Overlay keys
// ---------------------------------------------------------------------------

function closeOverlay(state: NavState, view: BoardView, effects: readonly Effect[] = NONE): Step {
  return step(settle({ ...state, overlay: null }, view), effects)
}

function pickKey(
  state: NavState,
  overlay: Extract<Overlay, { kind: 'pick' }>,
  key: string,
  view: BoardView,
): Step {
  const last = overlay.options.length - 1
  switch (key) {
    case 'up':
    case 'k':
      return step({ ...state, overlay: { ...overlay, index: Math.max(0, overlay.index - 1) } })
    case 'down':
    case 'j':
      return step({ ...state, overlay: { ...overlay, index: Math.min(last, overlay.index + 1) } })
    case 'escape':
    case 'q':
    case 'ctrl-c':
      return closeOverlay(state, view)
    case 'enter': {
      const option = overlay.options[overlay.index]
      if (option === undefined) return closeOverlay(state, view)
      if (overlay.purpose === 'filter') {
        return closeOverlay({ ...state, filter: parseFilter(option.value) }, view)
      }
      const cardNo = overlay.cardNo as number
      if (overlay.purpose === 'move') {
        return closeOverlay(
          state,
          view,
          option.current === true ? NONE : [{ type: 'move', cardNo, column: option.value }],
        )
      }
      return closeOverlay(state, view, [
        { type: 'assign', cardNo, handle: option.value, on: option.current !== true },
      ])
    }
    default:
      return step(state)
  }
}

function submitInput(
  state: NavState,
  overlay: Extract<Overlay, { kind: 'input' }>,
  view: BoardView,
): Step {
  const text = overlay.text.trim()
  if (overlay.purpose === 'search') return closeOverlay(state, view)
  if (text.length === 0) return closeOverlay(state, view)
  const cardNo = overlay.cardNo as number
  switch (overlay.purpose) {
    case 'new':
      return closeOverlay(state, view, [
        { type: 'create', column: overlay.column as string, title: text },
      ])
    case 'comment':
      return closeOverlay(state, view, [{ type: 'comment', cardNo, body: text }])
    case 'item':
      return closeOverlay(state, view, [{ type: 'addItem', cardNo, text }])
  }
}

function typed(
  state: NavState,
  overlay: Extract<Overlay, { kind: 'input' }>,
  text: string,
  view: BoardView,
): Step {
  const next = { ...overlay, text }
  // Search filters as you type.
  if (overlay.purpose === 'search')
    return step(settle({ ...state, overlay: next, query: text }, view))
  return step({ ...state, overlay: next })
}

function inputKey(
  state: NavState,
  overlay: Extract<Overlay, { kind: 'input' }>,
  key: string,
  view: BoardView,
): Step {
  switch (key) {
    case 'escape':
    case 'ctrl-c':
      // Cancelling a search also drops what it was filtering by.
      return closeOverlay(overlay.purpose === 'search' ? { ...state, query: '' } : state, view)
    case 'ctrl-d':
      return submitInput(state, overlay, view)
    case 'enter':
      return overlay.multiline
        ? typed(state, overlay, `${overlay.text}\n`, view)
        : submitInput(state, overlay, view)
    case 'backspace':
      return typed(state, overlay, [...overlay.text].slice(0, -1).join(''), view)
    default:
      return printable(key) ? typed(state, overlay, overlay.text + key, view) : step(state)
  }
}

function checklistKey(
  state: NavState,
  overlay: Extract<Overlay, { kind: 'checklist' }>,
  key: string,
  view: BoardView,
): Step {
  const card = findCard(view, overlay.cardNo)
  const items =
    card === undefined ? [] : [...card.checklist].sort((a, b) => a.position - b.position)
  switch (key) {
    case 'up':
    case 'k':
      return step({ ...state, overlay: { ...overlay, index: Math.max(0, overlay.index - 1) } })
    case 'down':
    case 'j':
      return step({
        ...state,
        overlay: { ...overlay, index: Math.min(items.length - 1, overlay.index + 1) },
      })
    case 'x':
    case ' ':
    case 'enter': {
      const item = items[overlay.index]
      if (item === undefined) return step(state)
      return step(state, [
        {
          type: 'check',
          cardNo: overlay.cardNo,
          position: item.position,
          done: item.doneAt === null,
        },
      ])
    }
    case '+':
      return step({
        ...state,
        overlay: input('item', `New checklist item on #${overlay.cardNo}`, {
          cardNo: overlay.cardNo,
        }),
      })
    case 'escape':
    case 'q':
    case 'ctrl-c':
      return closeOverlay(state, view)
    default:
      return step(state)
  }
}

function overlayKey(state: NavState, overlay: Overlay, key: string, view: BoardView): Step {
  switch (overlay.kind) {
    case 'pick':
      return pickKey(state, overlay, key, view)
    case 'input':
      return inputKey(state, overlay, key, view)
    case 'checklist':
      return checklistKey(state, overlay, key, view)
    case 'confirm': {
      if (key === 'y' || key === 'Y' || key === 'enter') {
        const back =
          state.screen === 'card' && state.cardNo === overlay.cardNo
            ? { screen: 'board' as const, cardNo: null, cardScroll: 0 }
            : {}
        return closeOverlay({ ...state, ...back }, view, [
          { type: 'delete', cardNo: overlay.cardNo },
        ])
      }
      if (key === 'n' || key === 'N' || key === 'escape' || key === 'q' || key === 'ctrl-c')
        return closeOverlay(state, view)
      return step(state)
    }
  }
}

// ---------------------------------------------------------------------------
// Keys shared by both views
// ---------------------------------------------------------------------------

/** `m a C D e c o w d` and friends, on whichever card the view points at. */
function cardKey(state: NavState, key: string, cardNo: number, view: BoardView): Step | null {
  switch (key) {
    case 'm':
      return step({ ...state, overlay: movePicker(view, cardNo) })
    case 'a':
      return step({ ...state, overlay: assignPicker(view, cardNo) })
    case 'C':
      return step({
        ...state,
        overlay: input('comment', `Comment on #${cardNo}`, { cardNo }),
      })
    case 'D': {
      const card = findCard(view, cardNo)
      return step({
        ...state,
        overlay: { kind: 'confirm', cardNo, title: card?.title ?? `#${cardNo}` },
      })
    }
    default: {
      const effect = CARD_KEYS[key]
      return effect === undefined ? null : step(state, [{ type: effect, cardNo }])
    }
  }
}

// ---------------------------------------------------------------------------
// Card view
// ---------------------------------------------------------------------------

function cardViewKey(state: NavState, key: string, view: BoardView): Step {
  const cardNo = state.cardNo as number
  switch (key) {
    case 'escape':
    case 'q':
    case 'ctrl-c':
      return step(settle({ ...state, screen: 'board', cardNo: null, cardScroll: 0 }, view), [
        { type: 'close', cardNo },
      ])
    case 'up':
    case 'k':
      return step(settle({ ...state, cardScroll: state.cardScroll - 1 }, view))
    case 'down':
    case 'j':
      return step(settle({ ...state, cardScroll: state.cardScroll + 1 }, view))
    case 'g':
      return step(state, [{ type: 'openBranch', cardNo }])
    case 'r':
      return step(state, [{ type: 'refresh' }])
    case 'x': {
      const card = findCard(view, cardNo)
      if (card === undefined || card.checklist.length === 0) {
        return step({
          ...state,
          overlay: input('item', `New checklist item on #${cardNo}`, { cardNo }),
        })
      }
      const firstOpen = [...card.checklist]
        .sort((a, b) => a.position - b.position)
        .findIndex((item) => item.doneAt === null)
      return step({
        ...state,
        overlay: { kind: 'checklist', cardNo, index: Math.max(0, firstOpen) },
      })
    }
    case '+':
      return step({
        ...state,
        overlay: input('item', `New checklist item on #${cardNo}`, { cardNo }),
      })
    case '?':
      return step({ ...state, help: true })
    default:
      return cardKey(state, key, cardNo, view) ?? step(state)
  }
}

// ---------------------------------------------------------------------------
// Board view
// ---------------------------------------------------------------------------

function boardKey(state: NavState, key: string, view: BoardView): Step {
  const { view: visible, numbers } = shown(view, state)
  const count = numbers[state.column]?.length ?? 0
  const current = state.selected[state.column] ?? 0
  const cardNo = selectedCard(state, numbers)

  switch (key) {
    case 'ctrl-c':
    case 'q':
      return step(state, [{ type: 'quit' }])
    case '?':
      return step({ ...state, help: true })
    case 'escape':
      // Esc on the board clears a search or filter, if there is one.
      if (state.query !== '' || state.filter !== null)
        return step(settle({ ...state, query: '', filter: null }, view))
      return step(state)
    case 'left':
    case 'h':
      return step(settle({ ...state, column: Math.max(0, state.column - 1) }, view))
    case 'right':
    case 'l':
      return step(
        settle({ ...state, column: Math.min(numbers.length - 1, state.column + 1) }, view),
      )
    case 'up':
    case 'k':
      return step(settle(withSelection(state, state.column, Math.max(0, current - 1)), view))
    case 'down':
    case 'j':
      return step(
        settle(withSelection(state, state.column, Math.min(count - 1, current + 1)), view),
      )
    case 'G':
      return step(settle(withSelection(state, state.column, Math.max(0, count - 1)), view))
    case 'g':
      return step({ ...state, pendingG: true })
    case 'r':
      return step(state, [{ type: 'refresh' }])
    case '/':
      return step({ ...state, overlay: input('search', 'Search', { text: state.query }) })
    case 'f':
      return step({ ...state, overlay: filterPicker(view, state.filter) })
    case 'n': {
      const column = visible.columns[state.column]
      if (column === undefined) return step(state)
      return step({
        ...state,
        overlay: input('new', `New card in ${column.name}`, { column: column.key }),
      })
    }
    case 'enter':
      if (cardNo === undefined) return step(state)
      return step(settle({ ...state, screen: 'card', cardNo, cardScroll: 0 }, view), [
        { type: 'open', cardNo },
      ])
    default:
      break
  }

  if (/^[1-9]$/.test(key)) {
    const target = Number(key) - 1
    if (target >= numbers.length) return step(state)
    return step(settle({ ...state, column: target }, view))
  }

  if (cardNo === undefined) return step(state)
  return cardKey(state, key, cardNo, view) ?? step(state)
}

// ---------------------------------------------------------------------------

export function reduce(state: NavState, action: NavAction, view: BoardView): Step {
  switch (action.type) {
    case 'resize':
      return step(settle({ ...state, width: action.width, height: action.height }, view))
    case 'data':
      return step(settle(state, view))
    case 'paste': {
      const overlay = state.overlay
      if (overlay?.kind !== 'input') return step(state)
      const text = overlay.multiline ? action.text : action.text.replace(/\s*\n\s*/g, ' ')
      return typed(state, overlay, overlay.text + text, view)
    }
    case 'gTimeout': {
      if (!state.pendingG) return step(state)
      const cardNo = targetCard(state, shown(view, state).numbers)
      return step(
        { ...state, pendingG: false },
        cardNo === undefined ? NONE : [{ type: 'openBranch', cardNo }],
      )
    }
    case 'key':
      break
  }

  const key = action.key

  // `gg` jumps to the top; a lone `g` opens the branch (settled by gTimeout, or
  // by the next key if it is anything else).
  if (state.pendingG) {
    const cleared = { ...state, pendingG: false }
    if (key === 'g') return step(settle(withSelection(cleared, cleared.column, 0), view))
    const cardNo = targetCard(state, shown(view, state).numbers)
    const pending: Effect[] = cardNo === undefined ? [] : [{ type: 'openBranch', cardNo }]
    const next = reduce(cleared, action, view)
    return step(next.state, [...pending, ...next.effects])
  }

  // Help closes on any key; `q` still quits from the board.
  if (state.help) {
    if (state.screen === 'board' && (key === 'q' || key === 'ctrl-c'))
      return step(state, [{ type: 'quit' }])
    return step({ ...state, help: false })
  }

  if (state.overlay !== null) return overlayKey(state, state.overlay, key, view)
  return state.screen === 'card' ? cardViewKey(state, key, view) : boardKey(state, key, view)
}
