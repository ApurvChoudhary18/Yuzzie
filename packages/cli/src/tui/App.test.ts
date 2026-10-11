/**
 * The rendered board (§18 Session 8 acceptance): snapshots at three terminal
 * sizes for four boards, keys through a real Ink input pipeline, and resizes.
 */
import { render } from 'ink-testing-library'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cells } from '../cells.js'
import {
  card,
  column,
  FIXTURES,
  mount,
  SIZES,
  settled,
  staticSource,
  tick,
  view,
} from './__tests__/fixtures.js'
import { App } from './App.js'
import { renderPlain } from './frame.js'
import type { BoardView } from './layout.js'
import { initialNav, reduce } from './state.js'
import { textWidth } from './text.js'
import { makeTheme } from './theme.js'

const mounted: Array<{ unmount(): void }> = []
afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount()
})

function open(name: string, columns: number, rows: number) {
  const board = FIXTURES[name]
  if (board === undefined) throw new Error(`no fixture ${name}`)
  const harness = mount(board, columns, rows)
  mounted.push(harness.instance)
  return harness
}

function lines(frame: string): string[] {
  // Ink trims trailing spaces from each line but never drops a line.
  return frame.split('\n')
}

describe('snapshots', () => {
  for (const name of Object.keys(FIXTURES)) {
    for (const [columns, rows] of SIZES) {
      it(`${name} at ${columns}×${rows}`, async () => {
        const { terminal } = open(name, columns, rows)
        await tick()
        const frame = terminal.lastFrame()
        const output = lines(frame)
        expect(output).toHaveLength(rows)
        for (const line of output) expect(textWidth(line)).toBe(columns)
        expect(output[0]?.endsWith('┐')).toBe(true)
        expect(output.at(-1)).toMatch(/^└─+┘$/)
        expect(`\n${frame}`).toMatchSnapshot()
        // The pre-Ink first paint (run.ts) must be the frame Ink then draws over it.
        const board = FIXTURES[name] as BoardView
        const nav = reduce(
          initialNav(columns, rows, board.columns.length),
          { type: 'data' },
          board,
        ).state
        const early = renderPlain(board, nav, makeTheme('plain', 'unicode'))
        expect(lines(early).map((line) => line.trimEnd())).toEqual(output)
      })
    }
  }
})

describe('wide characters', () => {
  // Emoji and CJK take two terminal cells each; a line measured in code points overflows.
  const board = view(
    [
      column('todo', 'Todo', 0, 'backlog'),
      column('doing', 'Doing', 1, 'in_progress'),
      column('done', 'Done', 2, 'terminal'),
    ],
    [
      card(3, { title: 'Émoji 🚀 test with 日本語 title', assignees: ['bob'] }),
      card(4, { column: 'doing', title: '日本語のタイトルがとても長いカード 🚀🚀🚀🚀' }),
      card(5, { column: 'done', title: 'Plain title' }),
    ],
  )
  const theme = makeTheme('plain', 'unicode')

  for (const [columns, rows] of [...SIZES, [60, 20], [40, 12]] as const) {
    it(`keep every line exactly ${columns} cells wide, overlays included`, () => {
      let nav = reduce(
        initialNav(columns, rows, board.columns.length),
        { type: 'data' },
        board,
      ).state
      for (const key of [null, '?', 'escape', 'm', 'escape', 'enter']) {
        if (key !== null) nav = reduce(nav, { type: 'key', key }, board).state
        for (const line of renderPlain(board, nav, theme).split('\n'))
          expect(cells(line), `${key}: ${line}`).toBe(columns)
      }
    })
  }
})

