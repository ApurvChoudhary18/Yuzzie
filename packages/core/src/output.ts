/**
 * Every `--json` document the CLI prints (SPEC.md §7.3), as a schema.
 *
 * `{ apiVersion, kind, data, meta }`, where `kind` names what `data` is. The
 * envelope is the stable contract scripts rely on; a change to any of these is
 * a breaking change and needs an `apiVersion` bump.
 */
import { z } from 'zod'
import { EventEnvelopeSchema } from './events.js'
import {
  ApiTokenSchema,
  BoardListEnvelopeSchema,
  BoardSchema,
  CardEnvelopeSchema,
  CardListEnvelopeSchema,
  CardNumberSchema,
  CardSchema,
  ChecklistItemSchema,
  ColumnSchema,
  CommentSchema,
  CommitSchema,
  HandleSchema,
  jsonEnvelopeSchema,
  MemberListEnvelopeSchema,
  PresenceEnvelopeSchema,
  RoleSchema,
  SlugSchema,
  TokenCreateResponseSchema,
} from './schema.js'

export const BoardEnvelopeSchema = jsonEnvelopeSchema('Board', BoardSchema)
export const ColumnListEnvelopeSchema = jsonEnvelopeSchema('ColumnList', z.array(ColumnSchema))
export const ColumnEnvelopeSchema = jsonEnvelopeSchema('Column', ColumnSchema)
export const CommentEnvelopeSchema = jsonEnvelopeSchema('Comment', CommentSchema)
export const ChecklistItemEnvelopeSchema = jsonEnvelopeSchema('ChecklistItem', ChecklistItemSchema)
export const EventListEnvelopeSchema = jsonEnvelopeSchema('EventList', z.array(EventEnvelopeSchema))
/** One line of `yuzie feed --json`: newline-delimited, one event per document. */
export const EventOutputEnvelopeSchema = jsonEnvelopeSchema('Event', EventEnvelopeSchema)

export const DeletedEnvelopeSchema = jsonEnvelopeSchema(
  'Deleted',
  z.object({
    kind: z.enum(['card', 'column', 'board']),
    id: z.union([CardNumberSchema, z.string().min(1)]),
  }),
)
export const InviteEnvelopeSchema = jsonEnvelopeSchema(
  'Invite',
  z.object({ handle: HandleSchema, role: RoleSchema, boardSlug: SlugSchema }),
)
/** `yuzie share`: what a teammate needs to join this board. */
export const ShareEnvelopeSchema = jsonEnvelopeSchema(
  'Share',
  z.object({
    boardSlug: SlugSchema,
    server: z.url(),
    /** The repository to clone, whose committed `.yuzie/config.json` names the board. */
    repo: z.string().min(1).nullable(),
    /** The commands a teammate runs, in order. */
    steps: z.array(z.string().min(1)).min(1),
  }),
)
const BranchActionSchema = z.enum(['created', 'checked-out', 'tracked', 'current'])

/** `yuzie claim` and `yuzie start` (§9.3). */
export const ClaimEnvelopeSchema = jsonEnvelopeSchema(
  'Claim',
  z.object({
    card: CardSchema,
    /** The branch now checked out for the card, or null when none was touched. */
    branch: z.string().min(1).nullable(),
    branchAction: BranchActionSchema.nullable(),
    /** Stashed first, because the tree was dirty. */
    stashed: z.boolean(),
    /** Some writes are waiting in the outbox for the server. */
    queued: z.boolean(),
  }),
)

/** `yuzie branch` (§9.1). */
export const BranchEnvelopeSchema = jsonEnvelopeSchema(
  'Branch',
  z.object({
    number: CardNumberSchema,
    branch: z.string().min(1),
    /** Stored on the card, as opposed to computed from the template. */
    linked: z.boolean(),
    existsLocally: z.boolean().nullable(),
    branchAction: BranchActionSchema.nullable(),
  }),
)

/** `yuzie commits`: what the server holds, plus local commits not attached yet. */
export const CommitListEnvelopeSchema = jsonEnvelopeSchema(
  'CommitList',
  z.array(CommitSchema.extend({ attached: z.boolean() })),
)

/** `yuzie finish` (§9.4). */
export const FinishEnvelopeSchema = jsonEnvelopeSchema(
  'Finish',
  z.object({
    card: CardSchema,
    checks: z.array(
      z.object({
        name: z.enum(['clean', 'commits', 'pushed', 'checklist', 'tests', 'pr']),
        ok: z.boolean().nullable(),
        blocking: z.boolean(),
        detail: z.string(),
      }),
    ),
    skipped: z.boolean(),
    column: z.string().min(1),
  }),
)

