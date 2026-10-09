/**
 * Sign in with GitHub (SPEC.md §6.1), when the server has an OAuth App's client
 * id and secret.
 *
 * The terminal still uses the device-code flow: `yuzie login` prints a code and
 * polls. What changes is how the code is approved:
 * 1. The device page sends the code to `GET /v1/auth/github/start`.
 * 2. That redirects to GitHub, which sends the browser back to
 *    `GET /v1/auth/github/callback`.
 * 3. The callback approves the code as the GitHub user. A handle is therefore
 *    a GitHub login, and nobody can sign in as someone else.
 *
 * The code travels through GitHub inside `state`, signed with the client
 * secret, so no extra storage is needed and a forged or stale `state` is
 * refused. GitHub's access token is used once, to ask who the user is, and is
 * never stored.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { githubSignIn } from '../config.js'
import { deviceCodes, users } from '../db/schema.js'
import { sendMessagePage } from './device-page.js'
import type { AppContext } from './helpers.js'

/** How long the round trip through GitHub may take. */
const STATE_TTL_MS = 10 * 60 * 1000

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function encodeState(secret: string, userCode: string, now = Date.now()): string {
  const payload = Buffer.from(`${userCode}.${now + STATE_TTL_MS}`).toString('base64url')
  return `${payload}.${sign(secret, payload)}`
}

/** The user code inside a state this server signed, if it is genuine and current. */
export function decodeState(secret: string, state: string, now = Date.now()): string | null {
  const [payload, signature] = state.split('.')
  if (payload === undefined || signature === undefined) return null
  const expected = Buffer.from(sign(secret, payload))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  const [userCode, expires] = Buffer.from(payload, 'base64url').toString('utf8').split('.')
  if (userCode === undefined || Number(expires) < now) return null
  return userCode
}

interface GitHubUser {
  readonly login: string
  readonly name: string | null
}

export function registerGitHubRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, config } = context
  if (!githubSignIn(config)) return
  const clientId = config.githubClientId as string
  const clientSecret = config.githubClientSecret as string
  const callbackUrl = `${config.publicUrl.replace(/\/+$/, '')}/v1/auth/github/callback`

  /** A login waiting for approval, by its user code. */
  const pendingLogin = async (userCode: string) => {
    const [pending] = await db
      .select()
      .from(deviceCodes)
      .where(and(eq(deviceCodes.userCode, userCode), isNull(deviceCodes.approvedAt)))
    return pending !== undefined && pending.expiresAt.getTime() > Date.now() ? pending : undefined
  }

  app.get<{ Querystring: { code?: string } }>('/auth/github/start', async (request, reply) => {
    const userCode = (request.query.code ?? '').trim().toUpperCase()
    if (userCode.length === 0 || (await pendingLogin(userCode)) === undefined) {
      return sendMessagePage(
        reply,
        'That code is not waiting',
        'Check the code in your terminal, or run `yuzie login` again for a new one.',
        400,
      )
    }
    const authorize = new URL('/login/oauth/authorize', config.githubUrl)
    authorize.searchParams.set('client_id', clientId)
    authorize.searchParams.set('redirect_uri', callbackUrl)
    authorize.searchParams.set('state', encodeState(clientSecret, userCode))
    // No scopes: who the user is (their public profile) is all Yuzie needs.
    authorize.searchParams.set('allow_signup', 'true')
    return reply.redirect(authorize.toString(), 302)
  })

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/github/callback',
    async (request, reply) => {
      const fail = (message: string) =>
        sendMessagePage(reply, 'Sign-in did not finish', message, 400)
      if (request.query.error !== undefined)
        return fail('GitHub did not sign you in. Run `yuzie login` to try again.')
      const userCode = decodeState(clientSecret, request.query.state ?? '')
      if (userCode === null || request.query.code === undefined)
        return fail('That sign-in link is not valid or has expired. Run `yuzie login` again.')
      const pending = await pendingLogin(userCode)
      if (pending === undefined)
        return fail('That login expired or was already approved. Run `yuzie login` again.')

      const github = await whoIsThis(request.query.code).catch(() => null)
      if (github === null)
        return fail('Could not confirm who you are with GitHub. Run `yuzie login` again.')

      const account = await accountFor(github)
      if ('refused' in account) return fail(account.refused)

      await db
        .update(deviceCodes)
        .set({ userId: account.id, approvedAt: new Date() })
        .where(eq(deviceCodes.deviceCode, pending.deviceCode))
      return sendMessagePage(
        reply,
        `Signed in as @${github.login}`,
        'You can close this tab and return to your terminal.',
      )
    },
  )

  /** Trade GitHub's code for a token, ask who it belongs to, and forget the token. */
  async function whoIsThis(code: string): Promise<GitHubUser> {
    const exchange = await fetch(new URL('/login/oauth/access_token', config.githubUrl), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const { access_token: token } = (await exchange.json()) as { access_token?: string }
    if (!exchange.ok || typeof token !== 'string') throw new Error('no access token')
    const profile = await fetch(new URL('/user', config.githubApiUrl), {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'yuzie-server',
      },
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await profile.json()) as { login?: unknown; name?: unknown }
    if (!profile.ok || typeof body.login !== 'string') throw new Error('no profile')
    return { login: body.login, name: typeof body.name === 'string' ? body.name : null }
  }

  /** The account for this GitHub user (created if signup is open), or why not. */
  async function accountFor(github: GitHubUser): Promise<{ id: string } | { refused: string }> {
    const [linked] = await db.select().from(users).where(eq(users.githubLogin, github.login))
    const [byHandle] =
      linked === undefined
        ? await db.select().from(users).where(eq(users.handle, github.login))
        : [linked]
    const existing = byHandle
    if (existing !== undefined) {
      if (existing.deletedAt !== null)
        return { refused: `@${existing.handle} was deleted, and cannot sign in again.` }
      if (existing.githubLogin !== null && existing.githubLogin !== github.login)
        return { refused: `@${existing.handle} belongs to another GitHub account.` }
      if (existing.kind !== 'human')
        return { refused: `@${existing.handle} is an agent, not a person.` }
      if (existing.githubLogin === null)
        await db.update(users).set({ githubLogin: github.login }).where(eq(users.id, existing.id))
      return { id: existing.id }
    }
    if (config.signupMode === 'invite')
      return {
        refused: `This server only lets in invited people, and @${github.login} has not been invited.`,
      }
    const [created] = await db
      .insert(users)
      .values({
        handle: github.login,
        displayName: github.name,
        kind: 'human',
        githubLogin: github.login,
      })
      .returning({ id: users.id })
    if (created === undefined) return { refused: 'Could not create your account.' }
    return { id: created.id }
  }
}
