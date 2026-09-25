/**
 * Every board-view keybinding in SPEC.md §8.4, through the reducer alone —
 * no React, no terminal (§18 Session 8 acceptance).
 */
import { describe, expect, it } from 'vitest'
import { type Effect, initialNav, type NavState, type Numbers, reduce } from './state.js'

/** Three columns: #1 #2 #3 | #4 #5 | (empty). A wide terminal, so board mode. */
const NUMBERS: Numbers = [[1, 2, 3], [4, 5], []]

function start(width = 160, height = 50, numbers: Numbers = NUMBERS): NavState {
  return reduce(initialNav(width, height, numbers.length), { type: 'data' }, numbers).state
}

function press(state: NavState, keys: string[], numbers: Numbers = NUMBERS) {
  let current = state
  const effects: Effect[] = []
  for (const key of keys) {
    const step = reduce(current, { type: 'key', key }, numbers)
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
    ['enter', 'open'],
    ['m', 'move'],
    ['a', 'assign'],
    ['c', 'claim'],
    ['C', 'comment'],
    ['e', 'edit'],
    ['o', 'openAnchor'],
    ['w', 'watch'],
    ['d', 'done'],
    ['D', 'delete'],
  ])('%s → %s', (key, type) => {
    const { effects } = press(start(), ['j', key])
    expect(effects).toEqual([{ type, cardNo: 2 }])
  })

  it('a lone g opens the branch once it is clear no second g is coming', () => {
    const pending = press(start(), ['l', 'g'])
    expect(pending.state.pendingG).toBe(true)
    expect(pending.effects).toEqual([])
    const timeout = reduce(pending.state, { type: 'gTimeout' }, NUMBERS)
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
    ['n', [{ type: 'new', column: 0 }]],
    ['/', [{ type: 'search' }]],
    ['f', [{ type: 'filter' }]],
    ['r', [{ type: 'refresh' }]],
    ['q', [{ type: 'quit' }]],
    ['ctrl-c', [{ type: 'quit' }]],
  ])('%s', (key, expected) => {
    expect(press(start(), [key]).effects).toEqual(expected)
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
    const after = reduce(state, { type: 'data' }, [[1], [4, 5], []]).state
    expect(at(after)).toEqual([0, 0])
    const gone = reduce(state, { type: 'data' }, []).state
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
      state = reduce(state, { type: 'resize', width, height }, wide).state
      expect(state.width).toBe(width)
      expect(state.column).toBe(8)
      expect(state.selected[8]).toBe(39)
    }
  })
})
