/**
 * The realtime gateway: `GET /v1/boards/:slug/stream` (SPEC.md §12.2).
 *
 * The guarantees, and where each comes from:
 *
 *   - **Every event, once, in `seq` order.** Committed events reach each board's
 *     channel through {@link PubSub}. The channel keeps a `head` and delivers only
 *     `head + 1`: a duplicate is dropped, an early arrival waits, and a gap that
 *     does not close on its own is filled from the event log. A lost *final*
 *     event has no successor to reveal it, so each active board also checks its
 *     head against the log every few seconds. The broker can therefore reorder
 *     or lose messages and clients still receive everything.
 *   - **Resume without loss or repetition.** A connection syncs from a head
 *     captured synchronously and holds live events that arrive while it reads
 *     the log. Afterwards it is sent only events above what the sync covered —
 *     including ones the broker delivers late, after the connection is live. Up to 500 missed events are
 *     replayed; beyond that, or with no `lastSeq`, the client gets a snapshot
 *     read in one repeatable-read transaction.
 *   - **Bounded memory per client.** See `outbound.ts`. A client that cannot keep
 *     up has its backlog dropped and is reset with a snapshot once its socket
 *     drains; one that cannot drain even that is disconnected.
 *   - **Presence that expires.** Entries live 60 s past the last frame heard from
 *     their connection, whether or not the socket still looks open, and changes
 *     are broadcast at most every 200 ms per board.
 */
import { randomUUID } from 'node:crypto'
import {
  BEARER_PROTOCOL_PREFIX,
  boardError,
  ClientFrameSchema,
  type EventEnvelope,
  eventFrame,
  type Presence,
  PresenceSchema,
  type ServerFrame,
  STREAM_CLOSE_CODES,
  STREAM_PROTOCOL,
  type StreamCloseReason,
  type UserKind,
} from '@yuzie/core'
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import { authenticate, type BoardAccess, resolveBoard } from '../auth/context.js'
import type { ServerConfig } from '../config.js'
import type { Database } from '../db/client.js'
import type { Metrics } from '../http/metrics.js'
import type { EventBus } from '../services/event-bus.js'
import { loadEvents, loadSnapshot } from '../services/log.js'
import { currentSeq } from '../services/mutate.js'
import { OutboundQueue } from './outbound.js'
import { BoardPresence } from './presence.js'
import type { PubSub } from './pubsub.js'

/** How long an out-of-order event may wait for its predecessor before the log is read. */
const GAP_FILL_DELAY_MS = 100

export interface GatewayOptions {
  readonly config: ServerConfig
  readonly db: Database
  readonly metrics: Metrics
  readonly bus: EventBus
  readonly pubsub: PubSub
  readonly log: FastifyBaseLogger
  /** Identifies this node's presence to the others sharing the broker. */
  readonly nodeId?: string
  /** The clock for timeouts and presence expiry; injectable so tests can move it. */
  readonly now?: () => number
}

type Phase = 'awaiting_hello' | 'syncing' | 'live' | 'resetting'

interface HeldEvent {
  readonly seq: number
  readonly frame: string
}

interface Connection {
  readonly id: string
  readonly socket: WebSocket
  readonly channel: BoardChannel
  readonly userId: string
  readonly outbound: OutboundQueue
  readonly openedAt: number
  /** From `?since=`; a `lastSeq` in `hello` overrides it. */
  readonly urlSince: number | undefined
  phase: Phase
  /** Live events that arrived while syncing, released once the sync is sent. */
  held: HeldEvent[]
  heldOverflow: boolean
  /**
   * The `seq` this connection's last sync covered. A snapshot can include events
   * the broker has not delivered yet, so anything at or below this that arrives
   * later is already on the client and must not be sent again.
   */
  floor: number
  lastSeen: number
  resetStartedAt: number
  tokens: number
  tokensAt: number
  closed: boolean
}

