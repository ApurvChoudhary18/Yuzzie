/**
 * SPEC.md §18 Session 14 acceptance, end to end: B watches #18, A comments, B's
 * open board shows it, and `yuzie activity --card 18` includes it — paginated,
 * stable, and valid under `--json`. Search reaches comments online and offline.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOutput } from '@yuzie/core'
import { createClient } from '@yuzie/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Machine, machine, yuzie } from './__support__/cli.js'
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
let priya: User
let slug: string
let computer: Machine
let cwd: string
let tui: Tui | null = null

beforeAll(async () => {
  world = await startWorld()
  rahul = await signIn(world.baseUrl, unique('rahul'))
  priya = await signIn(world.baseUrl, unique('priya'))
  slug = await createBoard(world.baseUrl, rahul, [priya])
  const board = await createClient({ baseUrl: world.baseUrl, token: rahul.token }).connect(slug, {
    realtime: false,
  })
  for (let number = 1; number <= 18; number += 1)
    await board.cards.create({ title: number === 18 ? 'Fix GitHub OAuth' : `Card ${number}` })
  await board.close()
  computer = machine(world.baseUrl)
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-watch-')))
})

afterAll(async () => {
  tui?.kill()
  await world?.close()
})

/** Priya's CLI. */
function asPriya(args: string[]) {
  return yuzie(args, {
    cwd,
    env: { ...computer.env, YUZIE_TOKEN: priya.token, YUZIE_BOARD: slug },
  })
}

async function json(args: string[]) {
  const result = await asPriya([...args, '--json'])
  expect(result.code, `${args.join(' ')}: ${result.stdout}${result.stderr}`).toBe(0)
  const document = JSON.parse(result.stdout) as {
    kind: string
    data: Array<Record<string, unknown>>
    meta: Record<string, unknown>
  }
  parseOutput(document)
  return document
}

async function comment(cardNo: number, body: string): Promise<void> {
  const board = await createClient({ baseUrl: world.baseUrl, token: rahul.token }).connect(slug, {
    realtime: false,
  })
  await board.cards.comment(cardNo, body)
  await board.close()
}

describe('watching (§18 Session 14)', () => {
  it('B watches #18, A comments: B’s board says so, and activity has it', async () => {
    expect((await asPriya(['watch', '18'])).code).toBe(0)

    tui = startTui({
      cwd,
      env: { ...computer.env, YUZIE_TOKEN: priya.token, YUZIE_BOARD: slug },
      args: [],
      cols: 120,
      rows: 30,
    })
    await tui.waitFor('synced', 'priya’s board to sync')

    await comment(18, 'Check the redirect_uri whitelist too')
    await tui.waitFor(
      (screen) => screen.includes('★') && screen.includes(`@${rahul.handle} commented on #18`),
      'the watched-card toast',
    )

    const activity = await json(['activity', '--card', '18'])
    expect(activity.kind).toBe('EventList')
    const created = activity.data.find((event) => event.type === 'comment.created')
    expect(created).toMatchObject({ actor: rahul.handle, cardNo: 18 })

    // A comment's author starts watching (auto-watch is on by default).
    const card = await json(['card', '18'])
    expect((card.data as unknown as { watchers: string[] }).watchers).toEqual(
      [priya.handle, rahul.handle].sort(),
    )

    // The board activity drawer has it too.
    await tui.press('A')
    await tui.waitFor('Activity', 'the activity drawer')
    await tui.waitFor('commented', 'the comment in the drawer')
    await tui.quit()
    tui = null
  })

  it('activity pages backwards with a stable cursor; --author narrows it', async () => {
    await comment(18, 'second')
    await comment(18, 'third')
    const first = await json(['activity', '--card', '18', '--limit', '2'])
    expect(first.data).toHaveLength(2)
    const next = first.meta.next as number
    expect(next).toBe(first.data[0]?.seq)

    const second = await json(['activity', '--card', '18', '--limit', '2', '--before', `${next}`])
    const seqs = [...second.data, ...first.data].map((event) => event.seq as number)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    // The same page twice is the same page.
    expect((await json(['activity', '--card', '18', '--limit', '2'])).data).toEqual(first.data)

    const human = await asPriya(['activity', '--card', '18', '--limit', '2'])
    expect(human.stdout).toContain(`Older: yuzie activity --card 18 --limit 2 --before ${next}`)

    const mine = await json(['activity', '--author', priya.handle])
    expect(mine.data.every((event) => event.actor === priya.handle)).toBe(true)
    expect(mine.data.length).toBeGreaterThan(0)
  })

  it('search reaches comments, online through the server and offline from the cache', async () => {
    const online = await json(['list', '--search', 'whitelist'])
    expect(online.data.map((card) => card.number)).toEqual([18])
    const offline = await json(['list', '--search', 'whitelist', '--offline'])
    expect(offline.data.map((card) => card.number)).toEqual([18])
    expect((await json(['list', '--watching'])).data.map((card) => card.number)).toEqual([18])
  })
})
