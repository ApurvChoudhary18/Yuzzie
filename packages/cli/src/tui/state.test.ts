/**
 * Every board-view keybinding in SPEC.md §8.4, through the reducer alone —
 * no React, no terminal (§18 Session 8 acceptance).
 */
import { describe, expect, it } from 'vitest'
import { card, column, view, viewOf } from './__tests__/fixtures.js'
import type { BoardView } from './layout.js'
import { type Effect, initialNav, type NavState, type Numbers, reduce } from './state.js'

/** Three columns: #1 #2 #3 | #4 #5 | (empty). A wide terminal, so board mode. */
const NUMBERS: Numbers = [[1, 2, 3], [4, 5], []]
const BOARD = viewOf(NUMBERS)

/** The reducer takes a whole board; these tests only care about card numbers. */
function asView(numbers: Numbers | BoardView): BoardView {
  return Array.isArray(numbers) ? viewOf(numbers as Numbers) : (numbers as BoardView)
}

function start(width = 160, height = 50, numbers: Numbers | BoardView = BOARD): NavState {
  const board = asView(numbers)
  return reduce(initialNav(width, height, board.columns.length), { type: 'data' }, board).state
}

function press(state: NavState, keys: string[], numbers: Numbers | BoardView = BOARD) {
  const board = asView(numbers)
  let current = state
  const effects: Effect[] = []
  for (const key of keys) {
    const step = reduce(current, { type: 'key', key }, board)
    current = step.state
    effects.push(...step.effects)
  }
  return { state: current, effects }
}

const at = (state: NavState) => [state.column, state.selected[state.column]]

describe('moving between columns (←/→, h/l, 1–9)', () => {
  it('h/l and the arrows move one column, stopping at the edges', () => {
    expect(at(press(start(), ['l']).state)).toEqual([1, 0])
    expect(at(press(start(), ['right', 'right', 'right']).state)).toEqual([2, 0])
    expect(at(press(start(), ['l', 'h']).state)).toEqual([0, 0])
    expect(at(press(start(), ['left']).state)).toEqual([0, 0])
  })

  it('1–9 jump to the nth column, ignoring columns that do not exist', () => {
    expect(press(start(), ['3']).state.column).toBe(2)
    expect(press(start(), ['2', '1']).state.column).toBe(0)
    expect(press(start(), ['9']).state.column).toBe(0)
  })

  it('each column remembers its own selection', () => {
    const { state } = press(start(), ['j', 'j', 'l', 'j', 'h'])
    expect(state.selected).toEqual([2, 1, 0])
    expect(at(state)).toEqual([0, 2])
  })
})

describe('moving between cards (↑/↓, j/k, gg, G)', () => {
  it('j/k and the arrows move one card, stopping at the ends', () => {
    expect(at(press(start(), ['j']).state)).toEqual([0, 1])
    expect(at(press(start(), ['down', 'down', 'down', 'down']).state)).toEqual([0, 2])
    expect(at(press(start(), ['j', 'k', 'up']).state)).toEqual([0, 0])
  })

  it('G jumps to the last card, gg to the first', () => {
    expect(at(press(start(), ['G']).state)).toEqual([0, 2])
    expect(at(press(start(), ['G', 'g', 'g']).state)).toEqual([0, 0])
  })

  it('does nothing in an empty column', () => {
    const { state, effects } = press(start(), ['3', 'j', 'G', 'enter', 'd'])
    expect(at(state)).toEqual([2, 0])
    expect(effects).toEqual([])
  })
})

describe('keys that act on the selected card', () => {
  it.each([
    ['c', 'claim'],
    ['e', 'edit'],
    ['o', 'openAnchor'],
    ['w', 'watch'],
    ['d', 'done'],
  ])('%s → %s', (key, type) => {
    const { effects } = press(start(), ['j', key])
    expect(effects).toEqual([{ type, cardNo: 2 }])
  })

  it('enter opens the card view on the selected card', () => {
    const { state, effects } = press(start(), ['j', 'enter'])
    expect(state).toMatchObject({ screen: 'card', cardNo: 2, cardScroll: 0 })
    expect(effects).toEqual([{ type: 'open', cardNo: 2 }])
  })

  it.each([
    ['m', 'pick', 'move'],
    ['a', 'pick', 'assign'],
    ['C', 'input', 'comment'],
  ])('%s opens the %s overlay for %s', (key, kind, purpose) => {
    const { state, effects } = press(start(), ['j', key])
    expect(state.overlay).toMatchObject({ kind, purpose, cardNo: 2 })
    expect(effects).toEqual([])
  })

  it('D asks before deleting', () => {
    const { state, effects } = press(start(), ['j', 'D'])
    expect(state.overlay).toMatchObject({ kind: 'confirm', cardNo: 2 })
    expect(effects).toEqual([])
  })

  it('a lone g opens the branch once it is clear no second g is coming', () => {
    const pending = press(start(), ['l', 'g'])
    expect(pending.state.pendingG).toBe(true)
    expect(pending.effects).toEqual([])
    const timeout = reduce(pending.state, { type: 'gTimeout' }, BOARD)
    expect(timeout.effects).toEqual([{ type: 'openBranch', cardNo: 4 }])
    expect(timeout.state.pendingG).toBe(false)
  })

  it('g followed by another key opens the branch and still does that key', () => {
    const { state, effects } = press(start(), ['g', 'j'])
    expect(effects).toEqual([{ type: 'openBranch', cardNo: 1 }])
    expect(at(state)).toEqual([0, 1])
  })
})

