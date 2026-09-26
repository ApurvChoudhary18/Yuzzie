/**
 * The TUI in a real terminal, for what only a real terminal shows: raw mode,
 * echo, and keys typed while the app is still starting.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@yuzie/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { machine } from './__support__/cli.js'
import { startTui, type Tui } from './__support__/tty.js'
import {
  createBoard,
  signIn,
  startWorld,
  type User,
  unique,
  type World,
} from './__support__/world.js'

let world: World
let rahul: User
let slug: string
let tui: Tui | null = null

beforeEach(async () => {
  home = undefined as never
  cwd = undefined as never
  world = await startWorld()
  rahul = await signIn(world.baseUrl, unique('rahul'))
  slug = await createBoard(world.baseUrl, rahul)
  const board = await createClient({ baseUrl: world.baseUrl, token: rahul.token }).connect(slug, {
    realtime: false,
  })
  await board.cards.create({ title: 'Login flow' })
  await board.cards.create({ title: 'Rate limits', column: 'doing' })
  await board.close()
})

afterEach(async () => {
  tui?.kill()
  tui = null
  await world.close()
})

let home: ReturnType<typeof machine>
let cwd: string

function open(args: string[] = []): Tui {
  home ??= machine(world.baseUrl)
  cwd ??= realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-tui-')))
  tui = startTui({
    cwd,
    env: { ...home.env, YUZIE_TOKEN: rahul.token, YUZIE_BOARD: slug },
    args,
    cols: 100,
    rows: 24,
  })
  return tui
}

describe('start-up', () => {
  it('keys typed while it starts are never echoed over the board', async () => {
    // Once, to fill the cache.
    const first = open()
    await first.waitFor('synced', 'the first run to sync')
    await first.quit()

    // Offline, the first frame already says so: a person reads it and types
    // at once, while the app is still loading. Before raw mode was set at the
    // first paint, those keys echoed over the frame and knocked it out of line.
    const tui = open(['--offline'])
    await tui.waitFor('⚠ offline', 'the cached board, offline')
    await tui.press('l', 'd')
    await new Promise((resolve) => setTimeout(resolve, 1_500))

    const screen = tui.screen()
    expect(screen[0]).toMatch(/^┌ yuzie · /)
    expect(screen.at(-1)).toMatch(/^└─+┘$/)
    // …and the keys were acted on: `l` then `d` (done) queued offline.
    await tui.waitFor('⚠ offline · 1 queued', 'the queued write')
  })

  it('quits cleanly, leaving the terminal as it was', async () => {
    const tui = open()
    await tui.waitFor('synced', 'synced')
    expect(await tui.quit()).toBe(0)
  })
})
