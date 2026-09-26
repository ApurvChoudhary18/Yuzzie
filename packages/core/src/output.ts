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

export const WatchEnvelopeSchema = jsonEnvelopeSchema(
  'Watch',
  z.object({ number: CardNumberSchema, watching: z.boolean() }),
)

/** The schema for each `kind` a Session 7 command emits. */
export const OUTPUT_ENVELOPES = {
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
  Presence: PresenceEnvelopeSchema,
  Share: ShareEnvelopeSchema,
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
