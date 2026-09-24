/**
 * One Postgres container for the whole e2e run; each test starts its own
 * server against it and isolates itself by creating its own users and boards.
 */
import './docker-env.js'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { build } from 'esbuild'

let container: StartedPostgreSqlContainer | undefined
let workspace: string | undefined

/**
 * Bundle the SDK's core entry for `platform: 'browser'`, which fails outright on
 * any Node built-in. Done here, in Node, because esbuild cannot run inside jsdom.
 */
async function bundleSdkForBrowser(): Promise<string> {
  // The workspace link to the built SDK. (Its `exports` map offers only `import`,
  // and vitest rewrites `import.meta`, so neither resolver is available here.)
  const entry = fileURLToPath(
    new URL('../../node_modules/@yuzie/sdk/dist/index.js', import.meta.url),
  )
  const bundle = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    // A classic script exposing `YuzieSDK`, so it can be evaluated inside a jsdom
    // window's own context, where Node's globals do not exist.
    format: 'iife',
    globalName: 'YuzieSDK',
    write: false,
    logLevel: 'silent',
  })
  // Inside the package, because vite refuses to load modules from outside it.
  workspace = fileURLToPath(new URL('../../node_modules/.cache/yuzie-browser/', import.meta.url))
  mkdirSync(workspace, { recursive: true })
  const file = join(workspace, 'sdk.browser.js')
  writeFileSync(file, bundle.outputFiles[0]?.text ?? '')
  return file
}

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('yuzie')
    .withUsername('yuzie')
    .withPassword('yuzie')
    .start()
  process.env.TEST_DATABASE_URL = container.getConnectionUri()
  process.env.SDK_BROWSER_BUNDLE = await bundleSdkForBrowser()
}

export async function teardown(): Promise<void> {
  await container?.stop()
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
}
