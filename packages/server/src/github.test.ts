import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, startTestServer, type TestServer, unique } from './__tests__/harness.js'
import { loadConfig } from './config.js'
import { users } from './db/schema.js'
import { decodeState, encodeState } from './routes/github.js'

/**
 * A stand-in for github.com and api.github.com: code `good-<login>` trades for
 * token `tok-<login>`, which `/user` answers as <login>.
 */
async function fakeGitHub(): Promise<{ url: string; server: Server; exchanges: unknown[] }> {
  const exchanges: unknown[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      if (request.method === 'POST' && request.url === '/login/oauth/access_token') {
        const sent = JSON.parse(body) as { code: string }
        exchanges.push(sent)
        const login = sent.code.startsWith('good-') ? sent.code.slice(5) : null
        response.end(
          JSON.stringify(
            login === null ? { error: 'bad_verification_code' } : { access_token: `tok-${login}` },
          ),
        )
        return
      }
      if (request.url === '/user') {
        const token = (request.headers.authorization ?? '').replace('Bearer tok-', '')
        response.statusCode = token.length > 0 ? 200 : 401
        response.end(JSON.stringify({ login: token, name: `${token} name` }))
        return
      }
      response.statusCode = 404
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, exchanges }
}

describe('GitHub sign-in (§6.1)', () => {
  let server: TestServer
  let github: Awaited<ReturnType<typeof fakeGitHub>>

  beforeAll(async () => {
    github = await fakeGitHub()
    server = await startTestServer({
      publicUrl: 'https://yuzie.example.com',
      githubClientId: 'client-id',
      githubClientSecret: 'client-secret',
      githubUrl: github.url,
      githubApiUrl: github.url,
    })
  })

  afterAll(async () => {
    await server?.close()
    await new Promise<void>((resolve) => github?.server.close(() => resolve()))
  })

  /** Start `yuzie login`, and walk the browser through GitHub as `login`. */
  async function signInAs(
    login: string,
  ): Promise<{ status: number; body: string; deviceCode: string }> {
    const started = await call<{ deviceCode: string; userCode: string }>(server, {
      method: 'POST',
      url: '/v1/auth/device',
    })
    const start = await server.app.inject({
      method: 'GET',
      url: `/v1/auth/github/start?code=${started.body.userCode.toLowerCase()}`,
    })
    expect(start.statusCode).toBe(302)
    const location = new URL(start.headers.location as string)
    const callback = await server.app.inject({
      method: 'GET',
      url: `/v1/auth/github/callback?code=good-${login}&state=${location.searchParams.get('state')}`,
    })
    return { status: callback.statusCode, body: callback.body, deviceCode: started.body.deviceCode }
  }

  it('the device page offers GitHub, and its policy allows the trip there', async () => {
    const page = await server.app.inject({ method: 'GET', url: '/device' })
    expect(page.body).toContain('Sign in with GitHub')
    expect(page.body).not.toContain('name="handle"')
    expect(page.headers['content-security-policy']).toContain(`form-action 'self' ${github.url}`)
  })

  it('sends the browser to GitHub with the client id, the callback and a signed state', async () => {
    const started = await call<{ userCode: string }>(server, {
      method: 'POST',
      url: '/v1/auth/device',
    })
    const start = await server.app.inject({
      method: 'GET',
      url: `/v1/auth/github/start?code=${started.body.userCode}`,
    })
    const location = new URL(start.headers.location as string)
    expect(`${location.origin}${location.pathname}`).toBe(`${github.url}/login/oauth/authorize`)
    expect(location.searchParams.get('client_id')).toBe('client-id')
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://yuzie.example.com/v1/auth/github/callback',
    )
    expect(decodeState('client-secret', location.searchParams.get('state') as string)).toBe(
      started.body.userCode,
    )
  })

  it('signs the terminal in as the GitHub user, who becomes @login', async () => {
    const login = unique('octo')
    const { status, body, deviceCode } = await signInAs(login)
    expect(status).toBe(200)
    expect(body).toContain(`Signed in as @${login}`)

    const token = await call<{ token: string; user: { handle: string; githubLogin: string } }>(
      server,
      { method: 'POST', url: '/v1/auth/device/token', body: { deviceCode } },
    )
    expect(token.status).toBe(200)
    expect(token.body.user).toMatchObject({ handle: login, githubLogin: login })
    // The client secret went to GitHub, never anywhere else.
    expect(github.exchanges.at(-1)).toMatchObject({ client_id: 'client-id', code: `good-${login}` })

    // A second device for the same person finds the same account.
    const again = await signInAs(login)
    expect(again.status).toBe(200)
    const rows = await server.handle.db.select().from(users).where(eq(users.handle, login))
    expect(rows).toHaveLength(1)
  })

  it('links an account made before GitHub sign-in was turned on', async () => {
    const login = unique('early')
    await server.handle.db.insert(users).values({ handle: login, kind: 'human' })
    expect((await signInAs(login)).status).toBe(200)
    const [row] = await server.handle.db.select().from(users).where(eq(users.handle, login))
    expect(row?.githubLogin).toBe(login)
  })

  it('refuses a forged or expired state, a failed exchange, and a reused code', async () => {
    const started = await call<{ userCode: string }>(server, {
      method: 'POST',
      url: '/v1/auth/device',
    })
    const forged = encodeState('not-the-secret', started.body.userCode)
    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/auth/github/callback?code=good-x&state=${forged}`,
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('not valid or has expired')
    expect(
      decodeState('client-secret', encodeState('client-secret', 'ABCD-1234', 0), 11 * 60 * 1000),
    ).toBeNull()

    const state = encodeState('client-secret', started.body.userCode)
    const bad = await server.app.inject({
      method: 'GET',
      url: `/v1/auth/github/callback?code=bad&state=${state}`,
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.body).toContain('Could not confirm who you are')

    const ok = await server.app.inject({
      method: 'GET',
      url: `/v1/auth/github/callback?code=good-${unique('once')}&state=${state}`,
    })
    expect(ok.statusCode).toBe(200)
    const replay = await server.app.inject({
      method: 'GET',
      url: `/v1/auth/github/callback?code=good-${unique('twice')}&state=${state}`,
    })
    expect(replay.statusCode).toBe(400)
  })

  it('no longer approves a typed handle, except for your own session', async () => {
    const started = await call<{ userCode: string }>(server, {
      method: 'POST',
      url: '/v1/auth/device',
    })
    const typed = await call<{ error: { message: string } }>(server, {
      method: 'POST',
      url: '/v1/auth/device/approve',
      body: { userCode: started.body.userCode, handle: 'anyone' },
    })
    expect(typed.status).toBe(403)
    expect(typed.body.error.message).toContain('Sign in with GitHub')
  })

  it('an unknown code is turned away before GitHub', async () => {
    const start = await server.app.inject({
      method: 'GET',
      url: '/v1/auth/github/start?code=NOPE-0000',
    })
    expect(start.statusCode).toBe(400)
  })
})

describe('GitHub sign-in settings', () => {
  it('needs both the client id and the secret', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://x', YUZIE_GITHUB_CLIENT_ID: 'id' }),
    ).toThrow('YUZIE_GITHUB_CLIENT_SECRET')
  })

  it('is off without them: no GitHub routes, and the handle form stays', async () => {
    const plain = await startTestServer()
    try {
      const start = await plain.app.inject({ method: 'GET', url: '/v1/auth/github/start?code=X' })
      expect(start.statusCode).toBe(404)
      const page = await plain.app.inject({ method: 'GET', url: '/device' })
      expect(page.body).toContain('name="handle"')
    } finally {
      await plain.close()
    }
  })

  it('in invite mode, an uninvited GitHub user is turned away', async () => {
    const github = await fakeGitHub()
    const invited = await startTestServer({
      signupMode: 'invite',
      githubClientId: 'id',
      githubClientSecret: 'secret',
      githubUrl: github.url,
      githubApiUrl: github.url,
    })
    try {
      const started = await call<{ userCode: string }>(invited, {
        method: 'POST',
        url: '/v1/auth/device',
      })
      const state = encodeState('secret', started.body.userCode)
      const response = await invited.app.inject({
        method: 'GET',
        url: `/v1/auth/github/callback?code=good-${unique('stranger')}&state=${state}`,
      })
      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('has not been invited')
    } finally {
      await invited.close()
      await new Promise<void>((resolve) => github.server.close(() => resolve()))
    }
  })
})
