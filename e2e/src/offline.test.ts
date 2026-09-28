/**
 * §18 Session 13 — the tool is never blocked by the network — against a real
 * server, with a real network between it and the CLI that can hang or refuse:
 *
 *   - a network black hole: ten mixed writes offline, then one sync makes the
 *     server match exactly, with ten new events and no duplicates;
 *   - a poison op (a write to a card deleted meanwhile) is set aside after
 *     three attempts, reported, and does not hold up the rest;
 *   - two clients edit the same card offline: one wins, the other is told
 *     exactly what happened;
 *   - `yuzie list` with the server down, labelled as cached with its age.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Card, type OutputKind, parseOutput } from '@yuzie/core'
import { createClient } from '@yuzie/sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type CliResult,
  type Machine,
  machine,
  repository,
  start,
  yuzie,
} from './__support__/cli.js'
import { Link, startWorld, unique, type World } from './__support__/world.js'

let world: World
let link: Link
/** Rahul, whose network goes through `link`. */
let rahul: Machine
let repo: string
let slug: string
let rahulToken: string
const cleanup: string[] = []

async function approve(userCode: string, handle: string): Promise<void> {
  const response = await fetch(`${world.baseUrl}/auth/device/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userCode, handle }),
  })
  if (response.status !== 200) throw new Error(`approve failed: ${response.status}`)
}

async function signInAs(target: Machine, cwd: string, handle: string): Promise<void> {
  const running = start(['login'], { cwd, env: target.env })
  const [, code] = await running.waitFor(/Code: (\S+)/)
  await approve(code as string, handle)
  const result = await running.done
  if (result.code !== 0) throw new Error(`login failed: ${result.stderr}`)
}

function run(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; as?: Machine } = {},
): Promise<CliResult> {
  const who = options.as ?? rahul
  return yuzie(args, { cwd: options.cwd ?? repo, env: { ...who.env, ...options.env } })
}

async function timed(args: string[]): Promise<CliResult & { ms: number }> {
  const started = performance.now()
  const result = await run(args)
  return { ...result, ms: performance.now() - started }
}

function json<T>(result: CliResult, kind: OutputKind): T {
  expect(result.code, `${result.stdout}${result.stderr}`).toBe(0)
  const document = JSON.parse(result.stdout) as { kind: string; data: T }
  expect(document.kind).toBe(kind)
  parseOutput(document)
  return document.data
}

/** The server's own view, straight from the API. */
async function server() {
  const board = await createClient({ baseUrl: world.baseUrl, token: rahulToken }).connect(slug, {
    realtime: false,
  })
  try {
    const events = (await board.boards.events(0, 500)).events
    return { cards: Object.values(board.state.cards), events }
  } finally {
    await board.close()
  }
}

beforeAll(async () => {
  world = await startWorld({ devicePollIntervalSeconds: 1 })
  link = await Link.open(world.baseUrl)
  rahul = machine(link.baseUrl)
  cleanup.push(rahul.home)
  repo = repository(`git@github.com:acme/${unique('offline')}.git`)
  cleanup.push(repo)
  await signInAs(rahul, repo, 'rahul')
  const init = await run(['init', '--yes'])
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`)
  slug = (
    JSON.parse(readFileSync(join(repo, '.yuzie', 'config.json'), 'utf8')) as { board: string }
  ).board
  const credentials = JSON.parse(
    readFileSync(join(rahul.home, '.yuzie', 'credentials'), 'utf8'),
  ) as {
    servers: Record<string, { token: string }>
  }
  rahulToken = credentials.servers[link.baseUrl]?.token as string
}, 120_000)

afterAll(async () => {
  await link.close()
  await world.close()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  link.restore()
})

