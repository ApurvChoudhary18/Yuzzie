/**
 * `fetch` for Node, on `node:http` (SPEC.md §18 Session 16).
 *
 * The global `fetch` is undici, which Node loads and compiles on first use —
 * with a WebAssembly HTTP parser — costing a one-shot command ~12 ms before
 * its first byte goes out. `node:http` is already part of the process and
 * parses with the native llhttp. This does the small part of fetch the SDK
 * uses, and fails the way fetch does: a `TypeError` when the network does, the
 * signal's own reason (an `AbortError` or `TimeoutError`) when cancelled.
 */
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { FetchLike, ResponseLike } from './platform.js'

// Keep-alive, so a command's several requests share one connection.
const agents = {
  'http:': new HttpAgent({ keepAlive: true }),
  'https:': new HttpsAgent({ keepAlive: true }),
} as const

function response(message: IncomingMessage, body: Buffer): ResponseLike {
  const status = message.statusCode ?? 0
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const value = message.headers[name.toLowerCase()]
        if (value === undefined) return null
        return Array.isArray(value) ? value.join(', ') : String(value)
      },
    },
    text: async () => body.toString('utf8'),
  }
}

/** Like undici's headers and body timeouts: a server silent this long has failed. */
export const IDLE_TIMEOUT_MS = 300_000

export function createNodeFetch(options: { idleTimeoutMs?: number } = {}): FetchLike {
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  return (url, init) =>
    new Promise<ResponseLike>((resolve, reject) => {
      let target: URL
      try {
        target = new URL(url)
      } catch (cause) {
        reject(new TypeError(`Invalid URL: ${url}`, { cause }))
        return
      }
      const protocol = target.protocol
      if (protocol !== 'http:' && protocol !== 'https:') {
        reject(new TypeError(`Unsupported protocol: ${protocol}`))
        return
      }
      const signal = init.signal
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }

      const headers: Record<string, string | number> = { ...init.headers }
      if (init.body !== undefined) headers['content-length'] = Buffer.byteLength(init.body)
      const send = protocol === 'https:' ? httpsRequest : httpRequest

      let settled = false
      const finish = (outcome: () => void) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        outcome()
      }
      const request = send(
        target,
        { method: init.method, headers, agent: agents[protocol] },
        (message) => {
          const chunks: Buffer[] = []
          message.on('data', (chunk: Buffer) => chunks.push(chunk))
          message.on('end', () => finish(() => resolve(response(message, Buffer.concat(chunks)))))
          message.on('error', (cause) =>
            finish(() => reject(new TypeError('fetch failed', { cause }))),
          )
        },
      )
      function onAbort() {
        finish(() => reject(signal?.reason))
        request.destroy()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      request.on('error', (cause) => finish(() => reject(new TypeError('fetch failed', { cause }))))
      // Never wait forever on a connection that has gone quiet.
      request.setTimeout(idleTimeoutMs, () => {
        finish(() => reject(new TypeError(`fetch failed: no response for ${idleTimeoutMs} ms`)))
        request.destroy()
      })
      if (init.body !== undefined) request.write(init.body)
      request.end()
    })
}

export const nodeFetch: FetchLike = createNodeFetch()
