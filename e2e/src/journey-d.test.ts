/**
 * Journey D (SPEC.md §6.4) — two people, live — and the rest of §18 Session 10's
 * acceptance, end to end: a real server, one client through the SDK, and the
 * other through the real `yuzie` TUI in a real pseudo-terminal, read back as
 * the screen a person would see.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Board } from '@yuzie/sdk'
import { createClient } from '@yuzie/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { machine } from './__support__/cli.js'
import { startTui, type Tui } from './__support__/tty.js'
import {
  createBoard,
  eventually,
  signIn,
  startWorld,
  type User,
  unique,
  type World,
} from './__support__/world.js'

let world: World
let priya: User
let rahul: User
let slug: string
let tui: Tui | null = null
const boards: Board[] = []

beforeEach(async () => {
  world = await startWorld()
  priya = await signIn(world.baseUrl, unique('priya'))
  rahul = await signIn(world.baseUrl, unique('rahul'))
  slug = await createBoard(world.baseUrl, rahul, [priya])
})

afterEach(async () => {
  tui?.kill()
  tui = null
  for (const board of boards.splice(0)) await board.close()
  await world.close()
})

/** Priya, through the SDK, streaming. */
async function priyaBoard(): Promise<Board> {
  const board = await createClient({ baseUrl: world.baseUrl, token: priya.token }).connect(slug)
  boards.push(board)
  return board
}

/** Rahul, through the TUI. */
async function rahulTui(): Promise<Tui> {
  const home = machine(world.baseUrl)
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-tui-')))
  tui = startTui({
    cwd,
    env: { ...home.env, YUZIE_TOKEN: rahul.token, YUZIE_BOARD: slug },
    cols: 120,
    rows: 34,
  })
  return tui
}

/** Which board column (by its title) a card's title is drawn under, read off the screen. */
function columnOf(screen: string[], title: string): string | null {
  const header = screen.findIndex((line) => / TODO \(/.test(line))
  if (header === -1) return null
  const titles = [...(screen[header] ?? '').matchAll(/ ([A-Z][A-Z ]*) \(/g)].map((m) => ({
    name: m[1] as string,
    at: m.index ?? 0,
  }))
  for (let row = header + 1; row < screen.length; row += 1) {
    const line = screen[row] as string
    if (line.includes('└')) break
    const at = line.indexOf(title)
    if (at === -1) continue
    // The column is the one whose rule the title sits after: count the dividers.
    const dividers = [...line.slice(0, at).matchAll(/│/g)].length - 2
    return titles[dividers]?.name ?? null
  }
  return null
}

describe('Journey D: two people, live (§6.4)', () => {
  it('Priya moves a card; Rahul’s board shows it in Done, with a toast, within 500 ms', async () => {
    const board = await priyaBoard()
    const login = await board.cards.create({ title: 'Login flow' })
    await board.cards.create({ title: 'Rate limits' })

    const tui = await rahulTui()
    await tui.waitFor((s) => s.includes('Login flow') && s.includes('synced'), 'the board, synced')
    expect(columnOf(tui.screen(), 'Login flow')).toBe('TODO')

    const started = performance.now()
    await board.cards.move(login.number, 'done')
    await tui.waitFor(
      (screen) =>
        columnOf(screen.split('\n'), 'Login flow') === 'DONE' &&
        screen.includes(`✓ @${priya.handle} moved #${login.number} Login flow → Done`),
      'the move and its toast',
      5_000,
    )
    const elapsed = performance.now() - started
    console.log(`Journey D: move visible in the TUI after ${elapsed.toFixed(0)} ms`)
    expect(elapsed).toBeLessThan(500)
    expect(tui.text()).toMatch(/● 2 online · (\d+ working · )?synced/)
  })

  it('presence: Priya opens a card and Rahul sees her there; Rahul’s own view reaches Priya', async () => {
    const board = await priyaBoard()
    const card = await board.cards.create({ title: 'Fix GitHub OAuth' })

    const tui = await rahulTui()
    await tui.waitFor((s) => s.includes('Fix GitHub OAuth') && s.includes('synced'), 'the board')
    board.setPresence({ state: 'viewing', cardNo: card.number })

    await tui.press('\r')
    await tui.waitFor(`● @${priya.handle} is viewing this card`, 'Priya in the card footer')

    // And the other way: the TUI told the board Rahul is viewing it.
    await eventually(
      () =>
        board.presence.some(
          (person) =>
            person.handle === rahul.handle &&
            person.state === 'viewing' &&
            person.cardNo === card.number,
        ),
      'Rahul viewing the card',
    )
    // Back on the board: no longer viewing it.
    await tui.press('\u001b')
    await eventually(
      () =>
        board.presence.some(
          (person) => person.handle === rahul.handle && person.cardNo !== card.number,
        ),
      'Rahul back on the board',
    )
    // Quitting clears it altogether.
    await tui.quit()
    await eventually(
      () => !board.presence.some((person) => person.handle === rahul.handle),
      'Rahul gone',
    )
  })
})

describe('disconnect and reconcile', () => {
  it('server killed: offline in the header, still navigable, writes queue; restarted: synced, no duplicates', async () => {
    const setup = await priyaBoard()
    const first = await setup.cards.create({ title: 'Login flow' })
    const second = await setup.cards.create({ title: 'Rate limits' })
    await setup.close()
    boards.splice(0)

    const tui = await rahulTui()
    await tui.waitFor((s) => s.includes('Rate limits') && s.includes('synced'), 'the board')

    await world.stop()
    await tui.waitFor('⚠', 'the header to notice', 15_000)

    // Still navigable: the selection moves with no server at all.
    await tui.press('j')
    await tui.waitFor('▸#2 Rate limits', 'the selection to move')

    // A write while the server is gone paints at once and queues.
    await tui.press('d')
    await tui.waitFor(
      (s) => columnOf(s.split('\n'), 'Rate limits') === 'DONE',
      'the optimistic move',
    )
    await tui.waitFor('⚠ offline · 1 queued', 'the queued write', 15_000)

    await world.restart()
    await tui.waitFor(
      (s) => /online · (\d+ working · )?synced/.test(s),
      'reconnected and synced',
      40_000,
    )
    await tui.waitFor('Sent 1 queued change', 'the drain toast', 10_000)

    // Server and client agree, and the move happened exactly once.
    const check = await priyaBoard()
    expect(check.state.cards[second.number]?.column).toBe('done')
    expect(check.state.cards[first.number]?.column).toBe('todo')
    expect(Object.keys(check.state.cards)).toHaveLength(2)
    const events = (await check.boards.events(0, 500)).events
    const moves = events.filter(
      (event) => event.type === 'card.moved' && event.cardNo === second.number,
    )
    expect(moves).toHaveLength(1)
    expect(columnOf(tui.screen(), 'Rate limits')).toBe('DONE')
  })
})
