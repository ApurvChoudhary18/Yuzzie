/**
 * The event catalogue (SPEC.md §12.3) as a discriminated union.
 *
 * Everything except presence is persisted, which is why `yuzie activity` and the
 * card Activity panel are projections over this union rather than a second audit
 * log. `seq` is strictly monotonic per board and is the entire basis of sync.
 */
import { z } from 'zod'
import {
  AnchorSchema,
  CardNumberSchema,
  CardSchema,
  ChecklistItemSchema,
  ColumnKeySchema,
  CommitSchema,
  GitSummarySchema,
  HandleSchema,
  IsoDateTimeSchema,
  PresenceSchema,
  PrioritySchema,
  RankSchema,
  RoleSchema,
  UuidSchema,
} from './schema.js'

export const EVENT_TYPES = [
  'card.created',
  'card.updated',
  'card.moved',
  'card.assigned',
  'card.deleted',
  'comment.created',
  'checklist.updated',
  'card.branch.linked',
  'card.git.updated',
  'card.commits.attached',
  'card.anchor.set',
  'member.joined',
  'member.left',
  'board.updated',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** The subset of a card that `card.updated` may carry (§12.3 "changed fields"). */
export const CardFieldsPayloadSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  priority: PrioritySchema.nullable().optional(),
  dueAt: IsoDateTimeSchema.nullable().optional(),
  labels: z.array(z.string().min(1)).optional(),
  watchers: z.array(HandleSchema).optional(),
  checklist: z.array(ChecklistItemSchema).optional(),
})

export const CardCreatedPayloadSchema = CardSchema
export const CardUpdatedPayloadSchema = z.object({
  fields: CardFieldsPayloadSchema,
  version: z.number().int().positive(),
})
export const CardMovedPayloadSchema = z.object({
  from: ColumnKeySchema,
  to: ColumnKeySchema,
  rank: RankSchema,
})
export const CardAssignedPayloadSchema = z.object({
  added: z.array(HandleSchema),
  removed: z.array(HandleSchema),
})
export const CardDeletedPayloadSchema = z.object({ number: CardNumberSchema })
export const CommentCreatedPayloadSchema = z.object({
  commentId: UuidSchema,
  body: z.string().min(1),
  author: HandleSchema,
})
export const ChecklistUpdatedPayloadSchema = z.object({
  itemId: UuidSchema,
  done: z.boolean(),
})
export const CardBranchLinkedPayloadSchema = z.object({
  branch: z.string().min(1),
  base: z.string().min(1).nullable(),
})
/**
 * §12.3 lists `{ commits, filesChanged, additions, deletions, pushed, prUrl }`.
 * `prState` and `lastActivityAt` are included for the same reason as the anchor
 * payload below: the server stores them, and an event that could not carry them
 * would leave every client that folds events disagreeing with a snapshot.
 */
export const CardGitUpdatedPayloadSchema = GitSummarySchema.pick({
  commits: true,
  filesChanged: true,
  additions: true,
  deletions: true,
  pushed: true,
  prUrl: true,
  prState: true,
  lastActivityAt: true,
}).partial()
/**
 * §12.3 lists `{ shas: [] }`. The full records ride along in `commits` so a
 * client folding the event keeps the message and commit time the server stored,
 * instead of inventing them; `shas` stays for compatibility.
 */
export const CardCommitsAttachedPayloadSchema = z.object({
  shas: z.array(CommitSchema.shape.sha).min(1),
  commits: z.array(CommitSchema).optional(),
})
/**
 * §12.3 lists `{ path, line }`; `endLine` and `commitSha` are included because
 * §9.7 requires an anchor to store a range and the sha it was taken at, and an
 * event that could not carry them would silently lose data on replay.
 */
export const CardAnchorSetPayloadSchema = AnchorSchema.pick({
  path: true,
  line: true,
}).extend({
  endLine: AnchorSchema.shape.endLine.optional(),
  commitSha: AnchorSchema.shape.commitSha.optional(),
})
export const MemberChangedPayloadSchema = z.object({
  handle: HandleSchema,
  role: RoleSchema,
})
export const BoardUpdatedPayloadSchema = z.object({
  fields: z.object({
    name: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    branchTemplate: z.string().min(1).optional(),
    repoRemote: z.string().nullable().optional(),
    archivedAt: IsoDateTimeSchema.nullable().optional(),
  }),
})

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

const envelopeBase = {
  id: UuidSchema.optional(),
  /** Strictly monotonic per board; the basis of replay and resume (§12.2). */
  seq: z.number().int().nonnegative(),
  /** Null for events the server originated itself. */
  actor: HandleSchema.nullable(),
  /** Echoed back so an optimistic client can drop its own write (§12.2). */
  idempotencyKey: z.string().min(1).optional(),
  /**
   * The card's version after this event. The server bumps a card's version on
   * every mutation, not only on `card.updated`, so without this a client folding
   * events would hold a stale version and its next `If-Match` would conflict
   * with a write that never touched the same fields.
   */
  version: z.number().int().positive().optional(),
  ts: IsoDateTimeSchema,
}

function cardEvent<TType extends EventType, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return z.object({ ...envelopeBase, type: z.literal(type), cardNo: CardNumberSchema, payload })
}

