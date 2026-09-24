/**
 * The HTTP layer (SPEC.md §12.1, §18 Session 5).
 *
 * Every request is typed end to end: the response is validated against the
 * `@yuzie/core` schema the caller names, so a server that drifts from the
 * contract is an error here rather than an `undefined` three calls later.
 *
 * Retries: 5xx, 429 (honouring `Retry-After`) and network failures are retried
 * with jittered exponential backoff. That is only safe because every mutation
 * the SDK sends carries an `Idempotency-Key` (§12.1); a retried POST replays the
 * stored response instead of creating a second card.
 */
import {
  BoardError,
  type ErrorEnvelope,
  ErrorEnvelopeSchema,
  InternalError,
  OfflineError,
} from '@yuzie/core'
import type { z } from 'zod'
import type { FetchLike, ResponseLike } from './platform.js'

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface HttpOptions {
  /** e.g. `https://api.yuzie.dev/v1`; a trailing slash is ignored. */
  readonly baseUrl: string
  /** A token, or a function returning one — so a refreshed credential is picked up. */
  readonly token?: string | (() => string | undefined)
  readonly fetch: FetchLike
  /** Attempts after the first. Defaults to 3. */
  readonly retries?: number
  /** First retry delay in ms; doubles each attempt. Defaults to 250. */
  readonly retryBaseMs?: number
  /** Injected so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
  /** Sent as `X-Yuzie-Client`, e.g. `cli/1.0.0`. */
  readonly client?: string
}

export interface RequestOptions<S extends z.ZodType> {
  readonly method: HttpMethod
  readonly path: string
  readonly schema: S
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>
  readonly body?: unknown
  readonly idempotencyKey?: string
  /** A card version for optimistic concurrency (§11.4). */
  readonly ifMatch?: number
}

export interface Http {
  readonly baseUrl: string
  request<S extends z.ZodType>(options: RequestOptions<S>): Promise<z.infer<S>>
}

const MAX_RETRY_DELAY_MS = 8_000

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: RequestOptions<z.ZodType>['query'],
): string {
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`
  if (query === undefined) return url
  const params = Object.entries(query)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  return params.length === 0 ? url : `${url}?${params.join('&')}`
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Turn a non-2xx response into the typed error class for its code. */
export function errorFromResponse(status: number, body: unknown): BoardError {
  const envelope = ErrorEnvelopeSchema.safeParse(body)
  if (envelope.success) return BoardError.fromEnvelope(envelope.data as ErrorEnvelope)
  return new InternalError('internal', `The server answered ${status} without an error body`, {
    status,
    details: { status },
  })
}

function retryAfterMs(response: ResponseLike): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500
}

export function createHttp(options: HttpOptions): Http {
  const retries = options.retries ?? 3
  const base = options.retryBaseMs ?? 250
  const sleep = options.sleep ?? sleepFor
  const random = options.random ?? Math.random

  function token(): string | undefined {
    return typeof options.token === 'function' ? options.token() : options.token
  }

  function backoff(attempt: number): number {
    const ceiling = Math.min(MAX_RETRY_DELAY_MS, base * 2 ** attempt)
    // Equal jitter: never less than half the ceiling, so retries still spread out.
    return ceiling / 2 + random() * (ceiling / 2)
  }

  return {
    baseUrl: options.baseUrl,

    async request(request) {
      const url = buildUrl(options.baseUrl, request.path, request.query)
      const headers: Record<string, string> = { accept: 'application/json' }
      const bearer = token()
      if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`
      if (options.client !== undefined) headers['x-yuzie-client'] = options.client
      if (request.idempotencyKey !== undefined) headers['idempotency-key'] = request.idempotencyKey
      if (request.ifMatch !== undefined) headers['if-match'] = String(request.ifMatch)

      let body: string | undefined
      if (request.body !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(request.body)
      }

      for (let attempt = 0; ; attempt += 1) {
        let response: ResponseLike
        try {
          response = await options.fetch(url, {
            method: request.method,
            headers,
            ...(body === undefined ? {} : { body }),
          })
        } catch (cause) {
          if (attempt < retries) {
            await sleep(backoff(attempt))
            continue
          }
          throw new OfflineError('offline_network_required', `Cannot reach ${options.baseUrl}`, {
            status: 0,
            details: { url },
            cause,
          })
        }

        const payload = parseJson(await response.text())

        if (response.ok) {
          const parsed = request.schema.safeParse(payload)
          if (parsed.success) return parsed.data
          throw new InternalError(
            'internal',
            `${request.method} ${request.path} returned a body that does not match the API contract`,
            { status: response.status, details: { issues: parsed.error.issues.slice(0, 5) } },
          )
        }

        if (retryable(response.status) && attempt < retries) {
          await sleep(retryAfterMs(response) ?? backoff(attempt))
          continue
        }
        throw errorFromResponse(response.status, payload)
      }
    },
  }
}