/** `yuzie open` (§9.7): what it opened, or would have. */
export const OpenEnvelopeSchema = jsonEnvelopeSchema(
  'Open',
  z.object({
    number: CardNumberSchema,
    kind: z.enum(['editor', 'pr', 'compare', 'link']),
    /** The editor command line, or the URL. */
    target: z.string().min(1),
    /** False when there was no terminal (or CI): the target is printed instead. */
    launched: z.boolean(),
  }),
)

/**
 * A card created while offline (§18 Session 13): it has no number until the
 * server gives it one, so it is not a `Card` yet — but it is not lost either.
 */
export const QueuedCardSchema = z.object({
  queued: z.literal(true),
  title: z.string().min(1),
  column: z.string().min(1),
  assignees: z.array(HandleSchema),
  labels: z.array(z.string()),
  priority: z.number().int().min(0).max(3).nullable(),
  dueAt: z.string().nullable(),
})
export const QueuedCardEnvelopeSchema = jsonEnvelopeSchema('QueuedCard', QueuedCardSchema)

const SyncProblemSchema = z.object({
  cardNo: CardNumberSchema.nullable(),
  change: z.string(),
  message: z.string(),
})

/** `yuzie sync` (§18 Session 13): the reconciliation report. */
export const SyncReportEnvelopeSchema = jsonEnvelopeSchema(
  'SyncReport',
  z.object({
    sent: z.number().int().nonnegative(),
    conflicts: z.array(SyncProblemSchema.extend({ by: z.string().nullable() })),
    retrying: z.array(SyncProblemSchema.extend({ attempts: z.number().int().positive() })),
    setAside: z.array(SyncProblemSchema.extend({ attempts: z.number().int().positive() })),
    /** Still queued after this sync. */
    remaining: z.number().int().nonnegative(),
    /** The board's event seq after pulling. */
    seq: z.number().int().nonnegative(),
    /** Cards whose git summary was refreshed from the local branch. */
    gitRefreshed: z.array(CardNumberSchema),
    /** Buffered commits (§9.6 rule 5) now linked to a card. */
    attributed: z.number().int().nonnegative(),
    rebuilt: z.boolean(),
  }),
)

export const WatchEnvelopeSchema = jsonEnvelopeSchema(
  'Watch',
  z.object({ number: CardNumberSchema, watching: z.boolean() }),
)

/** `yuzie token list` (§18 Session 15): never a plaintext. */
export const ApiTokenListEnvelopeSchema = jsonEnvelopeSchema(
  'ApiTokenList',
  z.array(ApiTokenSchema),
)
/** `yuzie token create`: the one document that carries a plaintext token (§13.3). */
export const TokenCreatedEnvelopeSchema = jsonEnvelopeSchema(
  'TokenCreated',
  TokenCreateResponseSchema,
)
/** `yuzie token revoke`. */
export const TokenRevokedEnvelopeSchema = jsonEnvelopeSchema(
  'TokenRevoked',
  z.object({ id: z.uuid(), revoked: z.literal(true) }),
)

/** The schema for each `kind` a Session 7 command emits. */
export const OUTPUT_ENVELOPES = {
  ApiTokenList: ApiTokenListEnvelopeSchema,
  Board: BoardEnvelopeSchema,
  BoardList: BoardListEnvelopeSchema,
  Branch: BranchEnvelopeSchema,
  Card: CardEnvelopeSchema,
  CardList: CardListEnvelopeSchema,
  ChecklistItem: ChecklistItemEnvelopeSchema,
  Claim: ClaimEnvelopeSchema,
  Column: ColumnEnvelopeSchema,
  ColumnList: ColumnListEnvelopeSchema,
  Comment: CommentEnvelopeSchema,
  CommitList: CommitListEnvelopeSchema,
  Deleted: DeletedEnvelopeSchema,
  Event: EventOutputEnvelopeSchema,
  EventList: EventListEnvelopeSchema,
  Finish: FinishEnvelopeSchema,
  Invite: InviteEnvelopeSchema,
  MemberList: MemberListEnvelopeSchema,
  Open: OpenEnvelopeSchema,
  Presence: PresenceEnvelopeSchema,
  QueuedCard: QueuedCardEnvelopeSchema,
  Share: ShareEnvelopeSchema,
  SyncReport: SyncReportEnvelopeSchema,
  TokenCreated: TokenCreatedEnvelopeSchema,
  TokenRevoked: TokenRevokedEnvelopeSchema,
  Watch: WatchEnvelopeSchema,
} as const

export type OutputKind = keyof typeof OUTPUT_ENVELOPES

/** Validate a printed document against the schema for its `kind`. */
export function parseOutput(value: unknown): z.infer<(typeof OUTPUT_ENVELOPES)[OutputKind]> {
  const kind = (value as { kind?: unknown } | null)?.kind
  if (typeof kind !== 'string' || !(kind in OUTPUT_ENVELOPES)) {
    throw new Error(`Unknown output kind: ${String(kind)}`)
  }
  return OUTPUT_ENVELOPES[kind as OutputKind].parse(value)
}
