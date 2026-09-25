/**
 * Journey A (SPEC.md §6.1) and the rest of §18 Session 6's acceptance, against
 * a real server, through the built `yuzie` binary.
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@yuzie/sdk'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type Machine, machine, repository, start, yuzie } from './__support__/cli.js'
import { startWorld, type World } from './__support__/world.js'

/** Journey A, verbatim from §6.1, from the first line `yuzie init` prints. */
const JOURNEY_A = `
yuzie · collaborative git-aware kanban

✓ Git repository detected: payments-api (github.com/acme/payments-api)
✓ Default branch: main
? Sign in with GitHub? (Y/n) y
→ Opening https://yuzie.dev/device and waiting…
  Code: WXYZ-4821
✓ Signed in as @rahul
? Board name: (payments-api)
? Columns: (Todo, Doing, Review, Done)
✓ Board "payments-api" created
✓ Wrote .yuzie/config.json
✓ Added .yuzie/cache/ to .gitignore
✓ Installed git hooks (post-commit, post-checkout)

Invite your team:
  yuzie invite adarsh@acme.dev
  yuzie share          # prints a join link

Next: yuzie add "Fix GitHub OAuth"
`

/** Compare what a person reads: trailing spaces are invisible, so ignore them. */
function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trimEnd())
}

let world: World
const cleanup: string[] = []

beforeAll(async () => {
  // The URL the CLI prints is the server's public URL; the spec shows the hosted one.
  world = await startWorld({ publicUrl: 'https://yuzie.dev', devicePollIntervalSeconds: 1 })
})

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

afterAll(async () => {
  await world.close()
})

