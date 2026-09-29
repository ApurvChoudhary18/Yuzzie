/**
 * SPEC.md §18 Session 16: every error path, through the built binary — its
 * exit code (§7.4), its one actionable line on stderr, the absence of a stack
 * trace, and under --json a single Error document.
 *
 * Errors the real server produces on demand are produced by it. The rest —
 * a lost race (409), rate limiting (429), a server fault (500), a body that
 * breaks the API contract — come from a proxy in front of the same server that
 * answers one chosen request itself and passes everything else through.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { createClient } from '@yuzie/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CliResult, type Machine, machine, repository, yuzie } from './__support__/cli.js'
import {
  createBoard,
  signIn,
  startWorld,
  type User,
  unique,
  type World,
} from './__support__/world.js'

const STACK = /\n\s+at\s.+:\d+:\d+\)?/

let world: World
let rahul: User
let viewer: User
let slug: string
let repo: string
let computer: Machine

/** One request answered by the proxy; everything else goes to the real server. */
let intercept: {
  method: string
  path: RegExp
  status: number
  body: string
  headers?: Record<string, string>
} | null = null
let proxy: Server
let proxyUrl = ''

beforeAll(async () => {
  world = await startWorld()
  rahul = await signIn(world.baseUrl, unique('rahul'))
  viewer = await signIn(world.baseUrl, unique('viewer'))
  slug = await createBoard(world.baseUrl, rahul)
  const board = await createClient({ baseUrl: world.baseUrl, token: rahul.token }).connect(slug, {
    realtime: false,
  })
  await board.members.invite({ handle: viewer.handle, role: 'viewer' })
  await board.cards.create({ title: 'First card' })
  await board.close()

  repo = repository()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  writeFileSync(join(repo, 'README.md'), 'hi\n')
  git('add', '.')
  git('commit', '-m', 'init')
  computer = machine(world.baseUrl)

  const upstream = new URL(world.baseUrl)
  proxy = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] ?? ''
    if (intercept !== null && request.method === intercept.method && intercept.path.test(path)) {
      request.resume()
      response.writeHead(intercept.status, {
        'content-type': 'application/json',
        ...intercept.headers,
      })
      response.end(intercept.body)
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', async () => {
      const forwarded = await fetch(`${upstream.origin}${request.url}`, {
        method: request.method,
        headers: Object.fromEntries(
          Object.entries(request.headers).filter(([key]) => key !== 'host' && key !== 'connection'),
        ) as Record<string, string>,
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
      })
      response.writeHead(forwarded.status, {
        'content-type': forwarded.headers.get('content-type') ?? 'application/json',
      })
      response.end(Buffer.from(await forwarded.arrayBuffer()))
    })
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  proxyUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/v1`
})

afterAll(async () => {
  await new Promise((resolve) => proxy?.close(resolve))
  await world?.close()
})

function envelope(code: string, message: string, status: number): string {
  return JSON.stringify({ error: { code, message, status, details: {} } })
}

async function cli(
  args: string[],
  options: { token?: string | null; server?: string; cwd?: string } = {},
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...computer.env,
    YUZIE_SERVER: options.server ?? world.baseUrl,
    YUZIE_BOARD: slug,
  }
  if (options.token !== null) env.YUZIE_TOKEN = options.token ?? rahul.token
  return yuzie(args, { cwd: options.cwd ?? repo, env })
}

/** The three things every failure owes the user, plus the --json form of it. */
async function fails(
  args: string[],
  code: number,
  says: RegExp,
  options: Parameters<typeof cli>[1] = {},
): Promise<void> {
  const human = await cli(args, options)
  const label = args.join(' ')
  expect(human.code, `${label}: ${human.stderr}`).toBe(code)
  expect(human.stderr, label).toMatch(says)
  expect(human.stderr, `${label}: stack`).not.toMatch(STACK)
  expect(human.stdout, `${label}: stack`).not.toMatch(STACK)
  // One line of error (and at most one line of fix after it).
  expect(human.stderr.trim().split('\n').length, `${label}: ${human.stderr}`).toBeLessThanOrEqual(3)

  const json = await cli([...args, '--json'], options)
  expect(json.code, `${label} --json`).toBe(code)
  const document = JSON.parse(json.stdout.trim().split('\n').at(-1) ?? '{}')
  expect(document).toMatchObject({ kind: 'Error', error: { exitCode: code } })
  expect(document.error.message).toMatch(says)
  expect(typeof document.error.fix).toBe('string')
}

describe('every error code, through the binary (§7.4)', () => {
  it('unauthenticated → 3: no token, and a revoked one', async () => {
    await fails(['list'], 3, /Not signed in/, { token: null })
    const client = createClient({ baseUrl: world.baseUrl, token: rahul.token })
    const spare = await client.tokens.create({ name: unique('spare'), role: 'member' })
    await client.tokens.revoke(spare.apiToken.id)
    await fails(['whoami'], 3, /revoked/, { token: spare.token })
  })

  it('forbidden → 5: a viewer adding a card', async () => {
    await fails(['add', 'Not allowed'], 5, /Not allowed: card\.write/, { token: viewer.token })
  })

  it('card, board and column not found → 4', async () => {
    await fails(['card', '999'], 4, /999/)
    await fails(['--board', 'no-such-board', 'list'], 4, /no-such-board/)
    await fails(['move', '1', 'shipped'], 4, /shipped/)
  })

  it('validation failed → 2: text a terminal would obey', async () => {
    await fails(['add', 'clear \u001b[2J screen'], 2, /control characters \(found U\+001B\)/)
  })

  it('offline network required → 7', async () => {
    await fails(['activity', '--offline'], 7, /needs the network|offline/i)
  })

  it('git precondition → 8: claiming onto a dirty tree without a terminal to ask', async () => {
    writeFileSync(join(repo, 'README.md'), 'changed\n')
    try {
      await fails(['claim', '1', '--agent'], 8, /uncommitted/)
    } finally {
      execFileSync('git', ['checkout', '--', 'README.md'], { cwd: repo })
    }
  })

  it('version conflict → 6: someone changed it first', async () => {
    intercept = {
      method: 'PATCH',
      path: /\/cards\/1$/,
      status: 409,
      body: envelope('version_conflict', 'Card #1 changed since you read it', 409),
    }
    try {
      await fails(['priority', '1', 'p1'], 6, /changed since you read it/, { server: proxyUrl })
    } finally {
      intercept = null
    }
  })

  it('rate limited → 1, after honouring Retry-After', async () => {
    intercept = {
      method: 'GET',
      path: /\/boards\/[^/]+\/activity$/,
      status: 429,
      headers: { 'retry-after': '0' },
      body: envelope('rate_limited', 'Too many requests', 429),
    }
    try {
      await fails(['activity'], 1, /Too many requests/, { server: proxyUrl })
    } finally {
      intercept = null
    }
  })

  it('internal → 1: a server fault, and a body that breaks the contract', async () => {
    intercept = {
      method: 'GET',
      path: /\/boards\/[^/]+\/activity$/,
      status: 500,
      body: envelope('internal', 'Something broke on the server', 500),
    }
    try {
      await fails(['activity'], 1, /Something broke on the server/, { server: proxyUrl })
      intercept = {
        method: 'GET',
        path: /\/boards\/[^/]+\/activity$/,
        status: 200,
        body: '<html>not json</html>',
      }
      await fails(['activity'], 1, /API contract|not JSON|unexpected/i, { server: proxyUrl })
    } finally {
      intercept = null
    }
  })

  it('a WIP limit → 1', async () => {
    const client = createClient({ baseUrl: world.baseUrl, token: rahul.token })
    const board = await client.connect(slug, { realtime: false })
    await board.boards.addColumn({ name: 'Capped', wipLimit: 1 })
    await board.cards.create({ title: 'Fills it', column: 'capped' })
    await board.close()
    await fails(['add', 'One too many', '--column', 'capped'], 1, /WIP|limit/i)
  })
})