describe('the narrow list view', () => {
  // Twelve columns of two cards at the smallest size: the ↑ and ↓ rows are always in play.
  const board = FIXTURES['twelve columns'] as BoardView
  const theme = makeTheme('plain', 'unicode')
  const walk = board.columns.flatMap(() => ['j', 'j', 'l'])
  const first = () =>
    reduce(initialNav(40, 12, board.columns.length), { type: 'data' }, board).state

  it('keeps the selected card on screen, never under the ↑ or ↓ row', () => {
    let nav = first()
    for (const [step, key] of walk.entries()) {
      nav = reduce(nav, { type: 'key', key }, board).state
      const selected = board.columns[nav.column]?.cards[nav.selected[nav.column] ?? 0]
      expect(renderPlain(board, nav, theme), `step ${step}: ${key}`).toContain(
        `▸#${selected?.number} `,
      )
    }
  })

  it('counts every line the ↑ and ↓ rows hide', () => {
    // 12 column headers and 24 cards.
    const total = board.columns.reduce((sum, column) => sum + 1 + column.cards.length, 0)
    let nav = first()
    for (const key of walk) {
      nav = reduce(nav, { type: 'key', key }, board).state
      const frame = renderPlain(board, nav, theme)
      const shown = frame
        .split('\n')
        .filter((line) => /^│ (?:[▸ ]#\d+ |STAGE \d+ \(\d+\))/.test(line)).length
      const up = Number(/↑ (\d+) more/.exec(frame)?.[1] ?? 0)
      const down = Number(/↓ (\d+) more/.exec(frame)?.[1] ?? 0)
      expect(up + shown + down, frame).toBe(total)
    }
  })
})

describe('keys through Ink', () => {
  it('moves the selection and reports card actions (ink-testing-library)', async () => {
    const effects: unknown[] = []
    const board = FIXTURES['three columns']
    if (board === undefined) throw new Error('missing fixture')
    const app = render(
      createElement(App, {
        source: staticSource(board),
        theme: makeTheme('plain', 'unicode'),
        onEffect: (effect) => effects.push(effect),
        width: 100,
        height: 30,
      }),
    )
    mounted.push(app)
    await tick()
    expect(app.lastFrame()).toContain('▸#12')
    app.stdin.write('j')
    await tick()
    expect(app.lastFrame()).toContain('▸#14')
    app.stdin.write('l')
    await tick()
    app.stdin.write('m')
    await tick()
    expect(app.lastFrame()).toContain('Move #15 to')
    app.stdin.write('j')
    await tick()
    app.stdin.write('\r')
    await tick()
    app.stdin.write('\r')
    await tick()
    expect(effects).toEqual([
      { type: 'move', cardNo: 15, column: 'done' },
      { type: 'open', cardNo: 15 },
    ])
  })

  it('keys that arrive together are each acted on', async () => {
    // Typed fast, over a slow link, or while the app was still starting.
    const { keyboard, terminal } = open('three columns', 160, 50)
    await settled(terminal)
    keyboard.write('lj')
    await settled(terminal)
    expect(terminal.lastFrame()).toContain('▸#18')
  })

  it('a bracketed paste is text in an input, and nothing at all on the board', async () => {
    const { keyboard, terminal, effects } = open('three columns', 160, 50)
    await settled(terminal)
    // On the board: "qD" pasted must not quit or delete anything.
    keyboard.write('\u001b[200~qDy\u001b[201~')
    await settled(terminal)
    expect(effects).toEqual([])
    expect(terminal.lastFrame()).toContain('▸#12')

    keyboard.write('C')
    await settled(terminal)
    keyboard.write('\u001b[200~first line\nsecond q line\u001b[201~')
    await settled(terminal)
    const frame = terminal.lastFrame()
    expect(frame).toContain('first line')
    expect(frame).toContain('second q line')
    keyboard.write('\u0004')
    await settled(terminal)
    expect(effects).toEqual([{ type: 'comment', cardNo: 12, body: 'first line\nsecond q line' }])
  })

  it('turns a lone g into "open branch" after the gg window', async () => {
    const { keyboard, effects } = open('three columns', 160, 50)
    await tick()
    keyboard.write('g')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(effects).toEqual([{ type: 'openBranch', cardNo: 12 }])
  })

  it('opens and closes help', async () => {
    const { keyboard, terminal } = open('three columns', 160, 50)
    await tick()
    keyboard.write('?')
    await tick()
    expect(terminal.lastFrame()).toMatch(/help/i)
    const withHelp = terminal.lastFrame()
    keyboard.write('x')
    await tick()
    expect(terminal.lastFrame()).not.toBe(withHelp)
  })
})

describe('resize', () => {
  const sizes = [
    [160, 50],
    [80, 24],
    [40, 14],
    [20, 8],
    [101, 13],
    [99, 60],
    [240, 70],
    [100, 30],
  ] as const

  for (const name of Object.keys(FIXTURES)) {
    it(`${name}: every frame fits the terminal it was drawn for`, async () => {
      const { terminal, keyboard } = open(name, 120, 40)
      await settled(terminal)
      keyboard.write('G')
      await settled(terminal)
      for (const [columns, rows] of sizes) {
        terminal.resize(columns, rows)
        // Wait for the redraw itself, not a guess at how long it takes.
        await settled(terminal)
        const output = lines(terminal.lastFrame())
        expect(output, `${columns}×${rows}`).toHaveLength(rows)
        for (const line of output) expect(textWidth(line)).toBeLessThanOrEqual(columns)
      }
    })
  }
})
