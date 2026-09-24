/**
 * The two platform capabilities the SDK needs, described structurally.
 *
 * Browsers and Node 22+ both provide `fetch` and `WebSocket` as globals. Typing
 * against these minimal shapes rather than the DOM or Node type libraries is
 * what keeps the core entry importable anywhere, and lets tests hand in fakes.
 */

export interface ResponseLike {
  readonly status: number
  readonly ok: boolean
  readonly headers: { get(name: string): string | null }
  text(): Promise<string>
}

export interface RequestInitLike {
  method: string
  headers: Record<string, string>
  body?: string
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>

/** The subset of the WHATWG `WebSocket` the realtime client uses. */
export interface WebSocketLike {
  readonly readyState: number
  readonly protocol: string
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike

/** `WebSocket.OPEN` — a constant, so no global is needed to name it. */
export const SOCKET_OPEN = 1

interface Globals {
  fetch?: FetchLike
  WebSocket?: new (url: string, protocols: string[]) => WebSocketLike
}

export function defaultFetch(): FetchLike {
  const fetch = (globalThis as Globals).fetch
  if (fetch === undefined) {
    throw new Error('No global fetch. Pass `fetch` in the Yuzie options on this platform.')
  }
  return fetch.bind(globalThis)
}

export function defaultWebSocket(): WebSocketFactory | undefined {
  const WebSocket = (globalThis as Globals).WebSocket
  if (WebSocket === undefined) return undefined
  return (url, protocols) => new WebSocket(url, protocols)
}