describe('board-wide keys', () => {
  it.each([
    ['r', [{ type: 'refresh' }]],
    ['q', [{ type: 'quit' }]],
    ['ctrl-c', [{ type: 'quit' }]],
  ])('%s', (key, expected) => {
    expect(press(start(), [key]).effects).toEqual(expected)
  })

  it.each([
    ['n', { kind: 'input', purpose: 'new', column: 'c1' }],
    ['/', { kind: 'input', purpose: 'search' }],
    ['f', { kind: 'pick', purpose: 'filter' }],
  ])('%s opens its overlay', (key, overlay) => {
    const { state, effects } = press(start(), ['l', key])
    expect(state.overlay).toMatchObject(overlay)
    expect(effects).toEqual([])
  })

  it('? opens help; any key closes it without acting; q still quits', () => {
    const open = press(start(), ['?'])
    expect(open.state.help).toBe(true)
    const closed = press(open.state, ['j'])
    expect(closed.state.help).toBe(false)
    expect(at(closed.state)).toEqual([0, 0])
    expect(press(open.state, ['q']).effects).toEqual([{ type: 'quit' }])
  })

  it('ignores keys it does not know, and x (card view only)', () => {
    expect(press(start(), ['z', 'x', 'escape'])).toEqual({ state: start(), effects: [] })
  })
})

describe('scrolling keeps the selection in view', () => {
  const tall: Numbers = [Array.from({ length: 200 }, (_, index) => index + 1)]

  it('vertically, one screen at a time', () => {
    // 30 rows: 21 card rows → 6 card slots after the ↓ row.
    const state = start(120, 30, tall)
    const down = press(
      state,
      Array.from({ length: 10 }, () => 'j'),
      tall,
    ).state
    expect(down.selected[0]).toBe(10)
    expect(down.scroll[0]).toBe(5)
    const bottom = press(state, ['G'], tall).state
    expect(bottom.scroll[0]).toBe(194)
    expect(press(bottom, ['g', 'g'], tall).state.scroll[0]).toBe(0)
  })

  it('horizontally, when there are more columns than fit', () => {
    const wide: Numbers = Array.from({ length: 12 }, (_, index) => [index + 1])
    // 120 columns wide: four board columns fit.
    const state = start(120, 30, wide)
    expect(state.firstColumn).toBe(0)
    const right = press(state, ['l', 'l', 'l', 'l', 'l'], wide).state
    expect(right.column).toBe(5)
    expect(right.firstColumn).toBe(2)
    expect(press(right, ['1'], wide).state.firstColumn).toBe(0)
  })

  it('in the narrow list view, by line', () => {
    const state = start(80, 24, tall)
    const far = press(state, ['G'], tall).state
    // 24 rows: 18 list rows; the header, then 200 cards.
    expect(far.listScroll).toBe(201 - 18)
  })
})

describe('resize and data changes never leave the state invalid', () => {
  it('re-clamps a selection whose card disappeared', () => {
    const state = press(start(), ['G']).state
    const after = reduce(state, { type: 'data' }, viewOf([[1], [4, 5], []])).state
    expect(at(after)).toEqual([0, 0])
    const gone = reduce(state, { type: 'data' }, viewOf([])).state
    expect(gone.column).toBe(0)
  })

  it('keeps the selection visible across any resize', () => {
    const wide: Numbers = Array.from({ length: 12 }, () =>
      Array.from({ length: 40 }, (_, i) => i + 1),
    )
    let state = press(start(160, 50, wide), ['9', 'G'], wide).state
    for (const [width, height] of [
      [80, 24],
      [200, 60],
      [100, 30],
      [30, 12],
      [120, 20],
    ] as const) {
      state = reduce(state, { type: 'resize', width, height }, asView(wide)).state
      expect(state.width).toBe(width)
      expect(state.column).toBe(8)
      expect(state.selected[8]).toBe(39)
    }
  })
})