interface BoardChannel {
  readonly boardId: string
  readonly topic: string
  readonly connections: Set<Connection>
  readonly presence: BoardPresence
  readonly pending: Map<number, EventEnvelope>
  /** The highest `seq` delivered; null until read from the log. */
  head: number | null
  ready: Promise<void>
  unsubscribe: (() => Promise<void>) | null
  gapTimer: NodeJS.Timeout | null
  broadcastTimer: NodeJS.Timeout | null
  lastBroadcastAt: number
  lastBroadcast: string
  localDirty: boolean
  lastPublishedLocal: string
  lastPublishedAt: number
  /** Real time of the last head check; see `wsHeadCheckMs`. */
  lastHeadCheck: number
  checkingHead: boolean
  closed: boolean
}

type BusMessage =
  | { readonly k: 'events'; readonly events: EventEnvelope[] }
  | { readonly k: 'presence'; readonly node: string; readonly users: Presence[] }
  /** A node that has just started listening to a board asks the others who is there. */
  | { readonly k: 'presence.sync'; readonly node: string }

export interface GatewayStats {
  readonly connections: number
  readonly channels: number
  /** The deepest any connection's outbound queue has been. */
  readonly maxQueueDepth: number
}

export interface Gateway {
  register(app: FastifyInstance): void
  /** Everyone present on a board, as far as this node knows. */
  presence(boardId: string): Presence[]
  stats(): GatewayStats
  /** Close every stream with 1001 and release the broker. */
  close(): Promise<void>
}

/** Read the bearer token from `Authorization`, or from the offered sub-protocols. */
export function upgradeAuthorization(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.length > 0) return header

  const offered = request.headers['sec-websocket-protocol']
  if (typeof offered !== 'string') return undefined
  for (const protocol of offered.split(',')) {
    const trimmed = protocol.trim()
    if (trimmed.startsWith(BEARER_PROTOCOL_PREFIX)) {
      return `Bearer ${trimmed.slice(BEARER_PROTOCOL_PREFIX.length)}`
    }
  }
  return undefined
}

/** `ws` option: select the versioned protocol, never the one carrying the token. */
export function selectProtocol(protocols: Set<string>): string | false {
  return protocols.has(STREAM_PROTOCOL) ? STREAM_PROTOCOL : false
}

function parseSince(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw boardError('validation_failed', '`since` must be a non-negative integer')
  }
  return Number.parseInt(value, 10)
}