async function approve(userCode: string, handle: string, token?: string): Promise<number> {
  const response = await fetch(`${world.baseUrl}/auth/device/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ userCode, handle }),
  })
  return response.status
}

/** Sign `computer` in as `handle` through `yuzie login`, approving like a person would. */
async function logIn(computer: Machine, cwd: string, handle: string): Promise<void> {
  const running = start(['login'], { cwd, env: computer.env })
  const [, code] = await running.waitFor(/Code: (\S+)/)
  expect(await approve(code as string, handle)).toBe(200)
  expect((await running.done).code).toBe(0)
}

describe('Journey A (§6.1)', () => {
  it('reproduces the transcript verbatim, and sets the repo up for real', async () => {
    const computer = machine(world.baseUrl)
    const repo = repository()
    cleanup.push(computer.home, repo)

    // Answers typed in order: sign in? (y), board name (default), columns (default).
    const running = start(['init'], { cwd: repo, env: computer.env, input: 'y\n\n\n' })
    const [, userCode] = await running.waitFor(/Code: (\S+)/)
    // The person opens the page and approves the code in their browser.
    expect(await approve(userCode as string, 'rahul')).toBe(200)
    const result = await running.done

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(lines(result.stdout)).toEqual(lines(JOURNEY_A.replace('WXYZ-4821', userCode as string)))

    // What the receipt claims is true on disk…
    const config = JSON.parse(readFileSync(join(repo, '.yuzie', 'config.json'), 'utf8'))
    expect(config).toMatchObject({
      version: 1,
      board: 'payments-api',
      server: world.baseUrl,
      git: { baseBranch: 'main', hooks: ['post-commit', 'post-checkout'] },
    })
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('.yuzie/cache/\n')
    for (const hook of ['post-commit', 'post-checkout']) {
      expect(readFileSync(join(repo, '.git', 'hooks', hook), 'utf8')).toContain('yuzie __hook')
    }
    // …the token is stored with the right permissions…
    const credentials = join(computer.home, '.yuzie', 'credentials')
    const { statSync } = await import('node:fs')
    expect(statSync(credentials).mode & 0o777).toBe(0o600)

    // …and on the server: the board, its columns, its remote, owned by @rahul.
    const token = JSON.parse(readFileSync(credentials, 'utf8')).servers[world.baseUrl]
      .token as string
    const board = await createClient({ baseUrl: world.baseUrl, token }).connect('payments-api', {
      realtime: false,
    })
    expect(board.state.board).toMatchObject({
      slug: 'payments-api',
      repoRemote: 'github.com/acme/payments-api',
      baseBranch: 'main',
    })
    expect(board.state.columns.map((c) => c.name)).toEqual(['Todo', 'Doing', 'Review', 'Done'])
    expect(board.state.members).toEqual([
      expect.objectContaining({ handle: 'rahul', role: 'owner' }),
    ])
    await board.close()

    // Idempotent: run it again. No prompts, nothing duplicated, nothing rewritten.
    const configBefore = readFileSync(join(repo, '.yuzie', 'config.json'), 'utf8')
    const hookBefore = readFileSync(join(repo, '.git', 'hooks', 'post-commit'), 'utf8')
    const again = await yuzie(['init'], { cwd: repo, env: computer.env })
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('✓ Signed in as @rahul')
    expect(again.stdout).toContain('✓ Board "payments-api" linked')
    expect(again.stdout).toContain('✓ .yuzie/config.json is up to date')
    expect(again.stdout).toContain('✓ .gitignore already ignores .yuzie/cache/')
    expect(again.stdout).toContain('✓ Git hooks already installed (post-commit, post-checkout)')
    expect(again.stdout).not.toContain('?')
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('.yuzie/cache/\n')
    expect(readFileSync(join(repo, '.yuzie', 'config.json'), 'utf8')).toBe(configBefore)
    expect(readFileSync(join(repo, '.git', 'hooks', 'post-commit'), 'utf8')).toBe(hookBefore)
    expect(
      (await createClient({ baseUrl: world.baseUrl, token }).boards.list()).filter(
        (b) => b.slug === 'payments-api',
      ),
    ).toHaveLength(1)
  })

  it('links, rather than duplicates, a board the user already has, and keeps their .gitignore', async () => {
    const computer = machine(world.baseUrl)
    const repo = repository('https://github.com/acme/ledger.git')
    cleanup.push(computer.home, repo)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(repo, '.gitignore'), 'node_modules\ndist')

    await logIn(computer, repo, 'ledger-owner')
    const first = await yuzie(['init'], { cwd: repo, env: computer.env, input: '\n\n' })
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('✓ Board "ledger" created')
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(
      'node_modules\ndist\n.yuzie/cache/\n',
    )

    // A second clone of the same repo, with no .yuzie/config.json yet.
    const clone = repository('https://github.com/acme/ledger.git')
    cleanup.push(clone)
    const second = await yuzie(['init'], { cwd: clone, env: computer.env, input: '\n' })
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('✓ Board "ledger" linked')
    expect(second.stdout).not.toContain('? Columns')
  })

  it('refuses outside a git repository with exit 8', async () => {
    const computer = machine(world.baseUrl)
    cleanup.push(computer.home)
    const result = await yuzie(['init'], { cwd: computer.home, env: computer.env })
    expect(result.code).toBe(8)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
  })
})

describe('without credentials', () => {
  it.each([['whoami'], ['logout'], ['doctor'], ['init', '--json'], ['init', '--yes', '--json']])(
    '`yuzie %s` exits 3 with one actionable line',
    async (...args: string[]) => {
      const computer = machine(world.baseUrl)
      const repo = repository()
      cleanup.push(computer.home, repo)
      const result = await yuzie(args, { cwd: repo, env: computer.env })
      expect(result.code).toBe(3)
      if (args.includes('--json')) {
        const parsed = JSON.parse(result.stdout)
        expect(parsed).toMatchObject({
          kind: 'Error',
          error: { code: 'unauthenticated', exitCode: 3 },
        })
      } else if (args[0] === 'doctor') {
        expect(result.stdout).toContain('✗ not signed in → run `yuzie login`')
      } else {
        const message = result.stderr.trim().split('\n')
        expect(message).toHaveLength(1)
        expect(message[0]).toContain('yuzie login')
      }
    },
  )

  it('declining to sign in during init exits 3 too', async () => {
    const computer = machine(world.baseUrl)
    const repo = repository()
    cleanup.push(computer.home, repo)
    const result = await yuzie(['init'], { cwd: repo, env: computer.env, input: 'n\n' })
    expect(result.code).toBe(3)
    expect(result.stderr.trim()).toContain('yuzie login')
  })
})

describe('login, whoami, logout', () => {
  it('signs in, reports who you are, then revokes the token so it stops working', async () => {
    const computer = machine(world.baseUrl)
    const repo = repository()
    cleanup.push(computer.home, repo)
    await logIn(computer, repo, 'priya')

    const who = await yuzie(['whoami'], { cwd: repo, env: computer.env })
    expect(who.code).toBe(0)
    expect(who.stdout).toMatch(
      /✓ Signed in as @priya\n {2}Server: {2}http:\/\/127\.0\.0\.1:\d+\/v1 \(\d+ ms\)/,
    )

    const token = JSON.parse(readFileSync(join(computer.home, '.yuzie', 'credentials'), 'utf8'))
      .servers[world.baseUrl].token as string

    const out = await yuzie(['logout'], { cwd: repo, env: computer.env })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain(`✓ Signed out of ${world.baseUrl}`)
    // Revoked on the server, not just forgotten locally.
    await expect(createClient({ baseUrl: world.baseUrl, token }).me()).rejects.toMatchObject({
      code: 'unauthenticated',
    })
    expect((await yuzie(['whoami'], { cwd: repo, env: computer.env })).code).toBe(3)
  })

  it('cannot be approved as someone who is signed in elsewhere', async () => {
    const victim = machine(world.baseUrl)
    const attacker = machine(world.baseUrl)
    const repo = repository()
    cleanup.push(victim.home, attacker.home, repo)
    await logIn(victim, repo, 'adarsh')

    const running = start(['login'], { cwd: repo, env: attacker.env })
    const [, code] = await running.waitFor(/Code: (\S+)/)
    expect(await approve(code as string, 'adarsh')).toBe(403)
    running.child.kill('SIGINT')
    expect((await running.done).code).not.toBe(0)
  })
})

describe('--json (acceptance): stdout is exactly one JSON document', () => {
  it('for every implemented command', async () => {
    const computer = machine(world.baseUrl)
    const repo = repository('git@github.com:acme/json-check.git')
    cleanup.push(computer.home, repo)

    const login = start(['login', '--json'], { cwd: repo, env: computer.env })
    const [, code] = await login.waitFor(/code (\S+-\S+)/)
    expect(await approve(code as string, 'json-person')).toBe(200)
    const loggedIn = await login.done
    expect(loggedIn.code).toBe(0)
    // The code went to stderr; stdout holds only the result.
    expect(JSON.parse(loggedIn.stdout)).toMatchObject({ apiVersion: 'yuzie/v1', kind: 'Login' })

    const cases: Array<[string[], string]> = [
      [['init', '--json'], 'Init'],
      [['whoami', '--json'], 'Whoami'],
      [['doctor', '--json'], 'Doctor'],
      [['config', 'get', 'git.baseBranch', '--json'], 'ConfigValue'],
      [['config', 'set', 'ui.compact', 'true', '--json'], 'ConfigValue'],
      [['config', 'get', '--json'], 'ConfigValue'],
      [['hooks', 'install', '--json'], 'Hooks'],
      [['hooks', 'uninstall', '--json'], 'Hooks'],
      [['config', 'set', 'no.such.key', '1', '--json'], 'Error'],
      [['logout', '--json'], 'Logout'],
      [['whoami', '--json'], 'Error'],
    ]
    for (const [args, kind] of cases) {
      const result = await yuzie(args, { cwd: repo, env: computer.env })
      let parsed: { apiVersion?: string; kind?: string }
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        throw new Error(`\`yuzie ${args.join(' ')}\` printed non-JSON:\n${result.stdout}`)
      }
      expect(result.stdout.trim().split('\n'), args.join(' ')).toHaveLength(1)
      expect(parsed, args.join(' ')).toMatchObject({ apiVersion: 'yuzie/v1', kind })
    }
  })

  it('usage errors exit 2', async () => {
    const computer = machine(world.baseUrl)
    cleanup.push(computer.home)
    const result = await yuzie(['whoami', '--no-such-flag'], {
      cwd: computer.home,
      env: computer.env,
    })
    expect(result.code).toBe(2)
  })
})

