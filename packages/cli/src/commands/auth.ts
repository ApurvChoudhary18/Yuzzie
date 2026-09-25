/**
 * `yuzie login`, `yuzie logout`, `yuzie whoami` (SPEC.md §6.1, §7.2, §13.3).
 */
import { spawn } from 'node:child_process'
import { AuthenticationError, type User } from '@yuzie/core'
import { deleteToken, saveToken } from '@yuzie/sdk/node'
import type { Context } from '../context.js'

export interface SignedIn {
  readonly user: User
  /** Where the token was kept: the OS keychain, or `~/.yuzie/credentials`. */
  readonly storedIn: 'keychain' | 'file'
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Best effort, and only for a person at a terminal; a failure changes nothing. */
function openBrowser(url: string, env: Readonly<Record<string, string | undefined>>): void {
  if (env.CI !== undefined || env.YUZIE_NO_BROWSER !== undefined) return
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // No browser is fine: the URL and code are on screen.
  }
}

/**
 * The device-code flow (§6.1): print where to go and the code, then poll until
 * the login is approved, and store the token (§13.3).
 */
export async function signIn(context: Context): Promise<SignedIn> {
  context.requireNetwork('Signing in')
  const client = await context.anonymousClient()
  const started = await client.auth.start()

  context.output.step(`Opening ${started.verifyUrl} and waiting…`)
  context.output.line(`  Code: ${started.userCode}`)
  if (context.output.json) {
    // stdout is reserved for the JSON result, but a person still has to see these.
    context.output.notice(`Open ${started.verifyUrl} and enter the code ${started.userCode}`)
  }
  if (context.output.interactive) {
    openBrowser(`${started.verifyUrl}?code=${encodeURIComponent(started.userCode)}`, context.io.env)
  }

  const spinner = context.output.spinner('Waiting for approval')
  const deadline = Date.now() + started.expiresIn * 1000
  try {
    for (;;) {
      const polled = await client.auth.poll(started.deviceCode)
      if (polled.token !== undefined) {
        const storedIn = await saveToken(
          await context.server(),
          polled.token.token,
          context.credentials(),
        )
        return { user: polled.token.user, storedIn }
      }
      if (Date.now() >= deadline) {
        throw new AuthenticationError(
          'unauthenticated',
          'The login code expired before it was approved. Run `yuzie login` again.',
        )
      }
      await sleep(started.interval * 1000)
    }
  } finally {
    spinner.stop()
  }
}

export async function login(context: Context): Promise<void> {
  const { user, storedIn } = await signIn(context)
  context.output.success(`Signed in as @${user.handle}`)
  context.output.result('Login', { user, storedIn })
}

export async function logout(context: Context): Promise<void> {
  const client = await context.client()
  const server = await context.server()
  context.requireNetwork('Signing out')
  // Revoke on the server first: a token deleted only locally would still work
  // for whoever else had a copy.
  await client.tokens.revokeCurrent()
  await deleteToken(server, context.credentials())
  context.output.success(`Signed out of ${server}`)
  context.output.result('Logout', { server, revoked: true })
}

export async function whoami(context: Context): Promise<void> {
  context.requireNetwork('whoami')
  const client = await context.client()
  const { config } = await context.config()
  const [me, health] = await Promise.all([client.me(), client.health()])
  const membership =
    config.board === undefined
      ? undefined
      : me.memberships.find((m) => m.boardSlug === config.board)

  const { output } = context
  output.success(
    `Signed in as @${me.user.handle}${me.user.displayName ? ` (${me.user.displayName})` : ''}`,
  )
  output.line(`  Server:  ${config.server} ${output.paint('dim', `(${health.latencyMs} ms)`)}`)
  if (config.board === undefined) {
    output.line(`  Board:   ${output.paint('dim', 'none — run `yuzie init` in a repository')}`)
  } else if (membership === undefined) {
    output.warn(`Board ${config.board} is configured, but you are not a member of it`)
  } else {
    output.line(`  Board:   ${membership.boardSlug} (${membership.role})`)
  }
  output.line(`  Boards:  ${me.memberships.length}`)
  output.result('Whoami', {
    user: me.user,
    server: config.server,
    latencyMs: health.latencyMs,
    board: membership ?? null,
    memberships: me.memberships,
  })
}