export function createGateway(options: GatewayOptions): Gateway {
  const { config, db, metrics, pubsub, log } = options
  const nodeId = options.nodeId ?? randomUUID()
  const now = options.now ?? Date.now

  const channels = new Map<string, BoardChannel>()
  const connections = new Set<Connection>()
  const perUser = new Map<string, number>()
  const upgrades = new WeakMap<FastifyRequest, { access: BoardAccess; since?: number }>()
  let closing = false
  let peakQueueDepth = 0

  // Every committed event goes to the broker, including on a single node: one
  // path for everything means the multi-node path is the one being tested.
  const stopBus = options.bus.subscribe((boardId, events) => {
    const message: BusMessage = { k: 'events', events: [...events] }
    pubsub.publish(topicFor(boardId), JSON.stringify(message)).catch((error: unknown) => {
      log.error({ err: error, boardId }, 'realtime: publish failed; subscribers will gap-fill')
    })
  })

  const sweeper = setInterval(sweep, config.presenceSweepMs)
  sweeper.unref()

  function topicFor(boardId: string): string {
    return `yuzie:board:${boardId}`
  }

  // -------------------------------------------------------------------------
  // Channels: one per board with a local subscriber or local presence
  // -------------------------------------------------------------------------

  function channelFor(boardId: string): BoardChannel {
    const existing = channels.get(boardId)
    if (existing !== undefined) return existing

    const channel: BoardChannel = {
      boardId,
      topic: topicFor(boardId),
      connections: new Set(),
      presence: new BoardPresence(),
      pending: new Map(),
      head: null,
      ready: Promise.resolve(),
      unsubscribe: null,
      gapTimer: null,
      broadcastTimer: null,
      lastBroadcastAt: 0,
      lastBroadcast: '',
      localDirty: false,
      lastPublishedLocal: '[]',
      lastPublishedAt: 0,
      lastHeadCheck: Date.now(),
      checkingHead: false,
      closed: false,
    }
    channels.set(boardId, channel)

    channel.ready = (async () => {
      // Subscribe *before* reading the head: anything committed in between is
      // either at or below the head (and dropped) or above it (and delivered).
      const unsubscribe = await pubsub.subscribe(channel.topic, (raw) => onMessage(channel, raw))
      if (channel.closed) {
        await unsubscribe()
        return
      }
      channel.unsubscribe = unsubscribe
      // Presence announced before this node was listening would otherwise stay
      // invisible here until the next periodic refresh.
      const sync: BusMessage = { k: 'presence.sync', node: nodeId }
      await pubsub.publish(channel.topic, JSON.stringify(sync))
      channel.head = await currentSeq(db, boardId)
      flush(channel)
    })()
    channel.ready.catch((error: unknown) => {
      log.error({ err: error, boardId }, 'realtime: could not open board channel')
      // Let the next connection try again from scratch.
      if (channels.get(boardId) === channel) channels.delete(boardId)
    })
    return channel
  }

  function onMessage(channel: BoardChannel, raw: string): void {
    let message: BusMessage
    try {
      message = JSON.parse(raw) as BusMessage
    } catch {
      log.warn({ boardId: channel.boardId }, 'realtime: unparseable broker message')
      return
    }

    if (message.k === 'events') {
      receive(channel, message.events)
    } else if (message.k === 'presence' && message.node !== nodeId) {
      const users = PresenceSchema.array().safeParse(message.users)
      if (!users.success) return
      channel.presence.setRemote(message.node, users.data, now())
      scheduleBroadcast(channel, false)
    } else if (message.k === 'presence.sync' && message.node !== nodeId) {
      if (channel.presence.localSize > 0) publishLocalPresence(channel, true)
    }
  }

  function receive(channel: BoardChannel, events: readonly EventEnvelope[]): void {
    for (const event of events) {
      if (channel.head !== null && event.seq <= channel.head) continue
      channel.pending.set(event.seq, event)
    }
    flush(channel)
  }

  function flush(channel: BoardChannel): void {
    if (channel.head === null) return
    for (const seq of channel.pending.keys()) {
      if (seq <= channel.head) channel.pending.delete(seq)
    }
    let next = channel.pending.get(channel.head + 1)
    while (next !== undefined) {
      channel.pending.delete(next.seq)
      channel.head = next.seq
      deliver(channel, next)
      next = channel.pending.get(channel.head + 1)
    }

    if (channel.pending.size === 0) {
      if (channel.gapTimer !== null) clearTimeout(channel.gapTimer)
      channel.gapTimer = null
    } else if (channel.gapTimer === null) {
      channel.gapTimer = setTimeout(() => void fillGap(channel), GAP_FILL_DELAY_MS)
    }
  }

  async function fillGap(channel: BoardChannel): Promise<void> {
    channel.gapTimer = null
    if (channel.closed || channel.head === null || channel.pending.size === 0) return

    const since = channel.head
    const upTo = Math.max(...channel.pending.keys())
    let loaded: EventEnvelope[]
    try {
      loaded = await loadEvents(db, channel.boardId, { since, until: upTo })
    } catch (error) {
      log.error({ err: error, boardId: channel.boardId }, 'realtime: gap fill failed')
      // `flush` re-arms the timer while anything is still pending.
      flush(channel)
      return
    }
    // Any gap that opened while the log was being read is a new one, and
    // `receive` -> `flush` arms a fresh timer for it.
    receive(channel, loaded)

    // A hole in the log itself — a seq in the range just read that the log does
    // not have — should be impossible, because seq is allocated under the board
    // lock and events are published only after commit. If it happens anyway, do
    // not stall the board forever behind it: step over that seq alone, and let
    // clients notice the gap and replay over REST (§12.2).
    const present = new Set(loaded.map((event) => event.seq))
    for (let seq = since + 1; seq <= upTo; seq += 1) {
      if (present.has(seq) || channel.head === null || seq <= channel.head) continue
      if (channel.head !== seq - 1) break
      log.warn({ boardId: channel.boardId, seq }, 'realtime: event missing from the log; skipping')
      channel.head = seq
      flush(channel)
    }
  }

  /** Deliver anything committed that the broker never brought us. */
  async function catchUp(channel: BoardChannel): Promise<void> {
    channel.checkingHead = true
    channel.lastHeadCheck = Date.now()
    try {
      const logHead = await currentSeq(db, channel.boardId)
      if (channel.head !== null && logHead > channel.head) {
        receive(
          channel,
          await loadEvents(db, channel.boardId, { since: channel.head, until: logHead }),
        )
      }
    } catch (error) {
      log.warn({ err: error, boardId: channel.boardId }, 'realtime: head check failed')
    } finally {
      channel.checkingHead = false
    }
  }

  function deliver(channel: BoardChannel, event: EventEnvelope): void {
    const frame = JSON.stringify(eventFrame(event))
    const lag = (Date.now() - Date.parse(event.ts)) / 1000
    for (const connection of channel.connections) {
      if (connection.phase === 'live') {
        if (event.seq <= connection.floor) continue
        metrics.eventLag.observe(Math.max(0, lag))
        send(connection, frame)
      } else if (connection.phase === 'syncing') {
        if (connection.held.length >= config.wsOutboundQueueLimit) connection.heldOverflow = true
        else connection.held.push({ seq: event.seq, frame })
      }
      // awaiting_hello and resetting ignore live events: the sync they are about
      // to run reads from a head at or past this one.
    }
  }

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------

  function scheduleBroadcast(channel: BoardChannel, localChanged: boolean): void {
    if (localChanged) channel.localDirty = true
    if (channel.broadcastTimer !== null || channel.closed) return
    const wait = Math.max(
      0,
      channel.lastBroadcastAt + config.presenceBroadcastIntervalMs - Date.now(),
    )
    channel.broadcastTimer = setTimeout(() => broadcastPresence(channel), wait)
  }

  function broadcastPresence(channel: BoardChannel): void {
    channel.broadcastTimer = null
    channel.lastBroadcastAt = Date.now()

    const frame = JSON.stringify({ t: 'presence', users: channel.presence.users() })
    if (frame !== channel.lastBroadcast) {
      channel.lastBroadcast = frame
      for (const connection of channel.connections) {
        if (connection.phase === 'live') send(connection, frame)
      }
    }

    if (channel.localDirty) {
      channel.localDirty = false
      publishLocalPresence(channel, false)
    }
  }

  function publishLocalPresence(channel: BoardChannel, force: boolean): void {
    const users = channel.presence.localUsers()
    const serialized = JSON.stringify(users)
    if (!force && serialized === channel.lastPublishedLocal) return
    channel.lastPublishedLocal = serialized
    channel.lastPublishedAt = now()
    const message: BusMessage = { k: 'presence', node: nodeId, users }
    pubsub.publish(channel.topic, JSON.stringify(message)).catch((error: unknown) => {
      log.warn({ err: error }, 'realtime: presence publish failed')
    })
  }

  // -------------------------------------------------------------------------
  // Timeouts, expiry, and tidying up — all against the injectable clock
  // -------------------------------------------------------------------------

  function sweep(): void {
    const at = now()

    for (const connection of connections) {
      if (
        connection.phase === 'awaiting_hello' &&
        at - connection.openedAt >= config.wsHelloTimeoutMs
      ) {
        disconnect(connection, 'hello_timeout', 'No hello received')
      } else if (at - connection.lastSeen >= config.wsHeartbeatTimeoutMs) {
        disconnect(connection, 'heartbeat_timeout', 'No heartbeat')
      } else if (
        connection.phase === 'resetting' &&
        at - connection.resetStartedAt >= config.wsResetTimeoutMs
      ) {
        disconnect(connection, 'slow_consumer', 'Could not keep up')
      }
    }

    for (const channel of channels.values()) {
      if (channel.presence.expire(at, config.presenceTtlMs)) scheduleBroadcast(channel, true)

      if (
        channel.connections.size > 0 &&
        channel.head !== null &&
        !channel.checkingHead &&
        channel.gapTimer === null &&
        Date.now() - channel.lastHeadCheck >= config.wsHeadCheckMs
      ) {
        void catchUp(channel)
      }

      // Other nodes drop a list they have not heard refreshed within the TTL,
      // so refresh well inside it.
      if (
        channel.presence.localSize > 0 &&
        at - channel.lastPublishedAt >= config.presenceTtlMs / 3
      ) {
        publishLocalPresence(channel, true)
      }

      if (
        channel.connections.size === 0 &&
        channel.presence.localSize === 0 &&
        channel.broadcastTimer === null
      ) {
        void closeChannel(channel)
      }
    }
  }

  async function closeChannel(channel: BoardChannel): Promise<void> {
    channel.closed = true
    channels.delete(channel.boardId)
    if (channel.gapTimer !== null) clearTimeout(channel.gapTimer)
    if (channel.broadcastTimer !== null) clearTimeout(channel.broadcastTimer)
    // Tell the other nodes this one no longer has anybody here.
    if (channel.lastPublishedLocal !== '[]') publishLocalPresence(channel, false)
    try {
      await channel.unsubscribe?.()
    } catch (error) {
      log.warn({ err: error }, 'realtime: unsubscribe failed')
    }
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  function send(connection: Connection, frame: string): void {
    if (connection.closed) return
    if (connection.outbound.enqueue(frame) === 'overflow') startReset(connection)
  }

  function sendFrame(connection: Connection, frame: ServerFrame): void {
    send(connection, JSON.stringify(frame))
  }

  function startReset(connection: Connection): void {
    if (connection.phase === 'resetting' || connection.closed) return
    connection.phase = 'resetting'
    connection.resetStartedAt = now()
    connection.held = []
    metrics.wsResets.inc()
    log.info({ connection: connection.id }, 'realtime: slow consumer, resetting with a snapshot')

    void connection.outbound.drained().then(() => {
      if (!connection.closed) void runSync(connection, undefined, true)
    })
  }

  async function runSync(
    connection: Connection,
    lastSeq: number | undefined,
    reset: boolean,
  ): Promise<void> {
    try {
      await sync(connection, lastSeq, reset)
    } catch (error) {
      log.error({ err: error, connection: connection.id }, 'realtime: sync failed')
      if (!connection.closed) {
        connection.socket.close(1011, 'Sync failed')
        onClosed(connection, 1011)
      }
    }
  }

  async function sync(
    connection: Connection,
    lastSeq: number | undefined,
    reset: boolean,
  ): Promise<void> {
    const { channel } = connection
    connection.phase = 'syncing'
    connection.held = []
    connection.heldOverflow = false

    await channel.ready
    if (connection.closed) return
    // Captured synchronously: every event after this reaches `held`.
    const head = channel.head ?? 0

    let after: number
    if (
      !reset &&
      lastSeq !== undefined &&
      lastSeq <= head &&
      head - lastSeq <= config.wsReplayLimit
    ) {
      const missed =
        lastSeq === head
          ? []
          : await loadEvents(db, channel.boardId, { since: lastSeq, until: head })
      if (connection.closed) return
      after = head
      sendFrame(connection, {
        t: 'welcome',
        seq: head,
        presence: channel.presence.users(),
        resumed: true,
      })
      for (const event of missed) send(connection, JSON.stringify(eventFrame(event)))
    } else {
      const snapshot = await loadSnapshot(db, channel.boardId)
      if (connection.closed) return
      after = snapshot.seq
      if (!reset) {
        sendFrame(connection, {
          t: 'welcome',
          seq: snapshot.seq,
          presence: channel.presence.users(),
          resumed: false,
        })
      }
      sendFrame(connection, { t: 'snapshot', seq: snapshot.seq, board: snapshot.board })
      if (reset) sendFrame(connection, { t: 'presence', users: channel.presence.users() })
    }

    // The frames above may themselves have overflowed a tiny queue.
    if (connection.phase !== 'syncing') return

    const held = connection.held
    const overflowed = connection.heldOverflow
    connection.held = []
    connection.heldOverflow = false
    connection.floor = after
    connection.phase = 'live'

    if (overflowed) {
      startReset(connection)
      return
    }
    for (const event of held) {
      if (event.seq > after) send(connection, event.frame)
    }
  }

  function disconnect(connection: Connection, reason: StreamCloseReason, message: string): void {
    if (connection.closed) return
    connection.socket.close(STREAM_CLOSE_CODES[reason], message)
    // A peer that has gone silent will never complete the closing handshake;
    // do not let it hold a connection slot until `ws` gives up on it.
    const kill = setTimeout(() => connection.socket.terminate(), 5_000)
    kill.unref()
    onClosed(connection, STREAM_CLOSE_CODES[reason])
  }

  function onClosed(connection: Connection, code: number): void {
    if (connection.closed) return
    connection.closed = true
    peakQueueDepth = Math.max(peakQueueDepth, connection.outbound.maxDepth)
    connection.outbound.close()
    connections.delete(connection)
    connection.channel.connections.delete(connection)
    metrics.wsConnections.dec()

    const key = `${connection.channel.boardId}:${connection.userId}`
    const remaining = (perUser.get(key) ?? 1) - 1
    if (remaining <= 0) perUser.delete(key)
    else perUser.set(key, remaining)

    // A deliberate goodbye takes the user off the board now. Anything else — a
    // dropped network, a timeout — leaves presence to expire on its TTL, which
    // is what stops a flaky connection from making someone flicker.
    if (code === 1000 || code === 1001) {
      if (connection.channel.presence.leave(connection.id)) {
        scheduleBroadcast(connection.channel, true)
      }
    }
  }

  function onFrame(connection: Connection, data: unknown, isBinary: boolean): void {
    if (connection.closed) return
    const at = now()

    // §14.1 message rate cap: a token bucket per connection.
    connection.tokens = Math.min(
      config.wsMessageBurst,
      connection.tokens + ((at - connection.tokensAt) / 1000) * config.wsMessagesPerSecond,
    )
    connection.tokensAt = at
    if (connection.tokens < 1) {
      disconnect(connection, 'rate_limited', 'Too many messages')
      return
    }
    connection.tokens -= 1

    connection.lastSeen = at
    connection.channel.presence.touch(connection.id, at)

    if (isBinary) {
      disconnect(connection, 'protocol_error', 'Frames are JSON text')
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(String(data))
    } catch {
      disconnect(connection, 'protocol_error', 'Frame is not valid JSON')
      return
    }
    const result = ClientFrameSchema.safeParse(parsed)
    if (!result.success) {
      disconnect(connection, 'protocol_error', 'Not a yuzie.v1 client frame')
      return
    }

    const frame = result.data
    switch (frame.t) {
      case 'hello':
        if (connection.phase !== 'awaiting_hello') {
          disconnect(connection, 'protocol_error', 'hello may only be sent once')
          return
        }
        void runSync(connection, frame.lastSeq ?? connection.urlSince, false)
        return
      case 'ping':
        sendFrame(connection, { t: 'pong' })
        return
      case 'presence':
        if (connection.channel.presence.update(connection.id, frame, at)) {
          scheduleBroadcast(connection.channel, true)
        }
        return
    }
  }

  function accept(socket: WebSocket, request: FastifyRequest): void {
    const upgrade = upgrades.get(request)
    upgrades.delete(request)
    if (upgrade === undefined || closing) {
      socket.close(STREAM_CLOSE_CODES.going_away, 'Unavailable')
      return
    }

    const { access } = upgrade
    // Counted per node. Behind a load balancer a user could hold two on each
    // node; sticky sessions or a Redis counter would close that, if it matters.
    const key = `${access.board.id}:${access.user.id}`
    const open = perUser.get(key) ?? 0
    if (open >= config.wsMaxConnectionsPerUser) {
      socket.close(
        STREAM_CLOSE_CODES.too_many_connections,
        `At most ${config.wsMaxConnectionsPerUser} connections per user per board`,
      )
      return
    }
    perUser.set(key, open + 1)

    const at = now()
    const channel = channelFor(access.board.id)
    const connection: Connection = {
      id: randomUUID(),
      socket,
      channel,
      userId: access.user.id,
      outbound: new OutboundQueue(
        { send: (data, callback) => socket.send(data, callback) },
        {
          maxQueuedFrames: config.wsOutboundQueueLimit,
          maxInflightBytes: config.wsMaxInflightBytes,
        },
      ),
      openedAt: at,
      urlSince: upgrade.since,
      phase: 'awaiting_hello',
      held: [],
      heldOverflow: false,
      floor: 0,
      lastSeen: at,
      resetStartedAt: 0,
      tokens: config.wsMessageBurst,
      tokensAt: at,
      closed: false,
    }

    connections.add(connection)
    channel.connections.add(connection)
    metrics.wsConnections.inc()

    channel.presence.join(
      connection.id,
      { handle: access.user.handle, kind: access.user.kind as UserKind },
      at,
    )
    scheduleBroadcast(channel, true)

    socket.on('message', (data, isBinary) => onFrame(connection, data, isBinary))
    socket.on('close', (code) => onClosed(connection, code))
  }

  return {
    register(app) {
      app.route<{ Params: { slug: string }; Querystring: { since?: string } }>({
        method: 'GET',
        url: '/boards/:slug/stream',
        // Auth on upgrade: a bad token is an HTTP 401 and a board the caller
        // cannot see is a 404, both before any WebSocket exists.
        preValidation: async (request) => {
          const auth = await authenticate(db, upgradeAuthorization(request))
          const access = await resolveBoard(db, auth, request.params.slug)
          const since = parseSince(request.query.since)
          upgrades.set(request, { access, ...(since === undefined ? {} : { since }) })
        },
        handler: async () => {
          throw boardError(
            'validation_failed',
            'This endpoint is a WebSocket stream; connect with an Upgrade request.',
            { status: 426 },
          )
        },
        wsHandler: (socket, request) => accept(socket, request),
      })
    },

    presence(boardId) {
      return channels.get(boardId)?.presence.users() ?? []
    },

    stats() {
      let maxQueueDepth = peakQueueDepth
      for (const connection of connections) {
        maxQueueDepth = Math.max(maxQueueDepth, connection.outbound.maxDepth)
      }
      return { connections: connections.size, channels: channels.size, maxQueueDepth }
    },

    async close() {
      closing = true
      clearInterval(sweeper)
      stopBus()
      for (const connection of [...connections]) {
        disconnect(connection, 'going_away', 'Server shutting down')
      }
      await Promise.all([...channels.values()].map((channel) => closeChannel(channel)))
    },
  }
}
