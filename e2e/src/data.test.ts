/**
 * The rest of §7.2 and §14.3 (§18 "Session 18"), through the built binary
 * against a real server: link and unlink, export and import, deleting an
 * account, and `yuzie serve`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@yuzie/sdk'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type Machine, machine, repository, start, yuzie } from './__support__/cli.js'
import {
  createBoard,
  freshDatabase,
  signIn,
  startWorld,
  type User,
  unique,
  type World,
} from './__support__/world.js'

let world: World
let owner: User
let slug: string
const cleanup: string[] = []

beforeAll(async () => {
  world = await startWorld()
  owner = await signIn(world.baseUrl, unique('owner'))
  slug = await createBoard(world.baseUrl, owner)
})

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

afterAll(async () => {
  await world.close()
})

function as(user: User): { computer: Machine; repo: string; env: NodeJS.ProcessEnv } {
  const computer = machine(world.baseUrl)
  const repo = repository()
  cleanup.push(computer.home, repo)
  return { computer, repo, env: { ...computer.env, YUZIE_TOKEN: user.token } }
}

describe('yuzie link / unlink (§7.2)', () => {
  it('attaches a repository to an existing board, and detaches it', async () => {
    const { repo, env } = as(owner)
    const linked = await yuzie(['link', slug], { cwd: repo, env })
    expect(linked.stderr).toBe('')
    expect(linked.code).toBe(0)
    expect(linked.stdout).toContain(`✓ Linked payments-api to "${slug}"`)
    const config = JSON.parse(readFileSync(join(repo, '.yuzie', 'config.json'), 'utf8'))
    expect(config).toMatchObject({ version: 1, board: slug, server: world.baseUrl })
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('.yuzie/cache/')

    // Linked: board commands work with no --board.
    expect((await yuzie(['list', '--json'], { cwd: repo, env })).code).toBe(0)
    expect((await yuzie(['link', slug], { cwd: repo, env })).stdout).toContain('Already linked')

    const unlinked = await yuzie(['unlink'], { cwd: repo, env })
    expect(unlinked.code).toBe(0)
    expect(unlinked.stdout).toContain(`✓ Unlinked payments-api from ${slug}`)
    const after = JSON.parse(readFileSync(join(repo, '.yuzie', 'config.json'), 'utf8'))
    expect(after.board).toBeUndefined()
    expect(after.server).toBe(world.baseUrl)
    // The board is still on the server.
    const boards = await createClient({ baseUrl: world.baseUrl, token: owner.token }).boards.list()
    expect(boards.some((board) => board.slug === slug)).toBe(true)
    expect((await yuzie(['list'], { cwd: repo, env })).code).toBe(2)
  })

  it('refuses a board you are not on (exit 4), and outside git (exit 8)', async () => {
    const stranger = await signIn(world.baseUrl, unique('stranger'))
    const { repo, env, computer } = as(stranger)
    const refused = await yuzie(['link', slug], { cwd: repo, env })
    expect(refused.code).toBe(4)
    expect(refused.stderr).toContain(`No board "${slug}"`)
    expect((await yuzie(['link', slug], { cwd: computer.home, env })).code).toBe(8)
  })
})

describe('yuzie export / import (§7.2, §14.3)', () => {
  it('imports a markdown checklist, exports it three ways, and imports the export back', async () => {
    const { repo, env } = as(owner)
    const board = { ...env, YUZIE_BOARD: slug }
    writeFileSync(
      join(repo, 'plan.md'),
      [
        '# Launch',
        '',
        '## Doing',
        '',
        `- [ ] Write the docs (#1, @${owner.handle}, p1, docs)`,
        '  > Every command, with examples.',
        '  - [x] Outline',
        '  - [ ] Draft',
        '',
        '## Nowhere',
        '',
        '- [ ] Lands in Todo',
        '- [x] Pick a name',
      ].join('\n'),
    )

    const dry = await yuzie(['import', 'plan.md', '--dry-run'], { cwd: repo, env: board })
    expect(dry.code).toBe(0)
    expect(dry.stdout).toContain('Would import 3 cards: Todo 1, Doing 1, Done 1')
    expect(dry.stdout).toContain(
      'no column "Nowhere" on this board: 1 card to Todo, 1 ticked card to Done',
    )
    expect(
      (
        await createClient({ baseUrl: world.baseUrl, token: owner.token }).connect(slug, {
          realtime: false,
        })
      ).state.cards,
    ).toEqual({})

    const imported = await yuzie(['import', 'plan.md', '--json'], { cwd: repo, env: board })
    expect(imported.code).toBe(0)
    const result = JSON.parse(imported.stdout)
    expect(result).toMatchObject({ kind: 'Import', data: { count: 3, numbers: [1, 2, 3] } })

    const shown = await yuzie(['card', '1', '--json'], { cwd: repo, env: board })
    expect(JSON.parse(shown.stdout).data).toMatchObject({
      title: 'Write the docs',
      column: 'doing',
      assignees: [owner.handle],
      priority: 1,
      labels: ['docs'],
      description: 'Every command, with examples.',
    })

    // JSON: the complete dump, with the event log.
    const json = await yuzie(['export', '-o', 'board.json'], { cwd: repo, env: board })
    expect(json.code).toBe(0)
    expect(json.stdout).toMatch(/✓ Exported 3 cards and \d+ events to board.json/)
    const dump = JSON.parse(readFileSync(join(repo, 'board.json'), 'utf8'))
    expect(dump).toMatchObject({ apiVersion: 'yuzie/v1', kind: 'BoardExport' })
    expect(dump.board.slug).toBe(slug)
    expect(dump.cards).toHaveLength(3)
    expect(dump.cards[0].checklist).toHaveLength(2)
    expect(dump.events.filter((e: { type: string }) => e.type === 'card.created')).toHaveLength(3)

    // Markdown and CSV, to stdout.
    const md = await yuzie(['export', '--format', 'md'], { cwd: repo, env: board })
    expect(md.stdout).toContain(`- [ ] Write the docs (#1, @${owner.handle}, p1, docs)`)
    expect(md.stdout).toContain('- [x] Pick a name (#3)')
    const csv = await yuzie(['export', '--format', 'csv'], { cwd: repo, env: board })
    expect(csv.stdout.split('\r\n')[0]).toBe(
      'number,title,column,assignees,labels,priority,due,description,checklist,created,updated',
    )

    // The export goes into a second board as it was.
    const other = await createBoard(world.baseUrl, owner)
    const back = await yuzie(['import', 'board.json'], {
      cwd: repo,
      env: { ...env, YUZIE_BOARD: other },
    })
    expect(back.code).toBe(0)
    expect(back.stdout).toContain('✓ Imported 3 cards (#1–#3): Todo 1, Doing 1, Done 1')
    const copy = await createClient({ baseUrl: world.baseUrl, token: owner.token }).connect(other, {
      realtime: false,
    })
    expect(
      Object.values(copy.state.cards)
        .map((c) => [c.title, c.column, c.checklist.length])
        .sort(),
    ).toEqual([
      ['Lands in Todo', 'todo', 0],
      ['Pick a name', 'done', 0],
      ['Write the docs', 'doing', 2],
    ])
    await copy.close()

    // Stdin, and a file that is not cards.
    const piped = await yuzie(['import', '-', '--format', 'csv'], {
      cwd: repo,
      env: board,
      input: 'title,column\nFrom a pipe,review\n',
    })
    expect(piped.stdout).toContain('✓ Imported 1 card (#4): Review 1')
    writeFileSync(join(repo, 'empty.md'), '# Nothing here\n')
    expect((await yuzie(['import', 'empty.md'], { cwd: repo, env: board })).code).toBe(2)
  })
})

describe('yuzie account delete (§14.3)', () => {
  it('asks for the handle, deletes, forgets the token, and the handle cannot sign in again', async () => {
    const leaving = await signIn(world.baseUrl, unique('leaving'))
    const { repo, computer } = as(leaving)
    // Stored credentials, as `yuzie login` leaves them.
    mkdirSync(join(computer.home, '.yuzie'), { recursive: true })
    writeFileSync(
      join(computer.home, '.yuzie', 'credentials'),
      JSON.stringify({ version: 1, servers: { [world.baseUrl]: { token: leaving.token } } }),
      { mode: 0o600 },
    )
    const env = computer.env

    const wrong = await yuzie(['account', 'delete'], { cwd: repo, env, input: 'someone\n' })
    expect(wrong.code).toBe(0)
    expect(wrong.stdout).toContain('Not deleted.')
    expect((await yuzie(['whoami'], { cwd: repo, env })).code).toBe(0)

    expect((await yuzie(['account', 'delete', '--json'], { cwd: repo, env })).code).toBe(2)

    const deleted = await yuzie(['account', 'delete'], {
      cwd: repo,
      env,
      input: `${leaving.handle}\n`,
    })
    expect(deleted.code).toBe(0)
    expect(deleted.stdout).toContain(`✓ Deleted @${leaving.handle}`)
    expect(deleted.stdout).toMatch(/removed from .* by \d{4}-\d{2}-\d{2}/)
    const credentials = JSON.parse(
      readFileSync(join(computer.home, '.yuzie', 'credentials'), 'utf8'),
    )
    expect(credentials.servers[world.baseUrl]).toBeUndefined()
    await expect(
      createClient({ baseUrl: world.baseUrl, token: leaving.token }).me(),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(signIn(world.baseUrl, leaving.handle)).rejects.toThrow('403')
  })

  it('will not orphan a board', async () => {
    const { repo, env } = as(owner)
    const refused = await yuzie(['account', 'delete', '--confirm', owner.handle], {
      cwd: repo,
      env,
    })
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('You are the only owner of')
  })
})

describe('yuzie serve (§7.2)', () => {
  it('runs the server on the given port against DATABASE_URL, and stops on Ctrl-C', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const address = probe.address() as { port: number }
        probe.close(() => resolve(address.port))
      })
    })
    const database = await freshDatabase(process.env.TEST_DATABASE_URL as string)
    const computer = machine(world.baseUrl)
    cleanup.push(computer.home)
    const bin = fileURLToPath(new URL('../../packages/server/bin/yuzie-server.js', import.meta.url))
    const running = start(['serve', '--port', String(port)], {
      cwd: computer.home,
      env: { ...computer.env, DATABASE_URL: database, YUZIE_SERVER_BIN: bin, LOG_LEVEL: 'warn' },
    })
    await running.waitFor(/Serving on http:\/\/localhost:\d+/)
    let health: Response | undefined
    for (let attempt = 0; attempt < 50 && health?.ok !== true; attempt += 1) {
      health = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined)
      if (health?.ok !== true) await new Promise((done) => setTimeout(done, 200))
    }
    expect(health?.ok).toBe(true)
    expect(running.stdout()).toContain(`export YUZIE_SERVER=http://localhost:${port}/v1`)

    running.child.kill('SIGINT')
    const result = await running.done
    expect(result.code).toBe(0)
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow()
  })
})
