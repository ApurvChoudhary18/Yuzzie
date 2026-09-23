/**
 * One Postgres container for the whole run.
 *
 * Booting a container per test file costs ~8s each; the suites isolate
 * themselves by creating their own workspaces, boards and handles instead.
 */
import './docker-env.js'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

let container: StartedPostgreSqlContainer | undefined

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('yuzie')
    .withUsername('yuzie')
    .withPassword('yuzie')
    .start()

  // Workers are forked after this runs, so they inherit the variable.
  process.env.TEST_DATABASE_URL = container.getConnectionUri()
}

export async function teardown(): Promise<void> {
  await container?.stop()
}