describe('yuzie doctor (§15)', () => {
  it('prints the checks in the §15 shape, and exits 0 when all is well', async () => {
    const computer = machine(world.baseUrl)
    const repo = repository()
    cleanup.push(computer.home, repo)
    await logIn(computer, repo, 'doctor-who')
    await yuzie(['hooks', 'install'], { cwd: repo, env: computer.env })

    const result = await yuzie(['doctor'], {
      cwd: repo,
      env: { ...computer.env, COLORTERM: 'truecolor' },
    })
    expect(result.code).toBe(0)
    const out = lines(result.stdout.trim())
    expect(out[0]).toMatch(/^✓ node v\d+\.\d+\.\d+ \(supported\)$/)
    expect(out[1]).toMatch(/^✓ git \d+\.\d+/)
    expect(out[2]).toBe('✓ terminal supports truecolor + unicode')
    expect(out[3]).toBe('✓ authenticated as @doctor-who')
    expect(out[4]).toMatch(/^✓ server reachable \(\d+ ms\)$/)
    expect(out[5]).toBe('✓ hooks installed (post-commit, post-checkout)')
  })

  it('names the fix for a missing hook, as a warning that does not fail', async () => {
    const computer = machine(world.baseUrl)
    const repo = repository()
    cleanup.push(computer.home, repo)
    await logIn(computer, repo, 'doctor-no')
    const result = await yuzie(['doctor'], { cwd: repo, env: computer.env })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      '⚠ hooks: post-commit, post-checkout not installed → run `yuzie hooks install`',
    )
  })

  it('reports an unreachable server as exit 7', async () => {
    const computer = machine('http://127.0.0.1:9/v1')
    const repo = repository()
    cleanup.push(computer.home, repo)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(computer.home, '.yuzie'), { recursive: true })
    writeFileSync(
      join(computer.home, '.yuzie', 'credentials'),
      JSON.stringify({ version: 1, servers: { 'http://127.0.0.1:9/v1': { token: 'yz_x' } } }),
      { mode: 0o600 },
    )
    const result = await yuzie(['doctor'], { cwd: repo, env: computer.env })
    expect(result.code).toBe(7)
    expect(result.stdout).toContain('✗ server unreachable: http://127.0.0.1:9/v1')
  })
})