function boardEvent<TType extends EventType, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return z.object({
    ...envelopeBase,
    type: z.literal(type),
    cardNo: CardNumberSchema.optional(),
    payload,
  })
}

export const CardCreatedEventSchema = cardEvent('card.created', CardCreatedPayloadSchema)
export const CardUpdatedEventSchema = cardEvent('card.updated', CardUpdatedPayloadSchema)
export const CardMovedEventSchema = cardEvent('card.moved', CardMovedPayloadSchema)
export const CardAssignedEventSchema = cardEvent('card.assigned', CardAssignedPayloadSchema)
export const CardDeletedEventSchema = cardEvent('card.deleted', CardDeletedPayloadSchema)
export const CommentCreatedEventSchema = cardEvent('comment.created', CommentCreatedPayloadSchema)
export const ChecklistUpdatedEventSchema = cardEvent(
  'checklist.updated',
  ChecklistUpdatedPayloadSchema,
)
export const CardBranchLinkedEventSchema = cardEvent(
  'card.branch.linked',
  CardBranchLinkedPayloadSchema,
)
export const CardGitUpdatedEventSchema = cardEvent('card.git.updated', CardGitUpdatedPayloadSchema)
export const CardCommitsAttachedEventSchema = cardEvent(
  'card.commits.attached',
  CardCommitsAttachedPayloadSchema,
)
export const CardAnchorSetEventSchema = cardEvent('card.anchor.set', CardAnchorSetPayloadSchema)
export const MemberJoinedEventSchema = boardEvent('member.joined', MemberChangedPayloadSchema)
export const MemberLeftEventSchema = boardEvent('member.left', MemberChangedPayloadSchema)
export const BoardUpdatedEventSchema = boardEvent('board.updated', BoardUpdatedPayloadSchema)

export const EventEnvelopeSchema = z.discriminatedUnion('type', [
  CardCreatedEventSchema,
  CardUpdatedEventSchema,
  CardMovedEventSchema,
  CardAssignedEventSchema,
  CardDeletedEventSchema,
  CommentCreatedEventSchema,
  ChecklistUpdatedEventSchema,
  CardBranchLinkedEventSchema,
  CardGitUpdatedEventSchema,
  CardCommitsAttachedEventSchema,
  CardAnchorSetEventSchema,
  MemberJoinedEventSchema,
  MemberLeftEventSchema,
  BoardUpdatedEventSchema,
])

/** `{ seq, type, actor, cardNo?, payload, ts }` — SPEC.md §18 Session 1. */
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>

/** Narrow the union to one event type: `EventOf<'card.moved'>`. */
export type EventOf<TType extends EventType> = Extract<EventEnvelope, { type: TType }>

export type CardCreatedEvent = EventOf<'card.created'>
export type CardUpdatedEvent = EventOf<'card.updated'>
export type CardMovedEvent = EventOf<'card.moved'>
export type CardAssignedEvent = EventOf<'card.assigned'>
export type CardDeletedEvent = EventOf<'card.deleted'>
export type CommentCreatedEvent = EventOf<'comment.created'>
export type ChecklistUpdatedEvent = EventOf<'checklist.updated'>
export type CardBranchLinkedEvent = EventOf<'card.branch.linked'>
export type CardGitUpdatedEvent = EventOf<'card.git.updated'>
export type CardCommitsAttachedEvent = EventOf<'card.commits.attached'>
export type CardAnchorSetEvent = EventOf<'card.anchor.set'>
export type MemberJoinedEvent = EventOf<'member.joined'>
export type MemberLeftEvent = EventOf<'member.left'>
export type BoardUpdatedEvent = EventOf<'board.updated'>

export function parseEvent(value: unknown): EventEnvelope {
  return EventEnvelopeSchema.parse(value)
}

export function safeParseEvent(value: unknown): EventEnvelope | null {
  const result = EventEnvelopeSchema.safeParse(value)
  return result.success ? result.data : null
}

/** Ascending by `seq`; the total order every client agrees on. */
export function compareEvents(a: EventEnvelope, b: EventEnvelope): number {
  return a.seq - b.seq
}

// ---------------------------------------------------------------------------
// Transient presence frames (SPEC.md §12.2) — never written to the event log
// ---------------------------------------------------------------------------

export const PresenceFrameSchema = z.object({
  state: z.enum(['viewing', 'working', 'idle']),
  cardNo: CardNumberSchema.optional(),
  branch: z.string().min(1).optional(),
})
export type PresenceFrame = z.infer<typeof PresenceFrameSchema>

export const PresenceBroadcastSchema = z.object({
  users: z.array(PresenceSchema),
})
export type PresenceBroadcast = z.infer<typeof PresenceBroadcastSchema>

// ---------------------------------------------------------------------------
// `GET /boards/:slug/events?since=&limit=` (SPEC.md §12.1)
// ---------------------------------------------------------------------------

export const EventsReplayQuerySchema = z.object({
  since: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(500).optional(),
})
export type EventsReplayQuery = z.infer<typeof EventsReplayQuerySchema>

export const EventsReplayResponseSchema = z.object({
  events: z.array(EventEnvelopeSchema),
  /** The board's current head, so a client knows whether it is caught up. */
  seq: z.number().int().nonnegative(),
})
export type EventsReplayResponse = z.infer<typeof EventsReplayResponseSchema>
