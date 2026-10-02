/**
 * `yuzie serve` (SPEC.md §7.2): run the board server on this machine, for
 * development or a small self-hosted team.
 *
 * The server is its own package (`@yuzie/server`): bundling it would put
 * Fastify, Postgres drivers and the rest into every CLI install, so this finds
 * it, or fetches the version matching this CLI through npx, and runs it. It
 * needs Postgres. With `DATABASE_URL` (or `--database-url`) set, that database
 * is used. Otherwise, given Docker, a Postgres container is started and reused:
 * `yuzie-serve-postgres`, on 127.0.0.1 only, with its data in the
 * `yuzie-serve-data` volume.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '../context.js'
import { RuntimeError, UsageError } from '../exit.js'
import { supervisor } from '../screen.js'
import { VERSION } from '../version.js'

export const SERVE_CONTAINER = 'yuzie-serve-postgres'
export const SERVE_VOLUME = 'yuzie-serve-data'
const SERVE_DB_PORT = 54329
const SERVE_DATABASE_URL = `postgres://yuzie:yuzie@127.0.0.1:${SERVE_DB_PORT}/yuzie`

export interface ServeOptions {
  readonly port?: string
  readonly host?: string
  readonly databaseUrl?: string
}

/** How to start the server: a local install if there is one, else npx. */
export function serverCommand(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string[] {
  if (env.YUZIE_SERVER_BIN !== undefined) return [process.execPath, env.YUZIE_SERVER_BIN]
  for (const from of [join(cwd, 'noop.js'), import.meta.url]) {
    try {
      const manifest = createRequire(from).resolve('@yuzie/server/package.json')
      const bin = join(dirname(manifest), 'bin', 'yuzie-server.js')
      if (existsSync(bin)) return [process.execPath, bin]
    } catch {
      // Not installed there.
    }
  }
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const version = VERSION.includes('dev') ? 'latest' : VERSION
  return [npx, '--yes', '--package', `@yuzie/server@${version}`, 'yuzie-server']
}

function docker(args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() }
}

/** Start (or reuse) the development Postgres container, and wait until it answers. */
async function localPostgres(context: Context): Promise<string> {
  if (!docker(['version', '--format', '{{.Server.Version}}']).ok) {
    throw new UsageError(
      'yuzie serve needs a Postgres database.',
      'Set DATABASE_URL (or --database-url) to a Postgres 16 database, or start Docker and run this again.',
    )
  }
  const state = docker(['inspect', '-f', '{{.State.Running}}', SERVE_CONTAINER])
  if (!state.ok) {
    context.output.line(`  Starting Postgres in Docker (${SERVE_CONTAINER})…`)
    const started = docker([
      'run',
      '--detach',
      '--name',
      SERVE_CONTAINER,
      '--env',
      'POSTGRES_USER=yuzie',
      '--env',
      'POSTGRES_PASSWORD=yuzie',
      '--env',
      'POSTGRES_DB=yuzie',
      '--publish',
      `127.0.0.1:${SERVE_DB_PORT}:5432`,
      '--volume',
      `${SERVE_VOLUME}:/var/lib/postgresql/data`,
      'postgres:16-alpine',
    ])
    if (!started.ok)
      throw new RuntimeError('Could not start a Postgres container.', 'Is Docker running?')
  } else if (state.out !== 'true') {
    docker(['start', SERVE_CONTAINER])
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (docker(['exec', SERVE_CONTAINER, 'pg_isready', '-U', 'yuzie', '-d', 'yuzie']).ok)
      return SERVE_DATABASE_URL
    await new Promise((done) => setTimeout(done, 1000))
  }
  throw new RuntimeError(
    'Postgres did not become ready within a minute.',
    `See \`docker logs ${SERVE_CONTAINER}\`.`,
  )
}

export async function serve(context: Context, options: ServeOptions): Promise<number> {
  const env = context.io.env
  const port = options.port ?? env.PORT ?? '8787'
  if (!/^\d+$/.test(port)) throw new UsageError(`"${port}" is not a port.`)
  const host = options.host ?? env.HOST ?? '127.0.0.1'
  const { output } = context

  let databaseUrl = options.databaseUrl ?? env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    databaseUrl = await localPostgres(context)
    output.line(
      output.paint(
        'dim',
        `  Data is kept in the ${SERVE_VOLUME} volume. To remove it: docker rm -f ${SERVE_CONTAINER} && docker volume rm ${SERVE_VOLUME}`,
      ),
    )
  }

  const publicUrl = env.YUZIE_PUBLIC_URL ?? `http://localhost:${port}`
  output.success(`Serving on ${publicUrl}`)
  output.line(`  Point the CLI at it:  export YUZIE_SERVER=${publicUrl}/v1`)
  output.line(output.paint('dim', '  Ctrl-C stops the server.'))

  const [command, ...args] = serverCommand(env, context.io.cwd)
  const child = spawn(command as string, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...env,
      DATABASE_URL: databaseUrl,
      PORT: port,
      HOST: host,
      YUZIE_PUBLIC_URL: publicUrl,
    } as NodeJS.ProcessEnv,
  })
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
  const onInt = forward('SIGINT')
  const onTerm = forward('SIGTERM')
  supervisor.active = true
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  context.io.stop?.then(() => child.kill('SIGTERM'))
  try {
    return await new Promise<number>((done, fail) => {
      child.once('error', (error) =>
        fail(new RuntimeError(`Could not start the server: ${error.message}`)),
      )
      child.once('exit', (code, signal) =>
        done(signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : (code ?? 1)),
      )
    })
  } finally {
    supervisor.active = false
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }
}
