/**
 * `@yuzie/server` — the authoritative Yuzie service (SPEC.md §10.1).
 *
 * The REST surface in §12.1 and the realtime gateway in §12.2, over Postgres,
 * with Redis as an optional broker between nodes.
 */
export { type BuildServerOptions, buildServer, type YuzieServer } from './app.js'
export {
  type Authenticated,
  authenticate,
  type BoardAccess,
  narrowestRole,
  resolveBoard,
} from './auth/context.js'
export { ACTIONS, type Action, type Actor, authorize, can } from './auth/permissions.js'
export {
  generateDeviceCode,
  generateToken,
  generateUserCode,
  hashToken,
  TOKEN_PREFIX,
} from './auth/tokens.js'
export { ConfigSchema, loadConfig, type ServerConfig, type ServerConfigInput } from './config.js'
export { createDatabase, type Database, type DatabaseHandle } from './db/client.js'
export {
  type Dialect,
  loadMigrations,
  MIGRATIONS_TABLE,
  migratePostgres,
  migrateSqlite,
  migrationsDirectory,
  type SqliteLike,
} from './db/migrate.js'
export { schema } from './db/schema.js'
export {
  IDEMPOTENCY_HEADER,
  pruneIdempotencyKeys,
  requestFingerprint,
  withIdempotency,
} from './http/idempotency.js'
export { createMetrics, type Metrics } from './http/metrics.js'
export {
  createGateway,
  type Gateway,
  type GatewayOptions,
  type GatewayStats,
  selectProtocol,
  upgradeAuthorization,
} from './realtime/gateway.js'
export { type EnqueueResult, type OutboundLimits, OutboundQueue } from './realtime/outbound.js'
export { BoardPresence, mergeByHandle } from './realtime/presence.js'
export { createMemoryPubSub, type PubSub, type PubSubHandler } from './realtime/pubsub.js'
export { createRedisPubSub, type RedisPubSubOptions } from './realtime/redis.js'
export { createEventBus, type EventBus, type EventListener } from './services/event-bus.js'
export { type LoadEventsOptions, loadEvents, loadSnapshot, type Snapshot } from './services/log.js'
export { currentSeq, mutateBoard } from './services/mutate.js'
export { loadCard, loadCards, loadMembers } from './services/serialize.js'

import { buildServer } from './app.js'
import { loadConfig } from './config.js'
import { createDatabase } from './db/client.js'
import { migratePostgres } from './db/migrate.js'

/** Boot the server from the environment. Used by `yuzie serve`. */
export async function start(): Promise<void> {
  const config = loadConfig()
  const handle = createDatabase(config.databaseUrl)
  await migratePostgres(handle.pool)

  const { app } = await buildServer({ config, db: handle.db })

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down')
    await app.close()
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ host: config.host, port: config.port })
}