describe('network black hole (§18 Session 13)', () => {
  it('ten mixed writes offline; one sync makes the server match, ten new events, no duplicates', async () => {
    for (const title of ['Login flow', 'Rate limits', 'Docs']) await run(['add', title])
    const before = await server()

    link.blackhole()
    const writes: string[][] = [
      ['add', 'Offline A'],
      ['add', 'Offline B'],
      ['move', 'Login flow', 'doing'],
      ['assign', 'Rate limits', '@rahul'],
      ['comment', 'Login flow', 'written on a plane'],
      ['label', 'Docs', 'bug'],
      ['priority', 'Docs', 'p1'],
      ['due', 'Rate limits', '2026-12-01'],
      ['check', 'Login flow', 'add', 'Repro the bug'],
      ['watch', 'Docs'],
    ]
    for (const args of writes) {
      const result = await timed(args)
      expect(result.code, `${args.join(' ')}: ${result.stderr}`).toBe(0)
      // The black hole costs the probe's budget, not a timeout.
      expect(result.ms, args.join(' ')).toBeLessThan(4_000)
      expect(result.stderr + result.stdout, args.join(' ')).toContain('queued (offline)')
    }

    // Reads work, from the cache, labelled — and show the queued changes.
    const listed = await timed(['list'])
    expect(listed.code).toBe(0)
    expect(listed.ms).toBeLessThan(4_000)
    expect(listed.stdout).toMatch(/offline · cached (just now|\S+ ago) · 10 queued/)
    expect(listed.stdout).toContain('Offline A')
    expect(listed.stdout).toContain('◌')
    const offlineRaw = await run(['list', '--json'])
    const offlineList = json<Card[]>(offlineRaw, 'CardList')
    expect(offlineList.find((card) => card.title === 'Login flow')?.column).toBe('doing')
    const offlineMeta = (JSON.parse(offlineRaw.stdout) as { meta: Record<string, unknown> }).meta
    expect(offlineMeta.provisional).toEqual([
      expect.objectContaining({ queued: true, title: 'Offline B' }),
      expect.objectContaining({ queued: true, title: 'Offline A' }),
    ])
    expect(offlineMeta).toMatchObject({ synced: false, queued: 10 })
    expect((offlineMeta.queuedCards as number[]).length).toBe(3)

    link.restore()
    const synced = await run(['sync'])
    expect(synced.code, synced.stderr).toBe(0)
    expect(synced.stdout).toContain('✓ Sent 10 queued changes')
    expect(synced.stdout).toContain('✓ In sync')

    const after = await server()
    expect(after.events.length - before.events.length).toBe(10)
    const titles = after.cards.map((card) => card.title)
    expect(titles.filter((title) => title === 'Offline A')).toHaveLength(1)
    expect(titles.filter((title) => title === 'Offline B')).toHaveLength(1)
    const byTitle = (title: string) => after.cards.find((card) => card.title === title) as Card
    expect(byTitle('Login flow')).toMatchObject({ column: 'doing' })
    expect(byTitle('Login flow').comments.map((c) => c.body)).toEqual(['written on a plane'])
    expect(byTitle('Login flow').checklist.map((i) => i.text)).toEqual(['Repro the bug'])
    expect(byTitle('Rate limits')).toMatchObject({ assignees: ['rahul'] })
    expect(byTitle('Rate limits').dueAt).toMatch(/^2026-12-01/)
    expect(byTitle('Docs')).toMatchObject({ labels: ['bug'], priority: 1, watchers: ['rahul'] })

    // The local copy agrees, with nothing left marked as queued.
    const relisted = await run(['list'])
    expect(relisted.stdout).not.toContain('◌')
    expect(relisted.stdout).toMatch(/ · synced/)
  })
})

describe('a poison op (§18 Session 13)', () => {
  it('is set aside after three attempts, reported, and does not hold up the rest', async () => {
    await run(['add', 'Doomed'])
    await run(['add', 'Fine'])
    const cards = (await server()).cards
    const doomed = cards.find((card) => card.title === 'Doomed') as Card
    const fine = cards.find((card) => card.title === 'Fine') as Card

    // Offline: a comment on a card someone is about to delete, then an unrelated move.
    expect((await run(['--offline', 'comment', String(doomed.number), 'still needed?'])).code).toBe(
      0,
    )
    expect((await run(['--offline', 'move', String(fine.number), 'doing'])).code).toBe(0)
    const board = await createClient({ baseUrl: world.baseUrl, token: rahulToken }).connect(slug, {
      realtime: false,
    })
    await board.cards.delete(doomed.number)
    await board.close()

    const first = await run(['sync'])
    expect(first.code, first.stderr).toBe(0)
    expect(first.stdout).toContain('✓ Sent 1 queued change')
    expect(first.stdout + first.stderr).toMatch(
      /comment was refused \(card_not_found: .*\); attempt 1 of 3, will retry/,
    )
    expect((await server()).cards.find((card) => card.number === fine.number)?.column).toBe('doing')

    const second = await run(['sync'])
    expect(second.stdout + second.stderr).toContain('attempt 2 of 3')

    const third = json<{ setAside: Array<{ cardNo: number; attempts: number; message: string }> }>(
      await run(['sync', '--json']),
      'SyncReport',
    )
    expect(third.setAside).toEqual([
      expect.objectContaining({ cardNo: doomed.number, attempts: 3 }),
    ])
    expect(third.setAside[0]?.message).toContain('set aside after 3 refusals')

    const doctor = await run(['doctor'])
    expect(doctor.stdout + doctor.stderr).toMatch(
      new RegExp(`set aside: #${doomed.number} comment — refused 3× \\(card_not_found`),
    )
    const again = await run(['sync'])
    expect(again.stdout + again.stderr).toContain('1 change set aside')

    const dropped = await run(['sync', '--drop-set-aside'])
    expect(dropped.stdout).toContain('Dropped 1 set-aside change')
    expect(dropped.stdout).toContain('✓ In sync')
  })
})