// ---------------------------------------------------------------------------
// Session 9: card view and overlays
// ---------------------------------------------------------------------------

const item = (position: number, text: string, done = false) => ({
  id: `99999999-9999-4999-8999-${String(position).padStart(12, '0')}`,
  position,
  text,
  doneAt: done ? '2026-08-18T10:00:00.000Z' : null,
  doneBy: done ? 'rahul' : null,
})

const DETAIL = view(
  [
    column('todo', 'Todo', 0, 'backlog'),
    column('doing', 'Doing', 1, 'in_progress'),
    column('done', 'Done', 2, 'terminal'),
  ],
  [
    card(7, {
      title: 'Fix GitHub OAuth',
      assignees: ['priya'],
      labels: ['bug', 'auth'],
      checklist: [item(1, 'Fix state', true), item(2, 'Refresh tokens'), item(3, 'Tests')],
    }),
    card(8, { title: 'Write docs', labels: ['docs'] }),
    card(9, { column: 'doing', title: 'Rate limits', assignees: ['rahul'] }),
  ],
)

/** The board with #7 open in the card view. */
function onCard(height = 30) {
  return press(start(120, height, DETAIL), ['enter'], DETAIL).state
}

describe('card view keys (§8.4, card column)', () => {
  it('esc, q and Ctrl-C go back to the board, keeping the selection', () => {
    for (const key of ['escape', 'q', 'ctrl-c']) {
      const { state, effects } = press(onCard(), [key], DETAIL)
      expect(state).toMatchObject({ screen: 'board', cardNo: null, column: 0 })
      expect(state.selected[0]).toBe(0)
      expect(effects).toEqual([{ type: 'close', cardNo: 7 }])
    }
  })

  it('j/k and the arrows scroll the body, within its length', () => {
    const short = onCard(14)
    const down = press(short, ['j', 'down', 'j'], DETAIL).state
    expect(down.cardScroll).toBe(3)
    expect(press(down, ['k', 'up'], DETAIL).state.cardScroll).toBe(1)
    const bottom = press(
      short,
      Array.from({ length: 200 }, () => 'j'),
      DETAIL,
    ).state
    expect(bottom.cardScroll).toBeGreaterThan(3)
    expect(bottom.cardScroll).toBeLessThan(200)
    expect(press(onCard(60), ['j'], DETAIL).state.cardScroll).toBe(0)
  })

  it.each([
    ['c', 'claim'],
    ['e', 'edit'],
    ['o', 'openAnchor'],
    ['g', 'openBranch'],
    ['w', 'watch'],
    ['d', 'done'],
  ])('%s → %s on the open card', (key, type) => {
    expect(press(onCard(), [key], DETAIL).effects).toEqual([{ type, cardNo: 7 }])
  })

  it('r refreshes, ? opens help', () => {
    expect(press(onCard(), ['r'], DETAIL).effects).toEqual([{ type: 'refresh' }])
    const help = press(onCard(), ['?'], DETAIL).state
    expect(help.help).toBe(true)
    expect(press(help, ['x'], DETAIL).state).toMatchObject({ help: false, screen: 'card' })
  })

  it('m, a, C and D open the same overlays as on the board', () => {
    expect(press(onCard(), ['m'], DETAIL).state.overlay).toMatchObject({
      purpose: 'move',
      cardNo: 7,
    })
    expect(press(onCard(), ['a'], DETAIL).state.overlay).toMatchObject({ purpose: 'assign' })
    expect(press(onCard(), ['C'], DETAIL).state.overlay).toMatchObject({ purpose: 'comment' })
    expect(press(onCard(), ['D'], DETAIL).state.overlay).toMatchObject({ kind: 'confirm' })
  })

  it('board-only keys do nothing here', () => {
    const state = onCard()
    for (const key of ['h', 'l', 'n', '/', 'f', '1', 'G', 'enter']) {
      expect(press(state, [key], DETAIL)).toEqual({ state, effects: [] })
    }
  })

  it('x opens the checklist on the first open item; + adds one', () => {
    const list = press(onCard(), ['x'], DETAIL).state
    expect(list.overlay).toEqual({ kind: 'checklist', cardNo: 7, index: 1 })
    expect(press(onCard(), ['+'], DETAIL).state.overlay).toMatchObject({
      kind: 'input',
      purpose: 'item',
      cardNo: 7,
    })
  })

  it('x on a card with no checklist goes straight to adding an item', () => {
    const state = press(start(120, 30, DETAIL), ['j', 'enter', 'x'], DETAIL).state
    expect(state.overlay).toMatchObject({ kind: 'input', purpose: 'item', cardNo: 8 })
  })

  it('returns to the board when the open card is deleted elsewhere', () => {
    const gone = view([column('todo', 'Todo', 0, 'backlog')], [card(8, { title: 'Write docs' })])
    const state = reduce(onCard(), { type: 'data' }, gone).state
    expect(state).toMatchObject({ screen: 'board', cardNo: null })
  })
})

