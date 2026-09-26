import type { EventEnvelope, Presence } from '@yuzie/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocketLike } from './platform.js'
import {
  type ConnectionStatus,
  type RealtimeCallbacks,
  RealtimeClient,
  reconnectDelayMs,
  streamUrl,
} from './realtime.js'

class FakeSocket implements WebSocketLike {
  readyState = 0
  protocol = ''
  sent: Array<Record<string, unknown>> = []
  closedWith: { code?: number; reason?: string } | null = null
  onopen: WebSocketLike['onopen'] = null
  onmessage: WebSocketLike['onmessage'] = null
  onclose: WebSocketLike['onclose'] = null
  onerror: WebSocketLike['onerror'] = null

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(code?: number, reason?: string): void {
    this.closedWith = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    }
    this.readyState = 3
  }

  // Server-side controls.
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  frame(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop(code = 1006, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

const EVENT: EventEnvelope = {
  seq: 5,
  type: 'card.moved',
  actor: 'priya',
  cardNo: 15,
  payload: { from: 'review', to: 'done', rank: 'a0m' },
  ts: '2026-08-19T09:20:11Z',
}

const RAHUL: Presence = {
  handle: 'rahul',
  kind: 'human',
  state: 'online',
  cardNo: null,
  branch: null,
  since: null,
}

/** `null` means a client with no state, which must ask for a snapshot. */
function harness(lastSeq: number | null = 4) {
  const sockets: FakeSocket[] = []
  const statuses: ConnectionStatus[] = []
  const events: EventEnvelope[] = []
  const presence: Presence[][] = []
  const errors: Error[] = []
  const callbacks: RealtimeCallbacks = {
    lastSeq: () => lastSeq ?? undefined,
    onWelcome: () => {},
    onSnapshot: () => {},
    onEvent: (event) => events.push(event),
    onPresence: (users) => presence.push(users),
    onStatus: (status) => statuses.push(status),
    onProtocolError: (error) => errors.push(error),
  }
  const client = new RealtimeClient(
    {
      baseUrl: 'https://api.example.test/v1',
      slug: 'payments-api',
      token: () => 'yz_token',
      client: 'test/1.0.0',
      random: () => 0.5,
      socket: (url, protocols) => {
        const socket = new FakeSocket(url, protocols)
        sockets.push(socket)
        return socket
      },
    },
    callbacks,
  )
  return { client, sockets, statuses, events, presence, errors }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('reconnectDelayMs', () => {
  it('follows 0.5 → 1 → 2 → 4 → 8 s and caps at 30 s (§12.2)', () => {
    const nominal = () => 0.5
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((attempt) => reconnectDelayMs(attempt, nominal))).toEqual([
      500, 1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ])
  })

  it('jitters by at most 20 % either way', () => {
    expect(reconnectDelayMs(2, () => 0)).toBe(1600)
    expect(reconnectDelayMs(2, () => 1)).toBe(2400)
  })
})

describe('streamUrl', () => {
  it('switches the scheme and appends the stream path', () => {
    expect(streamUrl('https://api.yuzie.dev/v1/', 'payments-api')).toBe(
      'wss://api.yuzie.dev/v1/boards/payments-api/stream',
    )
    expect(streamUrl('http://localhost:8787/v1', 'b')).toBe(
      'ws://localhost:8787/v1/boards/b/stream',
    )
  })
})

describe('RealtimeClient', () => {
  it('authenticates with the sub-protocols and says hello with the last seq', () => {
    const { client, sockets } = harness(4211)
    client.start()
    const socket = sockets[0] as FakeSocket
    expect(socket.url).toBe('wss://api.example.test/v1/boards/payments-api/stream')
    expect(socket.protocols).toEqual(['yuzie.v1', 'bearer.yz_token'])

    socket.open()
    expect(socket.sent[0]).toEqual({
      t: 'hello',
      lastSeq: 4211,
      client: 'test/1.0.0',
      caps: ['presence'],
    })
  })

  it('asks for a snapshot by leaving lastSeq out when it has no state', () => {
    const { client, sockets } = harness(null)
    client.start()
    sockets[0]?.open()
    expect(sockets[0]?.sent[0]).not.toHaveProperty('lastSeq')
  })

  it('goes live on welcome and passes events and presence through', () => {
    const { client, sockets, statuses, events, presence } = harness()
    client.start()
    const socket = sockets[0] as FakeSocket
    socket.open()
    socket.frame({ t: 'welcome', seq: 4, presence: [RAHUL], resumed: true })
    socket.frame({ t: 'event', ...EVENT })
    socket.frame({ t: 'presence', users: [] })

    expect(statuses).toEqual(['live'])
    expect(client.status).toBe('live')
    expect(events).toEqual([EVENT])
    expect(presence).toEqual([[RAHUL], []])
  })

  it('pings every 20 s', () => {
    const { client, sockets } = harness()
    client.start()
    const socket = sockets[0] as FakeSocket
    socket.open()
    socket.frame({ t: 'welcome', seq: 4, presence: [], resumed: true })
    vi.advanceTimersByTime(20_000)
    socket.frame({ t: 'pong' })
    vi.advanceTimersByTime(20_000)
    expect(socket.sent.filter((frame) => frame.t === 'ping')).toHaveLength(2)
  })

  it('reconnects with backoff after a drop, and resets the backoff once welcomed', () => {
    const { client, sockets, statuses } = harness()
    client.start()
    sockets[0]?.open()
    sockets[0]?.drop()
    expect(statuses).toEqual(['reconnecting'])

    vi.advanceTimersByTime(499)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)

    // The second attempt fails too: now it waits 1 s.
    sockets[1]?.drop()
    vi.advanceTimersByTime(999)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(3)

    sockets[2]?.open()
    sockets[2]?.frame({ t: 'welcome', seq: 4, presence: [], resumed: true })
    sockets[2]?.drop()
    vi.advanceTimersByTime(500)
    expect(sockets).toHaveLength(4)
    expect(statuses).toEqual(['reconnecting', 'live', 'reconnecting'])
  })

  it('keeps retrying when a refused connection reports an error and never a close', () => {
    // Node's WebSocket does this for ECONNREFUSED: a restarted server was never
    // reconnected to, because the retry waited for a close that did not come.
    const { client, sockets, statuses } = harness()
    client.start()
    sockets[0]?.open()
    sockets[0]?.drop(1001, 'Server shutting down')
    vi.advanceTimersByTime(500)
    expect(sockets).toHaveLength(2)

    sockets[1]?.onerror?.({})
    expect(sockets[1]?.closedWith).not.toBeNull()
    vi.advanceTimersByTime(1_000)
    expect(sockets).toHaveLength(3)

    // A late close from the abandoned socket changes nothing.
    sockets[1]?.drop()
    vi.advanceTimersByTime(10_000)
    expect(sockets).toHaveLength(3)

    sockets[2]?.open()
    sockets[2]?.frame({ t: 'welcome', seq: 4, presence: [], resumed: true })
    expect(statuses).toEqual(['reconnecting', 'live'])
  })

  it('ignores an error on an open socket: its close does the recovering', () => {
    const { client, sockets } = harness()
    client.start()
    sockets[0]?.open()
    sockets[0]?.onerror?.({})
    expect(sockets[0]?.closedWith).toBeNull()
    sockets[0]?.drop()
    vi.advanceTimersByTime(500)
    expect(sockets).toHaveLength(2)
  })

  it('treats 45 s of silence as a dead link, without waiting for the socket to notice', () => {
    const { client, sockets, statuses } = harness()
    client.start()
    const socket = sockets[0] as FakeSocket
    socket.open()
    socket.frame({ t: 'welcome', seq: 4, presence: [], resumed: true })

    vi.advanceTimersByTime(44_999)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(socket.closedWith?.code).toBe(4002)
    expect(statuses.at(-1)).toBe('reconnecting')
    vi.advanceTimersByTime(500)
    expect(sockets).toHaveLength(2)
  })

  it('stops for good on a protocol error, which retrying cannot fix', () => {
    const { client, sockets, statuses, errors } = harness()
    client.start()
    sockets[0]?.open()
    sockets[0]?.drop(4000, 'Not a yuzie.v1 client frame')
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
    expect(statuses).toEqual(['closed'])
    expect(errors[0]?.message).toMatch(/Not a yuzie.v1 client frame/)
  })

  it('reports a frame it cannot parse instead of throwing', () => {
    const { client, sockets, events, errors } = harness()
    client.start()
    sockets[0]?.open()
    sockets[0]?.onmessage?.({ data: 'not json' })
    sockets[0]?.frame({ t: 'event', type: 'card.moved', seq: 1 })
    expect(events).toEqual([])
    expect(errors).toHaveLength(2)
  })

  it('sends presence only while connected', () => {
    const { client, sockets } = harness()
    expect(client.sendPresence({ state: 'viewing', cardNo: 3 })).toBe(false)
    client.start()
    sockets[0]?.open()
    expect(client.sendPresence({ state: 'viewing', cardNo: 3 })).toBe(true)
    expect(sockets[0]?.sent.at(-1)).toEqual({ t: 'presence', state: 'viewing', cardNo: 3 })
  })

  it('closes cleanly and never reconnects after close()', () => {
    const { client, sockets, statuses } = harness()
    client.start()
    sockets[0]?.open()
    client.close()
    expect(sockets[0]?.closedWith).toEqual({ code: 1000, reason: 'client closed' })
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
    expect(statuses).toEqual(['closed'])
  })
})
