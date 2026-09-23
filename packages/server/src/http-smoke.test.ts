import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer, unique } from './__tests__/harness.js'

/**
 * The rest of the suite drives the app through `app.inject()`, which is fast but
 * skips the HTTP layer entirely — no real content-type negotiation, no socket,
 * no `listen`. That gap hid a defect: Fastify rejects an empty body when
 * `Content-Type: application/json` is set, which is exactly what `fetch` sends
 * for a POST with no payload, so `POST /auth/device` answered 400 to any normal
 * client while every inject-based test passed.
 *
 * This suite talks to a real socket for that reason.
 */
describe('over a real socket', () => {
  let server: TestServer
  let base: string

  beforeAll(async () => {
    server = await startTestServer()
    await server.app.listen({ host: '127.0.0.1', port: 0 })
    const address = server.app.server.address() as AddressInfo
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await server?.close()
  })

  const call = async (
    method: string,
    path: string,
    options: { token?: string; body?: string; contentType?: string | null } = {},
  ) => {
    const headers: Record<string, string> = {}
    if (options.contentType !== null) {
      headers['content-type'] = options.contentType ?? 'application/json'
    }
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`

    const response = await fetch(base + path, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }
    return { status: response.status, body: parsed as Record<string, never>, raw: text }
  }

  it('binds a port and answers /healthz', async () => {
    const response = await call('GET', '/healthz')
    expect(response.status).toBe(200)
    expect(response.body.status).toBe('ok')
  })

  it('serves prometheus text at /metrics', async () => {
    const response = await call('GET', '/metrics')
    expect(response.status).toBe(200)
    expect(response.raw).toContain('yuzie_http_duration_seconds')
  })

  it('accepts a POST with a JSON content-type and no body', async () => {
    // The regression this suite exists for.
    const response = await call('POST', '/v1/auth/device')
    expect(response.status).toBe(201)
    expect(typeof response.body.deviceCode).toBe('string')
  })

  it('accepts the same POST with no content-type at all', async () => {
    const response = await call('POST', '/v1/auth/device', { contentType: null })
    expect(response.status).toBe(201)
  })

  it('accepts an explicit empty object', async () => {
    const response = await call('POST', '/v1/auth/device', { body: '{}' })
    expect(response.status).toBe(201)
  })

  it('reports malformed JSON as a validation failure, not a crash', async () => {
    const response = await call('POST', '/v1/auth/device', { body: '{not json' })
    expect(response.status).toBe(400)
    expect(response.body.error).toMatchObject({ code: 'validation_failed' })
  })

  it('completes the device flow and authenticates a real request', async () => {
    const started = await call('POST', '/v1/auth/device')
    const handle = unique('smoke').replace(/[^a-z0-9-]/g, '')

    await call('POST', '/v1/auth/device/approve', {
      body: JSON.stringify({ userCode: started.body.userCode, handle }),
    })
    const issued = await call('POST', '/v1/auth/device/token', {
      body: JSON.stringify({ deviceCode: started.body.deviceCode }),
    })
    expect(issued.status).toBe(200)

    const token = issued.body.token as unknown as string
    const me = await call('GET', '/v1/me', { token })
    expect(me.status).toBe(200)
    expect((me.body.user as unknown as { handle: string }).handle).toBe(handle)
  })

  it('carries the §12.1 envelope on a real HTTP error', async () => {
    const response = await call('GET', '/v1/boards/definitely-not-a-board', {
      token: 'yz_not-a-token',
    })
    expect(response.status).toBe(401)
    expect(response.body.error).toMatchObject({ code: 'unauthenticated' })
  })

  it('sets a JSON content type on responses', async () => {
    const response = await fetch(`${base}/healthz`)
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})