describe('checklist overlay', () => {
  it('j/k choose, x/space/enter toggle the chosen item', () => {
    const list = press(onCard(), ['x'], DETAIL).state
    expect(press(list, ['x'], DETAIL).effects).toEqual([
      { type: 'check', cardNo: 7, position: 2, done: true },
    ])
    expect(press(list, ['k', ' '], DETAIL).effects).toEqual([
      { type: 'check', cardNo: 7, position: 1, done: false },
    ])
    expect(press(list, ['j', 'j', 'enter'], DETAIL).effects).toEqual([
      { type: 'check', cardNo: 7, position: 3, done: true },
    ])
    // Stays open, so several items can be ticked in a row.
    expect(press(list, ['x'], DETAIL).state.overlay).toMatchObject({ kind: 'checklist' })
  })

  it('+ switches to a new item; esc closes', () => {
    const list = press(onCard(), ['x'], DETAIL).state
    const adding = press(list, ['+', 'N', 'e', 'w', 'enter'], DETAIL)
    expect(adding.effects).toEqual([{ type: 'addItem', cardNo: 7, text: 'New' }])
    expect(adding.state.overlay).toBeNull()
    expect(press(list, ['escape'], DETAIL).state.overlay).toBeNull()
  })
})

describe('pickers', () => {
  it('the move picker starts on the current column and moves on enter', () => {
    const picker = press(start(120, 30, DETAIL), ['m'], DETAIL).state
    expect(picker.overlay).toMatchObject({
      index: 0,
      options: [{ value: 'todo', current: true }, {}, {}],
    })
    expect(press(picker, ['j', 'enter'], DETAIL)).toMatchObject({
      state: { overlay: null },
      effects: [{ type: 'move', cardNo: 7, column: 'doing' }],
    })
    expect(press(picker, ['down', 'down', 'down', 'enter'], DETAIL).effects).toEqual([
      { type: 'move', cardNo: 7, column: 'done' },
    ])
    // Picking where it already is, or cancelling, does nothing.
    expect(press(picker, ['enter'], DETAIL).effects).toEqual([])
    for (const key of ['escape', 'q', 'ctrl-c'])
      expect(press(picker, [key], DETAIL)).toMatchObject({ state: { overlay: null }, effects: [] })
  })

  it('the member picker lists you first and toggles an assignee', () => {
    const picker = press(start(120, 30, DETAIL), ['a'], DETAIL).state
    expect(picker.overlay).toMatchObject({
      options: [
        { value: 'rahul', label: '@rahul (you)', current: false },
        { value: 'priya', current: true },
        { value: 'sam', current: false },
      ],
    })
    expect(press(picker, ['enter'], DETAIL).effects).toEqual([
      { type: 'assign', cardNo: 7, handle: 'rahul', on: true },
    ])
    expect(press(picker, ['j', 'enter'], DETAIL).effects).toEqual([
      { type: 'assign', cardNo: 7, handle: 'priya', on: false },
    ])
  })
})

