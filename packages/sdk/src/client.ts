/**
 * `Yuzie` — the SDK's entry point (SPEC.md §13.1).
 *
 * `Yuzie.connect(slug, options)` returns a live {@link Board}. `Yuzie.client()`
 * returns what is not scoped to one board — who am I, which boards, tokens, and
 * the device-code login — because §13.1's rule is that the CLI consumes only
 * the SDK, and the CLI needs all of those.
 */
import {
  type ApiToken,
  AuthenticationError,
  type BoardCreateRequest,
  type Board as BoardEntity,
  BoardListResponseSchema,
  BoardSchema,
  type DeviceAuthStartResponse,
  DeviceAuthStartResponseSchema,
  type DeviceTokenResponse,
  DeviceTokenResponseSchema,
  InternalError,
  type MeResponse,
  MeResponseSchema,
  newId,
  OfflineError,
  type TokenCreateRequest,
  type TokenCreateResponse,
  TokenCreateResponseSchema,
  TokenListResponseSchema,
} from '@yuzie/core'
import { z } from 'zod'
import { Board, type OfflineMode } from './board.js'
import type { CacheLike } from './cache.js'
import { createHttp, type Http } from './http.js'
import {
  defaultFetch,
  defaultWebSocket,
  type FetchLike,
  type WebSocketFactory,
} from './platform.js'

export const DEFAULT_BASE_URL = 'https://api.yuzie.dev/v1'

const HealthSchema = z.object({ status: z.literal('ok'), version: z.string() })

export interface ClientOptions {
  /** A bearer token. `@yuzie/sdk/node` fills this from the credential store (§13.3). */
  readonly token?: string
  readonly baseUrl?: string
  /** Defaults to the global `fetch`. */
  readonly fetch?: FetchLike
  /** Identifies the caller to the server, e.g. `cli/1.0.0`. */
  readonly client?: string
  /** HTTP retries after the first attempt, for 5xx, 429 and network errors. Defaults to 3. */
  readonly retries?: number
}

export interface ConnectOptions extends ClientOptions {
  /** `"queue"` keeps writes in the outbox while offline; `"fail"` (the default) throws. */
  readonly offline?: OfflineMode
  /** A local cache — `@yuzie/store`'s `openCache()` in Node. Omit for memory only. */
  readonly cache?: CacheLike
  /** Stream live events. Defaults to true when a WebSocket is available. */
  readonly realtime?: boolean
  /** Defaults to the global `WebSocket`. */
  readonly webSocket?: WebSocketFactory
  /** How long `connect` waits for the first sync before resolving from cache. Defaults to 10 s. */
  readonly connectTimeoutMs?: number
}

export interface DevicePollResult {
  /** Present once the user has approved the login in the browser. */
  readonly token?: DeviceTokenResponse
  /** Still waiting; poll again after `interval` seconds. */
  readonly pending: boolean
}

export interface ServerHealth {
  /** What the server reports, e.g. `yuzie/v1`. */
  readonly version: string
  /** Round trip, in milliseconds. */
  readonly latencyMs: number
}

export interface YuzieClient {
  readonly http: Http
  /** Is the server there, and how far away (`yuzie doctor`, §15)? */
  health(): Promise<ServerHealth>
  me(): Promise<MeResponse>
  readonly boards: {
    list(): Promise<BoardEntity[]>
    create(board: BoardCreateRequest): Promise<BoardEntity>
  }
  readonly tokens: {
    list(): Promise<ApiToken[]>
    /** The plaintext is in the result exactly once (§13.3). */
    create(token: TokenCreateRequest): Promise<TokenCreateResponse>
    revoke(id: string): Promise<void>
    /** Revoke the token this client is using — what `yuzie logout` does. */
    revokeCurrent(): Promise<void>
  }
  /** Device-code login (§6.1): works over SSH because the browser can be anywhere. */
  readonly auth: {
    start(): Promise<DeviceAuthStartResponse>
    poll(deviceCode: string): Promise<DevicePollResult>
  }
  connect(slug: string, options?: Omit<ConnectOptions, keyof ClientOptions>): Promise<Board>
  /**
   * A board that is not open yet. `board.open()` fills `board.state` from the
   * cache synchronously, before its first network call, so a UI can paint
   * cached data at once and patch it as the server answers (SPEC.md §8.1).
   */
  board(slug: string, options?: Omit<ConnectOptions, keyof ClientOptions>): Board
}

