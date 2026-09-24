/**
 * Shared scaffolding for the server suites.
 *
 * Every helper creates uniquely named data, so suites that share the one
 * container cannot collide even though they run against the same database.
 */
import { randomUUID } from 'node:crypto'
import type { Role } from '@yuzie/core'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../app.js'
import { generateToken, hashToken } from '../auth/tokens.js'
import { loadConfig, type ServerConfig } from '../config.js'
import { createDatabase, type DatabaseHandle } from '../db/client.js'
import { migratePostgres } from '../db/migrate.js'
import { apiTokens, memberships, users } from '../db/schema.js'
import { createMetrics, type Metrics } from '../http/metrics.js'
import type { Gateway } from '../realtime/gateway.js'
import type { PubSub } from '../realtime/pubsub.js'
import { createEventBus, type EventBus } from '../services/event-bus.js'

export interface TestServer {
  readonly app: FastifyInstance
  readonly handle: DatabaseHandle
  readonly config: ServerConfig
  readonly metrics: Metrics
  readonly bus: EventBus
  readonly gateway: Gateway
  close(): Promise<void>
}

export interface TestServerExtras {
  readonly pubsub?: PubSub
  readonly nodeId?: string
  readonly now?: () => number
}

export function databaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (url === undefined) {
    throw new Error(
      'TEST_DATABASE_URL is not set. The Postgres container is started by src/__tests__/global-setup.ts.',
    )
  }
  return url
}

export async function startTestServer(
  overrides: Partial<ServerConfig> = {},
  extras: TestServerExtras = {},
): Promise<TestServer> {
  const config = loadConfig(
    {},
    {
      databaseUrl: databaseUrl(),
      logLevel: 'silent',
      // Rate limiting is asserted in its own suite; leaving it on would make
      // every other suite's request budget a hidden dependency.
      rateLimitEnabled: false,
      ...overrides,
    },
  )

  const handle = createDatabase(config.databaseUrl, 25)
  await migratePostgres(handle.pool)

  const metrics = createMetrics()
  const bus = createEventBus()
  const { app, gateway } = await buildServer({ config, db: handle.db, metrics, bus, ...extras })
  await app.ready()

  return {
    app,
    handle,
    config,
    metrics,
    bus,
    gateway,
    async close() {
      await app.close()
      await handle.close()
    },
  }
}

let counter = 0
export function unique(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`
}

export interface TestUser {
  readonly id: string
  readonly handle: string
  readonly token: string
}

/** Create a user and a token for them, bypassing the device flow. */
export async function createUser(
  server: TestServer,
  options: { handle?: string; kind?: 'human' | 'agent'; role?: Role; boardId?: string } = {},
): Promise<TestUser> {
  const handle = options.handle ?? unique('user')
  const [user] = await server.handle.db
    .insert(users)
    .values({ handle, kind: options.kind ?? 'human' })
    .returning()
  if (user === undefined) throw new Error('could not create user')

  const token = await issueToken(server, user.id, options.role ?? 'owner', options.boardId)
  return { id: user.id, handle: user.handle, token }
}

export async function issueToken(
  server: TestServer,
  userId: string,
  role: Role,
  boardId?: string,
): Promise<string> {
  const token = generateToken()
  await server.handle.db.insert(apiTokens).values({
    userId,
    boardId: boardId ?? null,
    name: 'test',
    tokenHash: hashToken(token),
    role,
  })
  return token
}

export interface Injected<T = unknown> {
  readonly status: number
  readonly body: T
  readonly headers: Record<string, unknown>
}

export async function call<T = unknown>(
  server: TestServer,
  options: {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    url: string
    token?: string
    body?: unknown
    headers?: Record<string, string>
  },
): Promise<Injected<T>> {
  const response = await server.app.inject({
    method: options.method,
    url: options.url,
    ...(options.body === undefined ? {} : { payload: options.body as object }),
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...options.headers,
    },
  })

  let body: unknown
  if (response.body.length > 0) {
    try {
      body = response.json()
    } catch {
      body = response.body
    }
  }

  return { status: response.statusCode, body: body as T, headers: response.headers }
}

export interface TestBoard {
  readonly slug: string
  readonly id: string
  readonly owner: TestUser
}

/** Create a board owned by `owner` (a fresh owner if none is given). */
export async function createBoard(
  server: TestServer,
  owner?: TestUser,
  options: { columns?: string[] } = {},
): Promise<TestBoard> {
  const boardOwner = owner ?? (await createUser(server))
  const slug = unique('board')

  const response = await call<{ id: string; slug: string }>(server, {
    method: 'POST',
    url: '/v1/boards',
    token: boardOwner.token,
    body: { name: slug, ...(options.columns === undefined ? {} : { columns: options.columns }) },
  })
  if (response.status !== 201) {
    throw new Error(`could not create board: ${response.status} ${JSON.stringify(response.body)}`)
  }

  return { slug: response.body.slug, id: response.body.id, owner: boardOwner }
}

/** Add `user` to `board` with `role`, as the owner would via an invite. */
export async function addMember(
  server: TestServer,
  board: TestBoard,
  user: TestUser,
  role: Role,
): Promise<void> {
  await server.handle.db
    .insert(memberships)
    .values({ boardId: board.id, userId: user.id, role })
    .onConflictDoUpdate({
      target: [memberships.boardId, memberships.userId],
      set: { role },
    })
}

export async function createCard(
  server: TestServer,
  board: TestBoard,
  token: string,
  body: Record<string, unknown> = {},
): Promise<{ number: number; version: number }> {
  const response = await call<{ number: number; version: number }>(server, {
    method: 'POST',
    url: `/v1/boards/${board.slug}/cards`,
    token,
    body: { title: 'Fix GitHub OAuth', ...body },
  })
  if (response.status !== 201) {
    throw new Error(`could not create card: ${response.status} ${JSON.stringify(response.body)}`)
  }
  return response.body
}
