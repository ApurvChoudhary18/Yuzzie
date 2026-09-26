/**
 * The rendered board (§18 Session 8 acceptance): snapshots at three terminal
 * sizes for four boards, keys through a real Ink input pipeline, and resizes.
 */
import { render } from 'ink-testing-library'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { FIXTURES, mount, SIZES, settled, staticSource, tick } from './__tests__/fixtures.js'
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
      await tick()
      keyboard.write('G')
      await tick()
      for (const [columns, rows] of sizes) {
        terminal.resize(columns, rows)
        await tick()
        const output = lines(terminal.lastFrame())
        expect(output, `${columns}×${rows}`).toHaveLength(rows)
        for (const line of output) expect(textWidth(line)).toBeLessThanOrEqual(columns)
      }
    })
  }
})
