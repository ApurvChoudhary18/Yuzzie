/**
 * The Fastify application (SPEC.md §10.3, §12.1).
 */
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { boardError } from '@yuzie/core'
import Fastify, { type FastifyInstance } from 'fastify'
import { hashToken } from './auth/tokens.js'
import type { ServerConfig } from './config.js'
import type { Database } from './db/client.js'
import { registerErrorHandler } from './http/errors.js'
import { createMetrics, type Metrics } from './http/metrics.js'
import { createGateway, type Gateway, selectProtocol } from './realtime/gateway.js'
import { createMemoryPubSub, type PubSub } from './realtime/pubsub.js'
import { createRedisPubSub } from './realtime/redis.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerBoardRoutes } from './routes/boards.js'
import { registerCardRoutes } from './routes/cards.js'
import type { AppContext } from './routes/helpers.js'
import { createEventBus, type EventBus } from './services/event-bus.js'

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

export interface BuildServerOptions {
  readonly config: ServerConfig
  readonly db: Database
  readonly metrics?: Metrics
  /** Supplied by tests that want to observe or inject committed events. */
  readonly bus?: EventBus
  /**
   * The cross-node broker. Defaults to Redis when `redisUrl` is configured and to
   * in-process otherwise. One passed in here is not closed with the server.
   */
  readonly pubsub?: PubSub
  /** Names this node to the others sharing the broker. */
  readonly nodeId?: string
  /** The realtime gateway's clock; tests move it to exercise 45 s and 60 s timeouts. */
  readonly now?: () => number
}

export interface YuzieServer {
  readonly app: FastifyInstance
  readonly context: AppContext
  readonly gateway: Gateway
}

export async function buildServer(options: BuildServerOptions): Promise<YuzieServer> {
  const metrics = options.metrics ?? createMetrics()
  const bus = options.bus ?? createEventBus()

  bus.subscribe((_boardId, committed) => {
    for (const event of committed) metrics.events.labels({ type: event.type }).inc()
  })

  const app = Fastify({
    logger: { level: options.config.logLevel },
    // Card ids arrive as `18` or `#18`; trusting the proxy is a deployment
    // concern, not something to guess at here.
    trustProxy: false,
    bodyLimit: 1024 * 1024,
  })

  const ownsPubsub = options.pubsub === undefined
  const pubsub =
    options.pubsub ??
    (options.config.redisUrl === undefined
      ? createMemoryPubSub()
      : await createRedisPubSub(options.config.redisUrl, {
          onError: (error) => app.log.warn({ err: error }, 'redis connection error'),
        }))

  const gateway = createGateway({
    config: options.config,
    db: options.db,
    metrics,
    bus,
    pubsub,
    log: app.log,
    ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const context: AppContext = {
    config: options.config,
    db: options.db,
    metrics,
    bus,
    presence: (boardId) => gateway.presence(boardId),
  }

  // Close streams with 1001 before the websocket plugin's own preClose, which
  // would otherwise close them without a reason a client can act on.
  app.addHook('preClose', async () => {
    await gateway.close()
  })
  app.addHook('onClose', async () => {
    if (ownsPubsub) await pubsub.close()
  })

  await app.register(websocket, {
    options: {
      // Client frames are a few hundred bytes at most (§12.2).
      maxPayload: 16 * 1024,
      handleProtocols: selectProtocol,
    },
  })

  // Fastify rejects an empty body when `Content-Type: application/json` is set,
  // but that is exactly what `fetch` and most HTTP clients send for a POST with
  // no payload — `POST /auth/device` takes none. Treat it as `{}`.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, payload, done) => {
    const text = typeof payload === 'string' ? payload.trim() : ''
    if (text.length === 0) {
      done(null, {})
      return
    }
    try {
      done(null, JSON.parse(text) as unknown)
    } catch {
      const error = new Error('Request body is not valid JSON') as Error & {
        statusCode?: number
      }
      error.statusCode = 400
      done(error, undefined)
    }
  })

  registerErrorHandler(app)

  if (options.config.rateLimitEnabled) {
    // §12.1: 600 reads/min per token, 120 writes/min, 429 with Retry-After.
    await app.register(rateLimit, {
      global: true,
      timeWindow: '1 minute',
      max: (request) =>
        WRITE_METHODS.has(request.method)
          ? options.config.writeRateLimit
          : options.config.readRateLimit,
      keyGenerator: (request) => {
        const header = request.headers.authorization
        // Key on the token, not the IP: a team behind one NAT is many users,
        // and a stolen token should not be able to starve its owner.
        if (typeof header === 'string' && header.length > 0) return hashToken(header)
        return request.ip
      },
      // The plugin *throws* whatever this returns, so it must be an error the
      // shared handler understands — not a pre-rendered envelope.
      errorResponseBuilder: (_request, context_) =>
        boardError(
          'rate_limited',
          `Too many requests. Retry in ${Math.ceil(context_.ttl / 1000)}s.`,
          { details: { max: context_.max, retryAfterSeconds: Math.ceil(context_.ttl / 1000) } },
        ),
    })
  }

  app.addHook('onResponse', async (request, reply) => {
    metrics.httpDuration
      .labels({
        method: request.method,
        route: request.routeOptions.url ?? 'unknown',
        status: String(reply.statusCode),
      })
      .observe(reply.elapsedTime / 1000)

    if (reply.statusCode === 409) metrics.conflicts.inc()
  })

  app.get('/healthz', async (_request, reply) => {
    return reply.send({ status: 'ok', version: 'yuzie/v1' })
  })

  app.get('/metrics', async (_request, reply) => {
    return reply
      .header('content-type', metrics.registry.contentType)
      .send(await metrics.registry.metrics())
  })

  // Everything in §12.1 lives under /v1.
  await app.register(
    async (instance) => {
      registerAuthRoutes(instance, context)
      registerBoardRoutes(instance, context)
      registerCardRoutes(instance, context)
      gateway.register(instance)
    },
    { prefix: '/v1' },
  )

  return { app, context, gateway }
}