describe('two clients, one card, both offline (§18 Session 13)', () => {
  it('one wins; the other is told exactly what happened', async () => {
    await run(['add', 'Contested'])
    const contested = (await server()).cards.find((card) => card.title === 'Contested') as Card

    // Priya, on her own machine, with her own cache, signed in and caught up.
    const priya = machine(world.baseUrl)
    const priyaDir = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-priya-')))
    cleanup.push(priya.home, priyaDir)
    await signInAs(priya, priyaDir, 'priya')
    await run(['invite', '@priya'])
    const env = { YUZIE_BOARD: slug }
    expect((await run(['list'], { as: priya, cwd: priyaDir, env })).code).toBe(0)

    // Both change the priority while offline.
    const mine = await run(['--offline', 'priority', String(contested.number), 'p1'])
    expect(mine.stdout + mine.stderr).toContain('queued (offline)')
    const hers = await run(['--offline', 'priority', String(contested.number), 'p3'], {
      as: priya,
      cwd: priyaDir,
      env,
    })
    expect(hers.stdout + hers.stderr).toContain('queued (offline)')

    // Rahul syncs first and wins.
    const won = await run(['sync'])
    expect(won.stdout).toContain('✓ Sent 1 queued change')

    // Priya is told precisely what happened, and her copy now shows the winner.
    const lost = await run(['sync'], { as: priya, cwd: priyaDir, env })
    expect(lost.code, lost.stderr).toBe(0)
    expect(lost.stdout).toContain(
      `⟳ #${contested.number} Contested: your edit (priority) was not applied — @rahul changed it first. Now it has priority 1.`,
    )
    const shown = json<Card>(
      await run(['card', String(contested.number), '--json'], { as: priya, cwd: priyaDir, env }),
      'Card',
    )
    expect(shown.priority).toBe(1)
    expect((await server()).cards.find((card) => card.number === contested.number)?.priority).toBe(
      1,
    )
  })
})

describe('reads with the server down (§18 Session 13)', () => {
  it('yuzie list works, and says the data is cached and how old it is', async () => {
    await run(['add', 'Visible offline'])
    await run(['list'])
    for (const down of [() => link.cut(), () => link.blackhole()]) {
      down()
      const started = performance.now()
      const listed = await run(['list'])
      expect(listed.code, listed.stderr).toBe(0)
      expect(performance.now() - started).toBeLessThan(4_000)
      expect(listed.stdout).toContain('Visible offline')
      expect(listed.stdout).toMatch(/cards? · offline · cached (just now|\d+s ago|\d+m ago)/)
      expect(listed.stdout).not.toContain('online ·')
      const document = JSON.parse((await run(['list', '--json'])).stdout) as {
        meta: { synced: boolean; queued: number }
      }
      expect(document.meta).toMatchObject({ synced: false, queued: 0 })
      link.restore()
    }
  })
})

describe('sync --rebuild (§18 Session 13)', () => {
  it('rebuilds the cached board from the server and keeps queued changes', async () => {
    await run(['add', 'Rebuild me'])
    const queued = await run(['--offline', 'comment', 'Rebuild me', 'kept through the rebuild'])
    expect(queued.stdout + queued.stderr).toContain('queued (offline)')

    const rebuilt = json<{ rebuilt: boolean; sent: number; remaining: number }>(
      await run(['sync', '--rebuild', '--json']),
      'SyncReport',
    )
    expect(rebuilt).toMatchObject({ rebuilt: true, sent: 1, remaining: 0 })
    const card = (await server()).cards.find((c) => c.title === 'Rebuild me') as Card
    expect(card.comments.map((c) => c.body)).toEqual(['kept through the rebuild'])
    // The cache is whole again: listing offline still shows the board.
    link.cut()
    expect((await run(['list'])).stdout).toContain('Rebuild me')
  })
})
