/**
 * The realtime stream protocol (SPEC.md §12.2), defined once so the server's
 * gateway and the SDK's client parse exactly the same frames.
 *
 * Every frame is a JSON object discriminated by `t`. Persisted events travel as
 * `event` frames carrying the full §12.3 envelope; presence is transient and
 * never enters the event log.
 */
import { z } from 'zod'
import { type EventEnvelope, EventEnvelopeSchema, PresenceFrameSchema } from './events.js'
import {
  BoardSchema,
  CardSchema,
  ColumnSchema,
  LabelSchema,
  MemberSchema,
  PresenceSchema,
} from './schema.js'

/**
 * The WebSocket sub-protocol a client must offer. Bumped independently of the
 * package version whenever a frame changes incompatibly (SPEC.md §17).
 */
export const STREAM_PROTOCOL = 'yuzie.v1'

/**
 * Browsers cannot set an `Authorization` header on a WebSocket, so the token
 * rides as a second offered sub-protocol: `bearer.<token>`. The server never
 * selects it, so it is never echoed back.
 */
export const BEARER_PROTOCOL_PREFIX = 'bearer.'

/** The sub-protocols to offer for `token`, in the order the server expects. */
export function streamProtocols(token: string): [string, string] {
  return [STREAM_PROTOCOL, `${BEARER_PROTOCOL_PREFIX}${token}`]
}

/** Resume by replay up to this many missed events; beyond it, send a snapshot. */
export const REPLAY_LIMIT = 500

/** Clients ping this often; the server closes a connection silent for 45 s. */
export const HEARTBEAT_INTERVAL_MS = 20_000
export const HEARTBEAT_TIMEOUT_MS = 45_000
/** A presence entry lives this long after its connection was last heard from. */
export const PRESENCE_TTL_MS = 60_000

/**
 * Application close codes (4000–4999 are reserved for applications by RFC 6455).
 * A client should reconnect after any of these except `protocol_error`, which
 * means it is sending frames this server will never accept.
 */
export const STREAM_CLOSE_CODES = {
  /** Server shutting down; reconnect elsewhere. RFC 6455 "going away". */
  going_away: 1001,
  /** A frame was not valid JSON or not a §12.2 client frame. */
  protocol_error: 4000,
  /** No `hello` arrived in time after the upgrade. */
  hello_timeout: 4001,
  /** Nothing was heard from the client for {@link HEARTBEAT_TIMEOUT_MS}. */
  heartbeat_timeout: 4002,
  /** The client could not keep up even with a snapshot reset. */
  slow_consumer: 4003,
  /** The per-user connection limit for this board was reached (SPEC.md §14.1). */
  too_many_connections: 4029,
  /** The client sent frames faster than the message rate cap allows. */
  rate_limited: 4030,
} as const

export type StreamCloseReason = keyof typeof STREAM_CLOSE_CODES

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

export const HelloFrameSchema = z.object({
  t: z.literal('hello'),
  /**
   * The last `seq` this client has applied. Omitted by a client with no local
   * state, which always receives a snapshot.
   */
  lastSeq: z.number().int().nonnegative().optional(),
  client: z.string().min(1).max(64).optional(),
  caps: z.array(z.string().min(1).max(32)).max(16).optional(),
})

export const ClientPresenceFrameSchema = PresenceFrameSchema.extend({
  t: z.literal('presence'),
})

export const PingFrameSchema = z.object({ t: z.literal('ping') })

export const ClientFrameSchema = z.discriminatedUnion('t', [
  HelloFrameSchema,
  ClientPresenceFrameSchema,
  PingFrameSchema,
])

export type HelloFrame = z.infer<typeof HelloFrameSchema>
export type ClientPresenceFrame = z.infer<typeof ClientPresenceFrameSchema>
export type PingFrame = z.infer<typeof PingFrameSchema>
export type ClientFrame = z.infer<typeof ClientFrameSchema>

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

/** Everything a client needs to rebuild a board from nothing. */
export const BoardSnapshotSchema = z.object({
  board: BoardSchema,
  columns: z.array(ColumnSchema),
  labels: z.array(LabelSchema),
  members: z.array(MemberSchema),
  cards: z.array(CardSchema),
})
export type BoardSnapshot = z.infer<typeof BoardSnapshotSchema>

export const WelcomeFrameSchema = z.object({
  t: z.literal('welcome'),
  /**
   * The board's head when the stream was established. When `resumed` is true,
   * the events after the client's `lastSeq` up to this `seq` follow immediately.
   */
  seq: z.number().int().nonnegative(),
  presence: z.array(PresenceSchema),
  /** False when the client must discard its state and apply the snapshot that follows. */
  resumed: z.boolean(),
})

export const SnapshotFrameSchema = z.object({
  t: z.literal('snapshot'),
  /** The state is exactly the log folded up to and including this `seq`. */
  seq: z.number().int().nonnegative(),
  board: BoardSnapshotSchema,
})

export const ServerPresenceFrameSchema = z.object({
  t: z.literal('presence'),
  users: z.array(PresenceSchema),
})

export const PongFrameSchema = z.object({ t: z.literal('pong') })

export type WelcomeFrame = z.infer<typeof WelcomeFrameSchema>
export type SnapshotFrame = z.infer<typeof SnapshotFrameSchema>
/** An `event` frame is the §12.3 envelope with `t` alongside its fields. */
export type EventFrame = EventEnvelope & { t: 'event' }
export type ServerPresenceFrame = z.infer<typeof ServerPresenceFrameSchema>
export type PongFrame = z.infer<typeof PongFrameSchema>
export type ServerFrame =
  | WelcomeFrame
  | SnapshotFrame
  | EventFrame
  | ServerPresenceFrame
  | PongFrame

const NonEventServerFrameSchema = z.discriminatedUnion('t', [
  WelcomeFrameSchema,
  SnapshotFrameSchema,
  ServerPresenceFrameSchema,
  PongFrameSchema,
])

/** Parse a server frame, validating an `event` frame against the full catalogue. */
export function parseServerFrame(value: unknown): ServerFrame {
  if (typeof value === 'object' && value !== null && (value as { t?: unknown }).t === 'event') {
    const { t: _t, ...envelope } = value as Record<string, unknown>
    return { ...EventEnvelopeSchema.parse(envelope), t: 'event' }
  }
  return NonEventServerFrameSchema.parse(value)
}

export function parseClientFrame(value: unknown): ClientFrame {
  return ClientFrameSchema.parse(value)
}

/** Wrap a persisted event for the wire. */
export function eventFrame(event: EventEnvelope): EventFrame {
  return { t: 'event', ...event }
}
