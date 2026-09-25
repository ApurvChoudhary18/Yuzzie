/**
 * A real Yuzie server on a real port, and the tools to put a network between it
 * and a client that can actually fail.
 */
import { randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket, connect as tcpConnect } from 'node:net'
import { createClient } from '@yuzie/sdk'
import {
  buildServer,
  createDatabase,
  type DatabaseHandle,
  loadConfig,
  migratePostgres,
  type ServerConfigInput,
} from '@yuzie/server'
import type { FastifyInstance } from 'fastify'

export interface World {
  /** `http://127.0.0.1:<port>/v1`, straight to the server. */
  readonly baseUrl: string
  readonly app: FastifyInstance
  close(): Promise<void>
}

export async function startWorld(overrides: Partial<ServerConfigInput> = {}): Promise<World> {
  const databaseUrl = process.env.TEST_DATABASE_URL
  if (databaseUrl === undefined)
    throw new Error('TEST_DATABASE_URL is not set; see global-setup.ts')

  const config = loadConfig(
    {},
    { databaseUrl, logLevel: 'silent', rateLimitEnabled: false, ...overrides },
  )
  const handle: DatabaseHandle = createDatabase(config.databaseUrl)
  await migratePostgres(handle.pool)
  const { app } = await buildServer({ config, db: handle.db })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })

  return {
    baseUrl: `${address}/v1`,
    app,
    async close() {
      await app.close()
      await handle.close()
    },
  }
}

let counter = 0
export function unique(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}-${randomUUID().slice(0, 6)}`
}

export interface User {
  readonly handle: string
  readonly token: string
}

/**
 * Sign in the way a person does (§6.1): the SDK starts the device flow and
 * polls; the approval — the web page's job — is posted directly.
 */
export async function signIn(baseUrl: string, handle: string = unique('user')): Promise<User> {
  const client = createClient({ baseUrl })
  const started = await client.auth.start()
  const pending = await client.auth.poll(started.deviceCode)
  if (!pending.pending) throw new Error('expected the login to be pending before approval')

  const approved = await fetch(`${baseUrl}/auth/device/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userCode: started.userCode, handle }),
  })
  if (approved.status !== 200) throw new Error(`approve failed: ${approved.status}`)

  const done = await client.auth.poll(started.deviceCode)
  if (done.token === undefined) throw new Error('expected a token after approval')
  return { handle, token: done.token.token }
}

/** A board owned by `owner`, with `members` invited as members. */
export async function createBoard(
  baseUrl: string,
  owner: User,
  members: readonly User[] = [],
): Promise<string> {
  const client = createClient({ baseUrl, token: owner.token })
  const board = await client.boards.create({ name: unique('board') })
  const connected = await client.connect(board.slug, { realtime: false })
  for (const member of members) {
    await connected.members.invite({ handle: member.handle, role: 'member' })
  }
  await connected.close()
  return board.slug
}

/**
 * A TCP proxy in front of the server that can be cut and restored — a real
 * network failure for HTTP and WebSocket alike, not a mocked `fetch`.
 */
export class Link {
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private up = true
  port = 0

  private constructor(private readonly target: number) {
    this.server = createServer((client) => {
      if (!this.up) {
        client.destroy()
        return
      }
      const upstream = tcpConnect(this.target, '127.0.0.1')
      this.sockets.add(client)
      this.sockets.add(upstream)
      const forget = () => {
        this.sockets.delete(client)
        this.sockets.delete(upstream)
        client.destroy()
        upstream.destroy()
      }
      client.on('error', forget)
      upstream.on('error', forget)
      client.on('close', forget)
      upstream.on('close', forget)
      client.pipe(upstream)
      upstream.pipe(client)
    })
  }

  static async open(baseUrl: string): Promise<Link> {
    const target = Number(new URL(baseUrl).port)
    const link = new Link(target)
    await new Promise<void>((resolve) => link.server.listen(0, '127.0.0.1', resolve))
    const address = link.server.address()
    link.port = typeof address === 'object' && address !== null ? address.port : 0
    return link
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`
  }

  /** Drop every connection and refuse new ones. */
  cut(): void {
    this.up = false
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  restore(): void {
    this.up = true
  }

  async close(): Promise<void> {
    this.cut()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

/** Resolve once `predicate` holds, polling; for state that settles asynchronously. */
export async function eventually(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
