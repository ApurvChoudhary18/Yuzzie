/**
 * SPEC.md §18 Session 7 acceptance: every command, three ways — what a person
 * sees, what `--json` prints (validated against @yuzie/core's schema for its
 * kind), and the exit code when it goes wrong. Real server, built binary.
 */
import { execFile } from 'node:child_process'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type OutputKind, parseOutput } from '@yuzie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CLI,
  type CliResult,
  type Machine,
  machine,
  repository,
  start,
  yuzie,
} from './__support__/cli.js'
import { startWorld, type World } from './__support__/world.js'

const execFileAsync = promisify(execFile)

let world: World
let computer: Machine
let repo: string
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
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  return yuzie(args, {
    cwd: repo,
    env: { ...computer.env, ...options.env },
    ...(options.input === undefined ? {} : { input: options.input }),
  })
}

/** Run with --json and validate the single document against its schema. */
async function json(args: string[], kind: OutputKind, options: { input?: string } = {}) {
  const result = await run([...args, '--json'], options)
  expect(result.code, `${args.join(' ')}: ${result.stdout}${result.stderr}`).toBe(0)
  expect(result.stdout.trim().split('\n'), args.join(' ')).toHaveLength(1)
  const document = JSON.parse(result.stdout) as {
    kind: string
    data: unknown
    meta: Record<string, unknown>
  }
  expect(document.kind).toBe(kind)
  parseOutput(document)
  return document
}

async function fails(
  args: string[],
  code: number,
  options: { input?: string } = {},
): Promise<CliResult> {
  const result = await run(args, options)
  expect(result.code, `${args.join(' ')} → ${result.stderr}${result.stdout}`).toBe(code)
  return result
}

