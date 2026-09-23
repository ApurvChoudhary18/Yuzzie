/**
 * The Fastify application (SPEC.md §10.3, §12.1).
 */
import rateLimit from '@fastify/rate-limit'
import { boardError } from '@yuzie/core'
import Fastify, { type FastifyInstance } from 'fastify'
import { hashToken } from './auth/tokens.js'
import type { ServerConfig } from './config.js'
import type { Database } from './db/client.js'
import { registerErrorHandler } from './http/errors.js'
import { createMetrics, type Metrics } from './http/metrics.js'
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
  /** Session 4's gateway supplies its own so it can subscribe to the fan-out. */
  readonly bus?: EventBus
}

export interface YuzieServer {
  readonly app: FastifyInstance
  readonly context: AppContext
}

export async function buildServer(options: BuildServerOptions): Promise<YuzieServer> {
  const metrics = options.metrics ?? createMetrics()
  const bus = options.bus ?? createEventBus()
  const context: AppContext = { config: options.config, db: options.db, metrics, bus }

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
    },
    { prefix: '/v1' },
  )

  return { app, context }
}
