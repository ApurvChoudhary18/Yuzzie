import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OfflineError } from '@yuzie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createHttp } from './http.js'
import { createNodeFetch, nodeFetch } from './node-fetch.js'

let server: Server
let base = ''
const seen: Array<{ method: string; url: string; body: string; headers: Record<string, unknown> }> =
  []

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        body,
        headers: request.headers,
      })
      if (request.url === '/slow') return // never answers
      response.writeHead(request.url === '/missing' ? 404 : 200, {
        'content-type': 'application/json',
        'x-many': ['a', 'b'],
      })
      response.end(JSON.stringify({ echo: body, emoji: '🧪' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

describe('nodeFetch (§18 Session 16)', () => {
  it('sends method, headers and body; returns status, headers and text', async () => {
    const response = await nodeFetch(`${base}/echo?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: '{"hi":"🧪"}',
    })
    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(response.headers.get('x-many')).toBe('a, b')
    expect(response.headers.get('absent')).toBeNull()
    expect(JSON.parse(await response.text())).toEqual({ echo: '{"hi":"🧪"}', emoji: '🧪' })
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/echo?x=1' })
    expect(seen.at(-1)?.headers.authorization).toBe('Bearer t')
    const missing = await nodeFetch(`${base}/missing`, { method: 'GET', headers: {} })
    expect(missing).toMatchObject({ status: 404, ok: false })
  })

  it('fails like fetch: TypeError when the network does, the reason when cancelled', async () => {
    await expect(
      nodeFetch('http://127.0.0.1:9/', { method: 'GET', headers: {} }),
    ).rejects.toBeInstanceOf(TypeError)
    const controller = new AbortController()
    const pending = nodeFetch(`${base}/slow`, {
      method: 'GET',
      headers: {},
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      nodeFetch(`${base}/slow`, { method: 'GET', headers: {}, signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    await expect(
      nodeFetch('ftp://example.com/', { method: 'GET', headers: {} }),
    ).rejects.toBeInstanceOf(TypeError)
  })

  it('gives up on a server that goes quiet, instead of waiting forever', async () => {
    const quick = createNodeFetch({ idleTimeoutMs: 100 })
    const started = performance.now()
    await expect(quick(`${base}/slow`, { method: 'GET', headers: {} })).rejects.toThrow(
      /no response for 100 ms/,
    )
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('drives the SDK exactly as fetch does: data, and offline when unreachable', async () => {
    const http = createHttp({ baseUrl: base, fetch: nodeFetch, retries: 0 })
    const data = await http.request({
      method: 'GET',
      path: '/echo',
      schema: z.object({ emoji: z.string() }),
    })
    expect(data.emoji).toBe('🧪')
    const down = createHttp({ baseUrl: 'http://127.0.0.1:9', fetch: nodeFetch, retries: 0 })
    await expect(
      down.request({ method: 'GET', path: '/x', schema: z.unknown() }),
    ).rejects.toBeInstanceOf(OfflineError)
  })
})
