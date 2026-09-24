/**
 * One Postgres container and one Redis container for the whole run.
 *
 * Booting a container per test file costs ~8s each; the suites isolate
 * themselves by creating their own workspaces, boards and handles instead.
 * Redis is only for the multi-node realtime suite (SPEC.md §10.1).
 */
import './docker-env.js'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'

let postgres: StartedPostgreSqlContainer | undefined
let redis: StartedRedisContainer | undefined

export async function setup(): Promise<void> {
  ;[postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('yuzie')
      .withUsername('yuzie')
      .withPassword('yuzie')
      .start(),
    new RedisContainer('redis:7-alpine').start(),
  ])

  // Workers are forked after this runs, so they inherit the variables.
  process.env.TEST_DATABASE_URL = postgres.getConnectionUri()
  process.env.TEST_REDIS_URL = redis.getConnectionUrl()
}

export async function teardown(): Promise<void> {
  await Promise.all([postgres?.stop(), redis?.stop()])
}
