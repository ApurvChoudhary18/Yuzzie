/**
 * The realtime layer (SPEC.md §12.2, §18 Session 5).
 *
 * Owns one WebSocket to `/boards/:slug/stream` and keeps it alive: `hello` with
 * the last applied `seq` on every (re)connect, a ping every 20 s, a watchdog
 * that treats 45 s of silence as a dead link, and reconnects with exponential
 * backoff and jitter (0.5 s → 1 → 2 → 4 → 8 s …, capped at 30 s).
 *
 * It does not interpret events; it validates frames against `@yuzie/core` and
 * hands them to the board, which owns state.
 */
import {
  type EventEnvelope,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  type Presence,
  parseServerFrame,
  type SnapshotFrame,
  STREAM_CLOSE_CODES,
  streamProtocols,
  type WelcomeFrame,
} from '@yuzie/core'
import { SOCKET_OPEN, type WebSocketFactory, type WebSocketLike } from './platform.js'

/**
 * - `connecting`: first attempt in progress.
 * - `live`: welcomed and streaming.
 * - `reconnecting`: the link dropped; retrying with backoff (§12.2: the UI shows
 *   `⚠ reconnecting…` from the first failure).
 * - `closed`: stopped by `close()` or by a protocol error that retrying cannot fix.
 */
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'closed'

export interface RealtimeCallbacks {
  /** The seq to resume from, or undefined to ask for a snapshot. */
  lastSeq(): number | undefined
  onWelcome(frame: WelcomeFrame): void
  onSnapshot(frame: SnapshotFrame): void
  onEvent(event: EventEnvelope): void
  onPresence(users: Presence[]): void
  onStatus(status: ConnectionStatus): void
  /** A frame the server sent that this client could not parse. */
  onProtocolError(error: Error): void
}

export interface RealtimeOptions {
  /** The REST base, e.g. `https://api.yuzie.dev/v1`; the scheme is switched to ws(s). */
  readonly baseUrl: string
  readonly slug: string
  readonly token: () => string | undefined
  readonly socket: WebSocketFactory
  readonly client?: string
  readonly random?: () => number
}

export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 30_000

/** The nth reconnect delay: 0.5 s doubling to 30 s, jittered ±20 %. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const nominal = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
  return Math.round(nominal * (0.8 + random() * 0.4))
}

export function streamUrl(baseUrl: string, slug: string): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/^http(s?):\/\//, 'ws$1://')
  return `${base}/boards/${encodeURIComponent(slug)}/stream`
}

export class RealtimeClient {
  private socket: WebSocketLike | null = null
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private current: ConnectionStatus = 'connecting'
  private stopped = false

  constructor(
    private readonly options: RealtimeOptions,
    private readonly callbacks: RealtimeCallbacks,
  ) {}

  get status(): ConnectionStatus {
    return this.current
  }

  start(): void {
    this.stopped = false
    this.open()
  }

  /** Send a presence frame if connected; presence is transient, so it is never queued. */
  sendPresence(frame: {
    state: 'viewing' | 'working' | 'idle'
    cardNo?: number
    branch?: string
  }): boolean {
    return this.send({ t: 'presence', ...frame })
  }

  close(): void {
    this.stopped = true
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      this.detach(socket)
      socket.close(1000, 'client closed')
    }
    this.setStatus('closed')
  }

  private open(): void {
    const token = this.options.token()
    if (token === undefined) {
      this.callbacks.onProtocolError(new Error('No token: the stream requires authentication'))
      this.setStatus('closed')
      return
    }

    let socket: WebSocketLike
    try {
      socket = this.options.socket(
        streamUrl(this.options.baseUrl, this.options.slug),
        streamProtocols(token),
      )
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      const lastSeq = this.callbacks.lastSeq()
      this.send({
        t: 'hello',
        ...(lastSeq === undefined ? {} : { lastSeq }),
        ...(this.options.client === undefined ? {} : { client: this.options.client }),
        caps: ['presence'],
      })
      this.pingTimer = setInterval(() => this.send({ t: 'ping' }), HEARTBEAT_INTERVAL_MS)
      this.feedWatchdog()
    }

    socket.onmessage = (message) => {
      this.feedWatchdog()
      this.handle(message.data)
    }

    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.clearTimers()
      if (this.stopped) return
      if (event.code === STREAM_CLOSE_CODES.protocol_error) {
        this.callbacks.onProtocolError(new Error(`Server rejected a frame: ${event.reason}`))
        this.setStatus('closed')
        return
      }
      this.scheduleReconnect()
    }

    socket.onerror = () => {
      // An open socket's error is followed by a close, where recovery happens.
      // A connection that failed to open may not be: Node's WebSocket reports a
      // refused connection with an error and no close, and waiting for one
      // would stop reconnecting for good (a restarted server never came back).
      if (this.socket !== socket || socket.readyState === SOCKET_OPEN) return
      this.detach(socket)
      this.socket = null
      this.clearTimers()
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      if (!this.stopped) this.scheduleReconnect()
    }
  }

  private handle(data: unknown): void {
    let frame: ReturnType<typeof parseServerFrame>
    try {
      frame = parseServerFrame(JSON.parse(String(data)))
    } catch (error) {
      this.callbacks.onProtocolError(error instanceof Error ? error : new Error(String(error)))
      return
    }

    switch (frame.t) {
      case 'welcome':
        this.attempt = 0
        this.callbacks.onWelcome(frame)
        this.callbacks.onPresence(frame.presence)
        this.setStatus('live')
        return
      case 'snapshot':
        this.callbacks.onSnapshot(frame)
        return
      case 'event': {
        const { t: _t, ...event } = frame
        this.callbacks.onEvent(event as EventEnvelope)
        return
      }
      case 'presence':
        this.callbacks.onPresence(frame.users)
        return
      case 'pong':
        return
    }
  }

  private send(frame: object): boolean {
    const socket = this.socket
    if (socket === null || socket.readyState !== SOCKET_OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  /** 45 s without any frame means the link is dead even if the socket has not noticed. */
  private feedWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => {
      const socket = this.socket
      this.socket = null
      this.clearTimers()
      if (socket !== null) {
        // Detach first: a dead peer may never complete the closing handshake,
        // and recovery must not wait for it.
        this.detach(socket)
        socket.close(4002, 'heartbeat timeout')
      }
      if (!this.stopped) this.scheduleReconnect()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return
    this.setStatus('reconnecting')
    const delay = reconnectDelayMs(this.attempt, this.options.random)
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.open()
    }, delay)
  }

  private detach(socket: WebSocketLike): void {
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer)
    if (this.watchdog !== null) clearTimeout(this.watchdog)
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.pingTimer = null
    this.watchdog = null
    this.reconnectTimer = null
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.current) return
    this.current = status
    this.callbacks.onStatus(status)
  }
}