beforeAll(async () => {
  world = await startWorld({ devicePollIntervalSeconds: 1 })
  computer = machine(world.baseUrl)
  repo = repository('git@github.com:acme/commands.git')
  cleanup.push(computer.home, repo)
  await signInAs(computer, repo, 'rahul')
  const init = await run(['init'], { input: '\n\n' })
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`)

  // A teammate, so assignment, presence and feed have someone else in them.
  const priya = machine(world.baseUrl)
  cleanup.push(priya.home)
  await signInAs(priya, repo, 'priya')
  await run(['invite', '@priya'])
}, 120_000)

afterAll(async () => {
  await world.close()
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

describe('cards', () => {
  it('add', async () => {
    const human = await run(['add', 'Fix', 'GitHub', 'OAuth', '--label', 'bug', '--priority', 'p1'])
    expect(human.code).toBe(0)
    expect(human.stdout).toBe('✓ Created #1 Fix GitHub OAuth in Todo\n')

    const created = await json(
      ['add', 'Write docs', '--column', 'doi', '--assign', '@rahul', '--due', '+3d'],
      'Card',
    )
    expect(created.data).toMatchObject({ number: 2, column: 'doing', assignees: ['rahul'] })
    expect((created.data as { dueAt: string }).dueAt).not.toBeNull()
    await json(['add', 'Write tests', '--anchor', 'src/auth/oauth.ts:42'], 'Card')
    await json(['add', 'OAuth scopes for agents'], 'Card')

    await fails(['add'], 2)
    await fails(['add', 'x', '--column', 'nowhere'], 4)
    await fails(['add', 'x', '--due', 'someday'], 2)
  })

  it('list', async () => {
    const human = await run(['list'])
    expect(human.code).toBe(0)
    const lines = human.stdout.split('\n')
    expect(lines[0]).toBe(
      '#    TITLE                     ASSIGNEE   COLUMN    BRANCH                 ACT',
    )
    expect(human.stdout).toMatch(/^1 {4}Fix GitHub OAuth {10}— {10}Todo {6}— {22}\d+s$/m)
    expect(human.stdout).toMatch(/\n4 cards · \d+ online · synced\n$/)

    const all = await json(['list'], 'CardList')
    expect((all.data as unknown[]).length).toBe(4)
    expect(all.meta).toMatchObject({ count: 4, boardSlug: 'commands', synced: true })
    const doing = await json(['list', '--status', 'doing'], 'CardList')
    expect((doing.data as Array<{ number: number }>).map((c) => c.number)).toEqual([2])
    const mine = await json(['list', '--mine'], 'CardList')
    expect((mine.data as Array<{ number: number }>).map((c) => c.number)).toEqual([2])
    const search = await json(['list', '--search', 'oauth', '--sort', 'rank'], 'CardList')
    expect((search.data as unknown[]).length).toBe(2)
    expect(((await json(['list', '--limit', '1'], 'CardList')).data as unknown[]).length).toBe(1)
    expect(((await json(['list', '--stale', '1d'], 'CardList')).data as unknown[]).length).toBe(0)

    await fails(['list', '--sort', 'vibes'], 2)
    await fails(['list', '--status', 'nowhere'], 4)
    await fails(['list', '--limit', 'lots'], 2)
  })

  it('list --json | jq works in a shell (§18 Session 7)', async () => {
    // Asynchronous on purpose: the server runs in this process, and a synchronous
    // exec would block the very event loop that has to answer the CLI.
    const { stdout } = await execFileAsync(
      'sh',
      ['-c', `node "${CLI}" list --json | jq '.data | length'`],
      { cwd: repo, env: computer.env, encoding: 'utf8' },
    )
    expect(stdout.trim()).toBe('4')
  })

  it('card', async () => {
    const human = await run(['card', '3'])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain('#3  Write tests\nTodo · unassigned')
    expect(human.stdout).toContain('Code    src/auth/oauth.ts:42')
    const shown = await json(['card', '#1'], 'Card')
    expect(shown.data).toMatchObject({
      number: 1,
      title: 'Fix GitHub OAuth',
      priority: 1,
      labels: ['bug'],
    })
    await fails(['card', '999'], 4)
  })

  it('card IDs resolve by title (§7.5)', async () => {
    expect((await json(['card', 'fix git'], 'Card')).data).toMatchObject({ number: 1 })
    expect((await json(['card', 'scopes'], 'Card')).data).toMatchObject({ number: 4 })
    // "write" matches #2 Write docs and #3 Write tests.
    const ambiguous = await fails(['card', 'write', '--json'], 4)
    expect(JSON.parse(ambiguous.stdout).error.message).toContain('#2 Write docs, #3 Write tests')
    await fails(['card', 'write', '--yes'], 4)
    // Someone at the keyboard is asked instead.
    const asked = await run(['card', 'write'], { input: '2\n' })
    expect(asked.code).toBe(0)
    expect(asked.stdout).toContain('"write" matches 2 cards. Which one?')
    expect(asked.stdout).toContain('#3  Write tests')
  })

  it('move', async () => {
    const human = await run(['move', '1', 'doi'])
    expect(human.stdout).toBe('✓ Moved #1 Fix GitHub OAuth → Doing\n')
    expect((await json(['move', 'oauth', 'review'], 'Card')).data).toMatchObject({
      number: 4,
      column: 'review',
    })
    await fails(['move', '1', 'nowhere'], 4)
    await fails(['move', '999', 'doing'], 4)
    await fails(['move', '1'], 2)
  })

  it('assign', async () => {
    const human = await run(['assign', '1', '@rahul', '@priya'])
    expect(human.stdout).toBe('✓ #1 assigned to @rahul, @priya\n')
    const cleared = await json(['assign', '1', '@priya', '--clear'], 'Card')
    expect(cleared.data).toMatchObject({ assignees: ['priya'] })
    await fails(['assign', '1'], 2)
    await fails(['assign', '999', '@rahul'], 4)
  })

  it('done', async () => {
    expect((await run(['done', '2'])).stdout).toBe('✓ Moved #2 Write docs → Done\n')
    expect((await json(['done', '4'], 'Card')).data).toMatchObject({ column: 'done' })
    // A board made by `yuzie init` knows Done is done, so `list` marks it ✓.
    expect((await run(['list'])).stdout).toMatch(/^2 {4}Write docs {16}@rahul {2}✓ {2}Done/m)
    await fails(['done', '999'], 4)
  })

  it('comment', async () => {
    expect((await run(['comment', '1', 'OAuth', 'callback', 'is', 'broken'])).stdout).toBe(
      '✓ Commented on #1 Fix GitHub OAuth\n',
    )
    const piped = await json(['comment', '1', '-'], 'Comment', {
      input: 'From stdin\nsecond line\n',
    })
    expect(piped.data).toMatchObject({ body: 'From stdin\nsecond line', author: 'rahul' })
    await fails(['comment', '1'], 2)
    await fails(['comment', '999', 'x'], 4)
  })

  it('check', async () => {
    expect((await run(['check', '1', 'add', 'Reproduce', 'it'])).stdout).toBe(
      '✓ Added item 1 to #1 Fix GitHub OAuth: Reproduce it\n',
    )
    expect((await run(['check', '1', '1'])).stdout).toBe('✓ Checked #1 item 1: Reproduce it\n')
    const undone = await json(['check', '1', '1', '--undone'], 'ChecklistItem')
    expect(undone.data).toMatchObject({ position: 1, doneAt: null })
    await fails(['check', '1', '9'], 4)
    await fails(['check', '1', '1', '--done', '--undone'], 2)
  })

  it('label', async () => {
    expect((await run(['label', '1', 'auth', 'p0'])).stdout).toBe('✓ #1 labels: bug, auth, p0\n')
    expect((await json(['label', '1', 'p0', '--rm'], 'Card')).data).toMatchObject({
      labels: ['auth', 'bug'],
    })
    await fails(['label', '1'], 2)
  })

  it('due', async () => {
    expect((await run(['due', '1', 'tomorrow'])).stdout).toMatch(/^✓ #1 due \w{3} \d{1,2} \w{3}\n$/)
    expect((await json(['due', '1', 'none'], 'Card')).data).toMatchObject({ dueAt: null })
    await fails(['due', '1', 'someday'], 2)
  })

  it('priority', async () => {
    expect((await run(['priority', '1', 'p0'])).stdout).toBe('✓ #1 is p0\n')
    expect((await json(['priority', '1', 'none'], 'Card')).data).toMatchObject({ priority: null })
    await fails(['priority', '1', 'p9'], 2)
  })

  it('watch and unwatch', async () => {
    expect((await run(['watch', '1'])).stdout).toBe('✓ Watching #1 Fix GitHub OAuth\n')
    expect((await json(['list', '--watching'], 'CardList')).data).toHaveLength(1)
    expect((await json(['unwatch', '1'], 'Watch')).data).toEqual({ number: 1, watching: false })
    await fails(['watch', '999'], 4)
  })

  it('edit round-trips through $EDITOR as a minimal PATCH', async () => {
    const editor = join(computer.home, 'edit.sh')
    writeFileSync(
      editor,
      '#!/bin/sh\nsed -i.bak -e "s/^title: .*/title: Fix GitHub OAuth callback/" -e "s/^priority:.*/priority: p2/" "$1"\n',
    )
    chmodSync(editor, 0o755)
    const human = await run(['edit', '1'], { env: { EDITOR: editor } })
    expect(human.code).toBe(0)
    expect(human.stdout).toBe('✓ Updated #1 (title, priority)\n')

    const untouched = await json(['card', '1'], 'Card')
    // `true` as an editor changes nothing, so nothing is sent.
    const noop = await run(['edit', '1', '--json'], { env: { EDITOR: 'true' } })
    expect(JSON.parse(noop.stdout).meta.changed).toEqual([])
    expect(untouched.data).toMatchObject({ title: 'Fix GitHub OAuth callback', priority: 2 })

    const broken = await run(['edit', '1'], { env: { EDITOR: 'false' } })
    expect(broken.code).toBe(2)
    await fails(['edit', '999'], 4)
  }, 30_000)

  it('rm', async () => {
    const kept = await run(['rm', '3'], { input: 'n\n' })
    expect(kept.code).toBe(0)
    expect(kept.stdout).toContain('Kept it.')
    await fails(['rm', '3', '--json'], 2)
    const removed = await json(['rm', '3', '--yes'], 'Deleted')
    expect(removed.data).toEqual({ kind: 'card', id: 3 })
    await fails(['rm', '3', '--yes'], 4)
  })
})

describe('boards, columns and people', () => {
  it('boards', async () => {
    const human = await run(['boards'])
    expect(human.stdout).toMatch(/●\s+commands\s+commands\s+owner/)
    expect((await json(['boards'], 'BoardList')).data).toHaveLength(1)
    const created = await json(['boards', 'create', 'Side', 'Project'], 'Board')
    expect(created.data).toMatchObject({ slug: 'side-project', name: 'Side Project' })
    expect((await run(['boards', 'rename', 'side-project', 'Side', 'Quest'])).stdout).toBe(
      '✓ Renamed side-project to "Side Quest"\n',
    )
    expect(
      (await json(['boards', 'rename', 'side-project', 'Side Quest II'], 'Board')).data,
    ).toMatchObject({
      name: 'Side Quest II',
    })
    await fails(['boards', 'archive', 'side-project', '--json'], 2)
    expect((await json(['boards', 'archive', 'side-project', '--yes'], 'Deleted')).data).toEqual({
      kind: 'board',
      id: 'side-project',
    })
    await fails(['boards', 'rename', 'no-such-board', 'x'], 4)
    await fails(['boards', 'create'], 2)
  })

  it('columns', async () => {
    const human = await run(['columns'])
    expect(human.stdout).toMatch(
      /^KEY\s+NAME\s+CARDS\s+WIP\s+KIND\ntodo\s+Todo\s+\d+\s+—\s+backlog/,
    )
    expect((await json(['columns'], 'ColumnList')).data).toHaveLength(4)
    expect((await run(['columns', 'add', 'QA', '--after', 'review'])).stdout).toBe(
      '✓ Added column QA after Review\n',
    )
    const staging = await json(['columns', 'add', 'Staging'], 'Column')
    expect(staging.data).toMatchObject({ key: 'staging', name: 'Staging' })
    expect((await json(['columns', 'rm', 'staging'], 'Deleted')).data).toEqual({
      kind: 'column',
      id: 'staging',
    })
    await fails(['columns', 'rm', 'nowhere'], 4)
    await fails(['columns', 'add', 'x', '--after', 'nowhere'], 4)
  })

  it('members and invite', async () => {
    const human = await run(['members'])
    expect(human.stdout).toMatch(/@priya\s+member\s+human/)
    expect(human.stdout).toMatch(/@rahul\s+owner\s+human/)
    expect((await json(['members'], 'MemberList')).data).toHaveLength(2)
    expect((await run(['invite', '@sam', '--role', 'viewer'])).stdout).toBe(
      '✓ Invited @sam to commands as viewer\n',
    )
    expect((await json(['invite', 'lee@example.com'], 'Invite')).data).toEqual({
      handle: 'lee',
      role: 'member',
      boardSlug: 'commands',
    })
    await fails(['invite', '@x', '--role', 'boss'], 2)
  })

  it('share', async () => {
    const human = await run(['share'])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain('Share commands with your team:')
    expect(human.stdout).toContain('git clone git@github.com:acme/commands.git')
    expect(human.stdout).toContain('yuzie login')
    const document = await json(['share'], 'Share')
    expect(document.data).toEqual({
      boardSlug: 'commands',
      server: world.baseUrl,
      repo: 'git@github.com:acme/commands.git',
      steps: ['git clone git@github.com:acme/commands.git', 'cd commands', 'yuzie login', 'yuzie'],
    })
  })

  it('who', async () => {
    // Presence exists while someone is connected: a live feed is.
    const feed = start(['feed'], { cwd: repo, env: computer.env })
    await feed.waitFor(/live on commands/)
    try {
      const human = await run(['who'])
      expect(human.code).toBe(0)
      expect(human.stdout).toMatch(/○ @rahul\s+online\n1 online\n$/)
      const present = await json(['who'], 'Presence')
      expect(present.data).toEqual([expect.objectContaining({ handle: 'rahul', state: 'online' })])
    } finally {
      feed.child.kill('SIGINT')
      await feed.done
    }
    const empty = await run(['who'])
    expect(empty.code).toBe(0)
    await fails(['who', '--offline'], 7)
  })

  it('activity', async () => {
    const human = await run(['activity', '--limit', '3'])
    expect(human.code).toBe(0)
    expect(human.stdout.trim().split('\n')).toHaveLength(3)
    expect(human.stdout).toMatch(/@rahul/)
    const one = await json(['activity', '--card', '1'], 'EventList')
    const types = (one.data as Array<{ type: string; cardNo?: number }>).map((e) => e.type)
    expect(types[0]).toBe('card.created')
    expect((one.data as Array<{ cardNo?: number }>).every((e) => e.cardNo === 1)).toBe(true)
    const recent = await json(['activity', '--since', '1h'], 'EventList')
    expect((recent.data as unknown[]).length).toBeGreaterThan(10)
    await fails(['activity', '--since', 'recently'], 2)
    await fails(['activity', '--card', '999'], 4)
  })
})

describe('feed', () => {
  it('streams each event as a line until interrupted', async () => {
    const feed = start(['feed'], { cwd: repo, env: computer.env })
    await feed.waitFor(/live on commands/)
    await run(['move', '1', 'todo'])
    await feed.waitFor(/@rahul {2}moved #1 Fix GitHub OAuth callback → Todo/)
    feed.child.kill('SIGINT')
    const result = await feed.done
    expect(result.code).toBe(130)
    expect(result.stdout).toMatch(/^\d{2}:\d{2} {2}@rahul {2}moved #1/m)
  })

  it('under --json prints one Event document per line', async () => {
    const feed = start(['feed', '--json'], { cwd: repo, env: computer.env })
    // No banner under --json; give the stream a moment to connect.
    await new Promise((resolve) => setTimeout(resolve, 800))
    await run(['move', '1', 'doing'])
    await run(['comment', '1', 'streamed'])
    await feed.waitFor(/comment\.created/)
    feed.child.kill('SIGINT')
    const result = await feed.done
    const lines = result.stdout.trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const line of lines) parseOutput(JSON.parse(line))
    expect(lines.map((line) => JSON.parse(line).data.type)).toEqual([
      'card.moved',
      'comment.created',
    ])
  })
})

describe('without a sign-in or a board', () => {
  it('exits 3 when not signed in', async () => {
    const stranger = machine(world.baseUrl)
    cleanup.push(stranger.home)
    for (const args of [['list'], ['add', 'x'], ['feed'], ['who']]) {
      const result = await yuzie(args, { cwd: repo, env: stranger.env })
      expect(result.code, args.join(' ')).toBe(3)
    }
  })

  it('exits 2 outside a board, saying how to fix it', async () => {
    const result = await yuzie(['list'], { cwd: computer.home, env: computer.env })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('yuzie init')
    const share = await yuzie(['share'], { cwd: computer.home, env: computer.env })
    expect(share.code).toBe(2)
  })
})