export function createClient(options: ClientOptions = {}): YuzieClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const fetch = options.fetch ?? defaultFetch()
  const http = createHttp({
    baseUrl,
    fetch,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
  })

  return {
    http,

    async health() {
      // `/healthz` lives beside the versioned API, not under it.
      const origin = baseUrl.replace(/\/+$/, '').replace(/\/v\d+$/, '')
      const started = Date.now()
      let response: Awaited<ReturnType<FetchLike>>
      try {
        response = await fetch(`${origin}/healthz`, { method: 'GET', headers: {} })
      } catch (cause) {
        throw new OfflineError('offline_network_required', `Cannot reach ${origin}`, {
          status: 0,
          cause,
        })
      }
      const latencyMs = Date.now() - started
      const body = HealthSchema.safeParse(JSON.parse((await response.text()) || '{}'))
      if (!response.ok || !body.success) {
        throw new InternalError('internal', `${origin}/healthz answered ${response.status}`, {
          status: response.status,
        })
      }
      return { version: body.data.version, latencyMs }
    },

    me: () => http.request({ method: 'GET', path: '/me', schema: MeResponseSchema }),

    boards: {
      async list() {
        const response = await http.request({
          method: 'GET',
          path: '/boards',
          schema: BoardListResponseSchema,
        })
        return response.boards
      },
      create: (board) =>
        http.request({
          method: 'POST',
          path: '/boards',
          body: board,
          idempotencyKey: newId(),
          schema: BoardSchema,
        }),
    },

    tokens: {
      async list() {
        const response = await http.request({
          method: 'GET',
          path: '/tokens',
          schema: TokenListResponseSchema,
        })
        return response.tokens
      },
      create: (token) =>
        http.request({
          method: 'POST',
          path: '/tokens',
          body: token,
          idempotencyKey: newId(),
          schema: TokenCreateResponseSchema,
        }),
      async revoke(id) {
        await http.request({
          method: 'DELETE',
          path: `/tokens/${encodeURIComponent(id)}`,
          schema: z.unknown(),
        })
      },
      async revokeCurrent() {
        await http.request({ method: 'DELETE', path: '/tokens/current', schema: z.unknown() })
      },
    },

    auth: {
      start: () =>
        http.request({
          method: 'POST',
          path: '/auth/device',
          schema: DeviceAuthStartResponseSchema,
        }),
      async poll(deviceCode) {
        try {
          const token = await http.request({
            method: 'POST',
            path: '/auth/device/token',
            body: { deviceCode },
            schema: DeviceTokenResponseSchema,
          })
          return { token, pending: false }
        } catch (error) {
          // 428 with `details.pending` means "not approved yet", not a failure.
          if (
            error instanceof AuthenticationError &&
            error.status === 428 &&
            error.details.pending === true
          ) {
            return { pending: true }
          }
          throw error
        }
      },
    },

    board(slug, connectOptions = {}) {
      const socket = connectOptions.webSocket ?? defaultWebSocket()
      return new Board({
        slug,
        http,
        offline: connectOptions.offline ?? 'fail',
        realtime: (connectOptions.realtime ?? true) && socket !== undefined,
        token: () => options.token,
        connectTimeoutMs: connectOptions.connectTimeoutMs ?? 10_000,
        ...(connectOptions.cache === undefined ? {} : { cache: connectOptions.cache }),
        ...(socket === undefined ? {} : { socket }),
        ...(options.client === undefined ? {} : { client: options.client }),
      })
    },

    async connect(slug, connectOptions = {}) {
      const board = this.board(slug, connectOptions)
      try {
        await board.open()
      } catch (error) {
        await board.close()
        throw error
      }
      return board
    },
  }
}

export const Yuzie = {
  /** Open a board: load cached state, fetch the server's, start streaming (§13.1). */
  connect(slug: string, options: ConnectOptions = {}): Promise<Board> {
    const { offline, cache, realtime, webSocket, connectTimeoutMs, ...clientOptions } = options
    return createClient(clientOptions).connect(slug, {
      ...(offline === undefined ? {} : { offline }),
      ...(cache === undefined ? {} : { cache }),
      ...(realtime === undefined ? {} : { realtime }),
      ...(webSocket === undefined ? {} : { webSocket }),
      ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    })
  },

  client(options: ClientOptions = {}): YuzieClient {
    return createClient(options)
  },
} as const
