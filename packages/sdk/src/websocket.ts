/**
 * `@yuzie/sdk/websocket` — a WebSocket for Node on the `ws` package (SPEC.md
 * §18 Session 16).
 *
 * Node's global `WebSocket` is undici's, and opening the first one loads undici
 * whole: a board kept open in the TUI carried 20–30 MB more for it than it
 * needed (enough to break §10.4's 120 MB budget on Node 24). `ws` is small,
 * pure JavaScript, and speaks the same `onopen`/`onmessage` interface the
 * realtime client uses. A separate entry, so a command that does not stream
 * never loads it.
 */
import WebSocket from 'ws'
import type { WebSocketFactory, WebSocketLike } from './platform.js'

export const nodeWebSocket: WebSocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as WebSocketLike
