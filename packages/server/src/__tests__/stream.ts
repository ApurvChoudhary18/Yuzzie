/**
 * A scripted WebSocket client for the realtime suites (SPEC.md §16: "vitest + ws
 * harness"). It talks to a real server on a real port; nothing is injected.
 */
import {
  type EventFrame,
  parseServerFrame,
  type ServerFrame,
  type ServerPresenceFrame,
  type SnapshotFrame,
  STREAM_PROTOCOL,
  streamProtocols,
  type WelcomeFrame,
} from '@yuzie/core'
import { WebSocket } from 'ws'
import type { TestServer } from './harness.js'

/** Bind the server to an ephemeral port and return its `ws://` base. */
export async function listen(server: TestServer): Promise<string> {
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 })
  return address.replace(/^http/, 'ws')
}

export function httpBase(wsBase: string): string {
  return wsBase.replace(/^ws/, 'http')
}

export interface ConnectOptions {
  /** `?since=` on the URL. */
  readonly since?: number
  /** Authenticate with the `Authorization` header instead of the sub-protocol. */
  readonly viaHeader?: boolean
}

export interface Closed {
  readonly code: number
  readonly reason: string
}

export class StreamClient {
  readonly frames: ServerFrame[] = []
  closed: Closed | null = null
  private waiters: Array<() => void> = []

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.frames.push(parseServerFrame(JSON.parse(String(data))))
      this.wake()
    })
    socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() }
      this.wake()
    })
    // Errors surface as a close; without a listener they would crash the run.
    socket.on('error', () => {})
  }

  static connect(
    base: string,
    slug: string,
    token: string,
    options: ConnectOptions = {},
  ): Promise<StreamClient> {
    const query = options.since === undefined ? '' : `?since=${options.since}`
    const url = `${base}/v1/boards/${slug}/stream${query}`
    const socket = options.viaHeader
      ? new WebSocket(url, STREAM_PROTOCOL, { headers: { authorization: `Bearer ${token}` } })
      : new WebSocket(url, streamProtocols(token))

    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(new StreamClient(socket)))
      socket.once('error', reject)
    })
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame))
  }

  hello(lastSeq?: number): void {
    this.send({ t: 'hello', client: 'test/0.0.0', ...(lastSeq === undefined ? {} : { lastSeq }) })
  }

  get events(): EventFrame[] {
    return this.frames.filter((frame): frame is EventFrame => frame.t === 'event')
  }

  get seqs(): number[] {
    return this.events.map((event) => event.seq)
  }

  get welcome(): WelcomeFrame | undefined {
    return this.frames.find((frame): frame is WelcomeFrame => frame.t === 'welcome')
  }

  get snapshots(): SnapshotFrame[] {
    return this.frames.filter((frame): frame is SnapshotFrame => frame.t === 'snapshot')
  }

  get presenceFrames(): ServerPresenceFrame[] {
    return this.frames.filter((frame): frame is ServerPresenceFrame => frame.t === 'presence')
  }

  /** The most recent presence list: from the last presence frame, else the welcome. */
  get present(): string[] {
    const last = this.presenceFrames.at(-1)?.users ?? this.welcome?.presence ?? []
    return last.map((user) => user.handle)
  }

  /** Resolve once `predicate` holds, re-checked on every frame and on close. */
  async until(predicate: () => boolean, timeoutMs = 5_000, what = 'condition'): Promise<void> {
    if (predicate()) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== check)
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`))
      }, timeoutMs)
      const check = () => {
        if (!predicate()) return
        clearTimeout(timer)
        this.waiters = this.waiters.filter((waiter) => waiter !== check)
        resolve()
      }
      this.waiters.push(check)
    })
  }

  /** Say hello and wait for the stream to be established. */
  async ready(lastSeq?: number): Promise<WelcomeFrame> {
    this.hello(lastSeq)
    await this.until(() => this.welcome !== undefined, 5_000, 'welcome')
    return this.welcome as WelcomeFrame
  }

  async waitForSeq(seq: number, timeoutMs = 5_000): Promise<void> {
    await this.until(
      () => this.events.some((event) => event.seq >= seq),
      timeoutMs,
      `event seq ${seq}`,
    )
  }

  async waitForClose(timeoutMs = 5_000): Promise<Closed> {
    await this.until(() => this.closed !== null, timeoutMs, 'close')
    return this.closed as Closed
  }

  close(): Promise<Closed> {
    this.socket.close(1000, 'bye')
    return this.waitForClose()
  }

  /** Drop the TCP connection with no closing handshake, as a crash would. */
  terminate(): void {
    this.socket.terminate()
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter()
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Assert-friendly: consecutive integers from `from` to `to`, inclusive. */
export function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index)
}
