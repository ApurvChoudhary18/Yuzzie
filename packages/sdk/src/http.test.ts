import {
  AuthenticationError,
  CardSchema,
  ConflictError,
  InternalError,
  NotFoundError,
  OfflineError,
  RateLimitError,
} from '@yuzie/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createHttp, errorFromResponse } from './http.js'
import type { FetchLike, RequestInitLike, ResponseLike } from './platform.js'

function response(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): ResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

function envelope(code: string, status: number, details: Record<string, unknown> = {}) {
  return { error: { code, message: `${code} happened`, status, details } }
}

/** A fetch that answers from a script and records what it was asked. */
function scripted(...answers: Array<ResponseLike | Error>) {
  const calls: Array<{ url: string; init: RequestInitLike }> = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = answers.shift()
    if (next === undefined) throw new Error('fetch called more times than scripted')
    if (next instanceof Error) throw next
    return next
  }
  return { fetch, calls }
}

const sleeps: number[] = []
const base = {
  baseUrl: 'https://api.example.test/v1/',
  sleep: async (ms: number) => {
    sleeps.push(ms)
  },
  random: () => 0.5,
}

describe('createHttp', () => {
  it('sends auth, idempotency and If-Match headers, and a JSON body', async () => {
    const { fetch, calls } = scripted(response(200, { ok: true }))
    const http = createHttp({ ...base, fetch, token: 'yz_secret', client: 'test/1.0.0' })
    await http.request({
      method: 'PATCH',
      path: '/boards/b/cards/1',
      body: { title: 'x' },
      idempotencyKey: 'key-1',
      ifMatch: 3,
      schema: z.object({ ok: z.boolean() }),
    })

    const [call] = calls
    expect(call?.url).toBe('https://api.example.test/v1/boards/b/cards/1')
    expect(call?.init.method).toBe('PATCH')
    expect(call?.init.headers).toMatchObject({
      authorization: 'Bearer yz_secret',
      'idempotency-key': 'key-1',
      'if-match': '3',
      'content-type': 'application/json',
      'x-yuzie-client': 'test/1.0.0',
    })
    expect(call?.init.body).toBe('{"title":"x"}')
  })

  it('reads the token lazily, so a refreshed credential is used', async () => {
    const { fetch, calls } = scripted(response(200, {}), response(200, {}))
    let token = 'first'
    const http = createHttp({ ...base, fetch, token: () => token })
    await http.request({ method: 'GET', path: '/me', schema: z.object({}) })
    token = 'second'
    await http.request({ method: 'GET', path: '/me', schema: z.object({}) })
    expect(calls.map((call) => call.init.headers.authorization)).toEqual([
      'Bearer first',
      'Bearer second',
    ])
  })

  it('encodes a query and leaves out undefined values', async () => {
    const { fetch, calls } = scripted(response(200, {}))
    const http = createHttp({ ...base, fetch })
    await http.request({
      method: 'GET',
      path: '/boards/b/cards',
      query: { column: 'in review', assignee: undefined, limit: 5 },
      schema: z.object({}),
    })
    expect(calls[0]?.url).toBe(
      'https://api.example.test/v1/boards/b/cards?column=in%20review&limit=5',
    )
  })

  it('retries 5xx with growing, jittered delays, then succeeds', async () => {
    sleeps.length = 0
    const { fetch, calls } = scripted(
      response(503, envelope('internal', 503)),
      response(500, envelope('internal', 500)),
      response(200, { ok: true }),
    )
    const http = createHttp({ ...base, fetch })
    await http.request({ method: 'GET', path: '/x', schema: z.object({ ok: z.boolean() }) })
    expect(calls).toHaveLength(3)
    // 250 ms then 500 ms ceilings, equal jitter at random() = 0.5 -> 75 % of each.
    expect(sleeps).toEqual([187.5, 375])
  })

  it('honours Retry-After on 429', async () => {
    sleeps.length = 0
    const { fetch } = scripted(
      response(429, envelope('rate_limited', 429), { 'retry-after': '2' }),
      response(200, {}),
    )
    const http = createHttp({ ...base, fetch })
    await http.request({ method: 'POST', path: '/x', schema: z.object({}), idempotencyKey: 'k' })
    expect(sleeps).toEqual([2000])
  })

  it('gives up after the retry budget and throws the typed error', async () => {
    const { fetch, calls } = scripted(
      response(429, envelope('rate_limited', 429)),
      response(429, envelope('rate_limited', 429)),
    )
    const http = createHttp({ ...base, fetch, retries: 1 })
    await expect(
      http.request({ method: 'GET', path: '/x', schema: z.object({}) }),
    ).rejects.toBeInstanceOf(RateLimitError)
    expect(calls).toHaveLength(2)
  })

  it('does not retry a 4xx: the answer will not change', async () => {
    const { fetch, calls } = scripted(response(404, envelope('card_not_found', 404, { number: 9 })))
    const http = createHttp({ ...base, fetch })
    const error = await http
      .request({ method: 'GET', path: '/x', schema: z.object({}) })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NotFoundError)
    expect((error as NotFoundError).details).toEqual({ number: 9 })
    expect(calls).toHaveLength(1)
  })

  it('maps a 409 to ConflictError, keeping the server card in details', async () => {
    const { fetch } = scripted(
      response(409, envelope('version_conflict', 409, { current: { a: 1 } })),
    )
    const http = createHttp({ ...base, fetch })
    const error = await http
      .request({ method: 'PATCH', path: '/x', schema: z.object({}) })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).details.current).toEqual({ a: 1 })
  })

  it('turns an unreachable server into OfflineError after retrying', async () => {
    const { fetch, calls } = scripted(
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
    )
    const http = createHttp({ ...base, fetch, retries: 2 })
    const error = await http
      .request({ method: 'GET', path: '/x', schema: z.object({}) })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OfflineError)
    expect((error as OfflineError).code).toBe('offline_network_required')
    expect(calls).toHaveLength(3)
  })

  it('does not retry a request the caller aborted', async () => {
    const aborted = new Error('This operation was aborted')
    aborted.name = 'AbortError'
    const { fetch, calls } = scripted(aborted, response(200, {}))
    const http = createHttp({ ...base, fetch, retries: 2 })
    const error = await http
      .request({ method: 'GET', path: '/x', schema: z.object({}) })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OfflineError)
    expect(calls).toHaveLength(1)
  })

  it('rejects a 2xx body that does not match the contract, instead of returning it', async () => {
    const { fetch } = scripted(response(200, { number: 'eighteen' }))
    const http = createHttp({ ...base, fetch })
    await expect(
      http.request({ method: 'GET', path: '/boards/b/cards/18', schema: CardSchema }),
    ).rejects.toBeInstanceOf(InternalError)
  })
})

describe('errorFromResponse', () => {
  it('rebuilds the subclass for the code', () => {
    expect(errorFromResponse(401, envelope('unauthenticated', 401))).toBeInstanceOf(
      AuthenticationError,
    )
  })

  it('reports a body-less failure as internal, with the status', () => {
    const error = errorFromResponse(502, undefined)
    expect(error).toBeInstanceOf(InternalError)
    expect(error.status).toBe(502)
  })
})