describe('inputs', () => {
  it('n creates a card in the current column from what was typed', () => {
    const typing = press(
      start(120, 30, DETAIL),
      ['l', 'n', 'S', 'h', 'i', 'p', 'backspace', 'p'],
      DETAIL,
    )
    expect(typing.state.overlay).toMatchObject({ text: 'Ship' })
    expect(press(typing.state, ['enter'], DETAIL).effects).toEqual([
      { type: 'create', column: 'doing', title: 'Ship' },
    ])
  })

  it('typed letters are text, not keys: q does not quit, j does not move', () => {
    const typing = press(start(120, 30, DETAIL), ['n', 'q', 'j', 'D'], DETAIL)
    expect(typing.effects).toEqual([])
    expect(typing.state.overlay).toMatchObject({ text: 'qjD' })
    expect(typing.state.column).toBe(0)
  })

  it('an empty input, or esc, sends nothing', () => {
    expect(press(start(120, 30, DETAIL), ['n', ' ', 'enter'], DETAIL).effects).toEqual([])
    expect(press(start(120, 30, DETAIL), ['n', 'x', 'escape'], DETAIL)).toMatchObject({
      state: { overlay: null },
      effects: [],
    })
  })

  it('the comment composer is multiline: enter adds a line, Ctrl-D sends', () => {
    const composing = press(start(120, 30, DETAIL), ['C', 'h', 'i', 'enter', 'y', 'o'], DETAIL)
    expect(composing.state.overlay).toMatchObject({ text: 'hi\nyo', multiline: true })
    expect(composing.effects).toEqual([])
    expect(press(composing.state, ['ctrl-d'], DETAIL).effects).toEqual([
      { type: 'comment', cardNo: 7, body: 'hi\nyo' },
    ])
  })

  it('a paste lands in the input; single-line inputs fold its newlines', () => {
    const composing = press(start(120, 30, DETAIL), ['C'], DETAIL).state
    const pasted = reduce(composing, { type: 'paste', text: 'one\ntwo' }, DETAIL).state
    expect(pasted.overlay).toMatchObject({ text: 'one\ntwo' })
    const naming = press(start(120, 30, DETAIL), ['n'], DETAIL).state
    expect(reduce(naming, { type: 'paste', text: 'one\ntwo' }, DETAIL).state.overlay).toMatchObject(
      {
        text: 'one two',
      },
    )
    // With nothing open a paste is ignored, never read as keys.
    const idle = start(120, 30, DETAIL)
    expect(reduce(idle, { type: 'paste', text: 'qq' }, DETAIL)).toEqual({
      state: idle,
      effects: [],
    })
  })
})

describe('confirm', () => {
  it('y or enter deletes; n, esc or q keeps', () => {
    const asking = press(start(120, 30, DETAIL), ['D'], DETAIL).state
    for (const key of ['y', 'enter'])
      expect(press(asking, [key], DETAIL).effects).toEqual([{ type: 'delete', cardNo: 7 }])
    for (const key of ['n', 'escape', 'q'])
      expect(press(asking, [key], DETAIL)).toMatchObject({ state: { overlay: null }, effects: [] })
    expect(press(asking, ['x'], DETAIL).state.overlay).toMatchObject({ kind: 'confirm' })
  })

  it('deleting the open card goes back to the board', () => {
    const { state } = press(onCard(), ['D', 'y'], DETAIL)
    expect(state).toMatchObject({ screen: 'board', overlay: null })
  })
})

describe('search and filter', () => {
  it('/ narrows the board as you type; enter keeps it, esc on the board clears it', () => {
    const searching = press(start(120, 30, DETAIL), ['/', 'd', 'o', 'c'], DETAIL).state
    expect(searching.query).toBe('doc')
    // Only #8 matches, so the selection lands on it.
    expect(press(searching, ['enter', 'enter'], DETAIL).effects).toEqual([
      { type: 'open', cardNo: 8 },
    ])
    const kept = press(searching, ['enter'], DETAIL).state
    expect(kept).toMatchObject({ overlay: null, query: 'doc' })
    expect(press(kept, ['escape'], DETAIL).state.query).toBe('')
  })

  it('esc inside the search box cancels the search', () => {
    const state = press(start(120, 30, DETAIL), ['/', 'x', 'escape'], DETAIL).state
    expect(state).toMatchObject({ overlay: null, query: '' })
  })

  it('f filters to mine, an assignee or a label', () => {
    const picker = press(start(120, 30, DETAIL), ['f'], DETAIL).state
    expect(picker.overlay).toMatchObject({
      options: [
        { value: 'all', current: true },
        { value: 'mine' },
        { value: '@priya' },
        { value: '@rahul' },
        { value: '#auth' },
        { value: '#bug' },
        { value: '#docs' },
      ],
    })
    const mine = press(picker, ['j', 'enter'], DETAIL).state
    expect(mine.filter).toEqual({ kind: 'mine' })
    // Only #9 (in Doing) is mine: enter in Doing opens it.
    expect(press(mine, ['l', 'enter'], DETAIL).effects).toEqual([{ type: 'open', cardNo: 9 }])
    const label = press(picker, ['j', 'j', 'j', 'j', 'j', 'j', 'enter'], DETAIL).state
    expect(label.filter).toEqual({ kind: 'label', label: 'docs' })
    expect(press(label, ['escape'], DETAIL).state.filter).toBeNull()
  })
})
