/**
 * The wire contract (SPEC.md §12.1), declared once.
 *
 * The server validates with these, the SDK infers its types from them, and the
 * CLI's `--json` output is checked against them. That is the whole point: there
 * is no second place where the shape of a card is written down.
 *
 * The event union and the `GET /events` replay body live in `events.ts` so that
 * this module has no imports from it, keeping the value graph acyclic.
 */
import { z } from 'zod'
import { isValidRank } from './rank.js'
import type {
  Anchor,
  ApiToken,
  Board,
  Card,
  ChecklistItem,
  Column,
  Comment,
  Commit,
  GitSummary,
  Label,
  Member,
  Membership,
  Presence,
  User,
  Workspace,
} from './types.js'
import { COLUMN_SEMANTICS, PRESENCE_STATES, ROLES, USER_KINDS } from './types.js'

/** Stamped on every `--json` payload (SPEC.md §7.3). */
export const JSON_API_VERSION = 'yuzie/v1'

const HANDLE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const COLUMN_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
const SHA_PATTERN = /^[0-9a-f]{7,40}$/

const uuid = () => z.uuid()
const isoDateTime = () => z.iso.datetime({ offset: true })
const handle = () => z.string().min(1).max(39).regex(HANDLE_PATTERN)
const slug = () => z.string().min(1).max(64).regex(SLUG_PATTERN)
const columnKey = () => z.string().min(1).max(64).regex(COLUMN_KEY_PATTERN)
const cardNumber = () => z.number().int().positive()
const rank = () => z.string().refine(isValidRank, { message: 'Not a valid fractional index' })

export const RoleSchema = z.enum(ROLES)
export const UserKindSchema = z.enum(USER_KINDS)
export const ColumnSemanticsSchema = z.enum(COLUMN_SEMANTICS)
export const PresenceStateSchema = z.enum(PRESENCE_STATES)
export const PrioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])

// ---------------------------------------------------------------------------
// Entities (SPEC.md §11.1)
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  id: uuid(),
  handle: handle(),
  email: z.email().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  kind: UserKindSchema,
  githubLogin: z.string().nullable(),
  createdAt: isoDateTime(),
}) satisfies z.ZodType<User>

export const WorkspaceSchema = z.object({
  id: uuid(),
  slug: slug(),
  name: z.string().min(1),
  createdAt: isoDateTime(),
}) satisfies z.ZodType<Workspace>

export const BoardSchema = z.object({
  id: uuid(),
  workspaceId: uuid(),
  slug: slug(),
  name: z.string().min(1),
  repoRemote: z.string().nullable(),
  baseBranch: z.string().min(1),
  branchTemplate: z.string().min(1),
  nextCardNo: z.number().int().positive(),
  archivedAt: isoDateTime().nullable(),
  createdAt: isoDateTime(),
}) satisfies z.ZodType<Board>

export const MembershipSchema = z.object({
  boardId: uuid(),
  userId: uuid(),
  role: RoleSchema,
  createdAt: isoDateTime(),
}) satisfies z.ZodType<Membership>

export const MemberSchema = z.object({
  handle: handle(),
  displayName: z.string().nullable(),
  kind: UserKindSchema,
  role: RoleSchema,
  lastSeenAt: isoDateTime().nullable(),
}) satisfies z.ZodType<Member>

export const ColumnSchema = z.object({
  id: uuid(),
  boardId: uuid(),
  key: columnKey(),
  name: z.string().min(1),
  rank: rank(),
  semantics: ColumnSemanticsSchema.nullable(),
  wipLimit: z.number().int().positive().nullable(),
}) satisfies z.ZodType<Column>

export const LabelSchema = z.object({
  name: z.string().min(1),
  color: z.string().nullable(),
}) satisfies z.ZodType<Label>

export const ChecklistItemSchema = z.object({
  id: uuid(),
  position: z.number().int().positive(),
  text: z.string().min(1),
  doneAt: isoDateTime().nullable(),
  doneBy: handle().nullable(),
}) satisfies z.ZodType<ChecklistItem>

export const CommentSchema = z.object({
  id: uuid(),
  cardNumber: cardNumber(),
  author: handle(),
  body: z.string().min(1),
  createdAt: isoDateTime(),
  editedAt: isoDateTime().nullable(),
}) satisfies z.ZodType<Comment>

export const GitSummarySchema = z.object({
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  commits: z.number().int().nonnegative(),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  pushed: z.boolean(),
  prUrl: z.url().nullable(),
  prState: z.string().nullable(),
  lastActivityAt: isoDateTime().nullable(),
}) satisfies z.ZodType<GitSummary>

export const CommitSchema = z.object({
  sha: z.string().regex(SHA_PATTERN),
  message: z.string().nullable(),
  author: handle().nullable(),
  committedAt: isoDateTime().nullable(),
}) satisfies z.ZodType<Commit>

export const AnchorSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
  commitSha: z.string().regex(SHA_PATTERN).nullable(),
  primary: z.boolean(),
}) satisfies z.ZodType<Anchor>

export const CardSchema = z.object({
  id: uuid(),
  boardId: uuid(),
  number: cardNumber(),
  column: columnKey(),
  rank: rank(),
  title: z.string().min(1),
  description: z.string().nullable(),
  priority: PrioritySchema.nullable(),
  dueAt: isoDateTime().nullable(),
  assignees: z.array(handle()),
  labels: z.array(z.string().min(1)),
  watchers: z.array(handle()),
  checklist: z.array(ChecklistItemSchema),
  comments: z.array(CommentSchema),
  commits: z.array(CommitSchema),
  git: GitSummarySchema.nullable(),
  anchor: AnchorSchema.nullable(),
  createdBy: handle().nullable(),
  archivedAt: isoDateTime().nullable(),
  createdAt: isoDateTime(),
  updatedAt: isoDateTime(),
  version: z.number().int().positive(),
}) satisfies z.ZodType<Card>

export const PresenceSchema = z.object({
  handle: handle(),
  kind: UserKindSchema,
  state: PresenceStateSchema,
  cardNo: cardNumber().nullable(),
  branch: z.string().nullable(),
  since: isoDateTime().nullable(),
}) satisfies z.ZodType<Presence>

export const ApiTokenSchema = z.object({
  id: uuid(),
  name: z.string().min(1),
  role: RoleSchema,
  boardSlug: slug().nullable(),
  lastUsedAt: isoDateTime().nullable(),
  expiresAt: isoDateTime().nullable(),
  revokedAt: isoDateTime().nullable(),
  createdAt: isoDateTime(),
}) satisfies z.ZodType<ApiToken>

// ---------------------------------------------------------------------------
// JSON output envelope (SPEC.md §7.3)
// ---------------------------------------------------------------------------

/** Extra keys are allowed so a command can add context without a schema bump. */
export const EnvelopeMetaSchema = z.looseObject({
  count: z.number().int().nonnegative().optional(),
  boardSlug: slug().optional(),
  synced: z.boolean().optional(),
  /** Set when the payload came from cache while offline (SPEC.md §13 acceptance). */
  cachedAt: isoDateTime().optional(),
})

/** Builds the stable `{ apiVersion, kind, data, meta }` wrapper for a payload. */
export function jsonEnvelopeSchema<TKind extends string, TData extends z.ZodType>(
  kind: TKind,
  data: TData,
) {
  return z.object({
    apiVersion: z.literal(JSON_API_VERSION),
    kind: z.literal(kind),
    data,
    meta: EnvelopeMetaSchema,
  })
}

export const CardListEnvelopeSchema = jsonEnvelopeSchema('CardList', z.array(CardSchema))
export const CardEnvelopeSchema = jsonEnvelopeSchema('Card', CardSchema)
export const BoardListEnvelopeSchema = jsonEnvelopeSchema('BoardList', z.array(BoardSchema))
export const MemberListEnvelopeSchema = jsonEnvelopeSchema('MemberList', z.array(MemberSchema))
export const PresenceEnvelopeSchema = jsonEnvelopeSchema('Presence', z.array(PresenceSchema))

// ---------------------------------------------------------------------------
// Error envelope (SPEC.md §12.1)
// ---------------------------------------------------------------------------

export const ErrorCodeSchema = z.enum([
  'unauthenticated',
  'forbidden',
  'card_not_found',
  'board_not_found',
  'column_not_found',
  'version_conflict',
  'validation_failed',
  'rate_limited',
  'wip_limit_exceeded',
  'offline_network_required',
  'git_precondition_failed',
  'internal',
])

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    status: z.number().int().nonnegative(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

// ---------------------------------------------------------------------------
// Auth (SPEC.md §12.1, §13.3)
// ---------------------------------------------------------------------------

export const DeviceAuthStartRequestSchema = z.object({
  client: z.string().min(1).optional(),
})

export const DeviceAuthStartResponseSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verifyUrl: z.url(),
  /** Seconds the client should wait between polls. */
  interval: z.number().int().positive(),
  expiresIn: z.number().int().positive(),
})

export const DeviceTokenRequestSchema = z.object({
  deviceCode: z.string().min(1),
})

export const DeviceTokenResponseSchema = z.object({
  token: z.string().min(1),
  user: UserSchema,
})

export const MembershipSummarySchema = z.object({
  boardSlug: slug(),
  boardName: z.string().min(1),
  role: RoleSchema,
})

export const MeResponseSchema = z.object({
  user: UserSchema,
  memberships: z.array(MembershipSummarySchema),
})

// ---------------------------------------------------------------------------
// Boards and columns
// ---------------------------------------------------------------------------

export const BoardListResponseSchema = z.object({
  boards: z.array(BoardSchema),
})

export const BoardCreateRequestSchema = z.object({
  name: z.string().min(1),
  slug: slug().optional(),
  workspace: slug().optional(),
  repoRemote: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional(),
  branchTemplate: z.string().min(1).optional(),
  /** Display names; keys are derived by the server. Defaults to Todo/Doing/Review/Done. */
  columns: z.array(z.string().min(1)).min(1).optional(),
})

export const BoardUpdateRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    branchTemplate: z.string().min(1).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' })

export const BoardDetailResponseSchema = z.object({
  board: BoardSchema,
  columns: z.array(ColumnSchema),
  labels: z.array(LabelSchema),
  members: z.array(MemberSchema),
})

export const BoardArchiveResponseSchema = z.object({
  slug: slug(),
  archivedAt: isoDateTime(),
})

export const ColumnCreateRequestSchema = z.object({
  name: z.string().min(1),
  key: columnKey().optional(),
  /** Insert after this column key; omitted means append. */
  after: columnKey().optional(),
  semantics: ColumnSemanticsSchema.optional(),
  wipLimit: z.number().int().positive().optional(),
})

// ---------------------------------------------------------------------------
// Cards (SPEC.md §7.2, §12.1)
// ---------------------------------------------------------------------------

export const AnchorInputSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  commitSha: z.string().regex(SHA_PATTERN).optional(),
  primary: z.boolean().optional(),
})

export const CardListQuerySchema = z.object({
  column: columnKey().optional(),
  assignee: handle().optional(),
  label: z.string().min(1).optional(),
  mine: z.boolean().optional(),
  watching: z.boolean().optional(),
  /** A duration such as `2d`, matching `yuzie list --stale 2d`. */
  stale: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  limit: z.number().int().positive().max(2000).optional(),
  sort: z.enum(['rank', 'created', 'updated', 'due', 'priority']).optional(),
})

export const CardListResponseSchema = z.object({
  cards: z.array(CardSchema),
  boardSlug: slug(),
  count: z.number().int().nonnegative(),
})

export const CardCreateRequestSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  column: columnKey().optional(),
  assignees: z.array(handle()).optional(),
  labels: z.array(z.string().min(1)).optional(),
  dueAt: isoDateTime().optional(),
  priority: PrioritySchema.optional(),
  anchor: AnchorInputSchema.optional(),
  /** Card numbers used to place the new card; omitted means append. */
  beforeCard: cardNumber().optional(),
  afterCard: cardNumber().optional(),
})

export const CardUpdateRequestSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    priority: PrioritySchema.nullable().optional(),
    dueAt: isoDateTime().nullable().optional(),
    labels: z.array(z.string().min(1)).optional(),
    checklist: z.array(ChecklistItemSchema).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' })

export const CardMoveRequestSchema = z.object({
  column: columnKey(),
  beforeCard: cardNumber().optional(),
  afterCard: cardNumber().optional(),
})

export const CardAssignRequestSchema = z
  .object({
    add: z.array(handle()).optional(),
    remove: z.array(handle()).optional(),
  })
  .refine((body) => (body.add?.length ?? 0) + (body.remove?.length ?? 0) > 0, {
    message: 'Nothing to add or remove',
  })

export const CardDeleteResponseSchema = z.object({
  number: cardNumber(),
  deleted: z.literal(true),
})

export const CommentCreateRequestSchema = z.object({
  body: z.string().min(1),
})

export const ChecklistAddRequestSchema = z.object({
  text: z.string().min(1),
  position: z.number().int().positive().optional(),
})

export const ChecklistUpdateRequestSchema = z
  .object({
    done: z.boolean().optional(),
    text: z.string().min(1).optional(),
    position: z.number().int().positive().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' })

/** `PUT /cards/:no/git` — the client derives this locally (SPEC.md §9.1). */
export const GitSummaryUpsertRequestSchema = GitSummarySchema.partial()

export const CommitsAttachRequestSchema = z.object({
  commits: z.array(CommitSchema).min(1),
})

export const AnchorSetRequestSchema = AnchorInputSchema

export const WatchRequestSchema = z.object({
  watching: z.boolean(),
})

// ---------------------------------------------------------------------------
// Presence, members, tokens
// ---------------------------------------------------------------------------

export const PresenceResponseSchema = z.object({
  users: z.array(PresenceSchema),
})

export const MembersResponseSchema = z.object({
  members: z.array(MemberSchema),
})

export const InviteCreateRequestSchema = z
  .object({
    email: z.email().optional(),
    handle: handle().optional(),
    role: RoleSchema.default('member'),
  })
  .refine((body) => body.email !== undefined || body.handle !== undefined, {
    message: 'Provide an email address or a @handle to invite',
  })

export const TokenCreateRequestSchema = z.object({
  name: z.string().min(1),
  role: RoleSchema,
  boardSlug: slug().optional(),
  expiresAt: isoDateTime().optional(),
})

/** The only response that ever carries a plaintext token (SPEC.md §13.3). */
export const TokenCreateResponseSchema = z.object({
  token: z.string().min(1),
  apiToken: ApiTokenSchema,
})

export const TokenListResponseSchema = z.object({
  tokens: z.array(ApiTokenSchema),
})

// ---------------------------------------------------------------------------
// Reusable primitives, so `events.ts` validates handles and timestamps the same
// way the entity schemas do.
// ---------------------------------------------------------------------------

export const UuidSchema = uuid()
export const IsoDateTimeSchema = isoDateTime()
export const HandleSchema = handle()
export const SlugSchema = slug()
export const ColumnKeySchema = columnKey()
export const CardNumberSchema = cardNumber()
export const RankSchema = rank()

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type ErrorEnvelopeBody = z.infer<typeof ErrorEnvelopeSchema>
export type EnvelopeMeta = z.infer<typeof EnvelopeMetaSchema>
export type DeviceAuthStartRequest = z.infer<typeof DeviceAuthStartRequestSchema>
export type DeviceAuthStartResponse = z.infer<typeof DeviceAuthStartResponseSchema>
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequestSchema>
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>
export type MembershipSummary = z.infer<typeof MembershipSummarySchema>
export type MeResponse = z.infer<typeof MeResponseSchema>
export type BoardListResponse = z.infer<typeof BoardListResponseSchema>
export type BoardCreateRequest = z.infer<typeof BoardCreateRequestSchema>
export type BoardUpdateRequest = z.infer<typeof BoardUpdateRequestSchema>
export type BoardDetailResponse = z.infer<typeof BoardDetailResponseSchema>
export type BoardArchiveResponse = z.infer<typeof BoardArchiveResponseSchema>
export type ColumnCreateRequest = z.infer<typeof ColumnCreateRequestSchema>
export type AnchorInput = z.infer<typeof AnchorInputSchema>
export type CardListQuery = z.infer<typeof CardListQuerySchema>
export type CardListResponse = z.infer<typeof CardListResponseSchema>
export type CardCreateRequest = z.infer<typeof CardCreateRequestSchema>
export type CardUpdateRequest = z.infer<typeof CardUpdateRequestSchema>
export type CardMoveRequest = z.infer<typeof CardMoveRequestSchema>
export type CardAssignRequest = z.infer<typeof CardAssignRequestSchema>
export type CardDeleteResponse = z.infer<typeof CardDeleteResponseSchema>
export type CommentCreateRequest = z.infer<typeof CommentCreateRequestSchema>
export type ChecklistAddRequest = z.infer<typeof ChecklistAddRequestSchema>
export type ChecklistUpdateRequest = z.infer<typeof ChecklistUpdateRequestSchema>
export type GitSummaryUpsertRequest = z.infer<typeof GitSummaryUpsertRequestSchema>
export type CommitsAttachRequest = z.infer<typeof CommitsAttachRequestSchema>
export type AnchorSetRequest = z.infer<typeof AnchorSetRequestSchema>
export type WatchRequest = z.infer<typeof WatchRequestSchema>
export type PresenceResponse = z.infer<typeof PresenceResponseSchema>
export type MembersResponse = z.infer<typeof MembersResponseSchema>
export type InviteCreateRequest = z.infer<typeof InviteCreateRequestSchema>
export type TokenCreateRequest = z.infer<typeof TokenCreateRequestSchema>
export type TokenCreateResponse = z.infer<typeof TokenCreateResponseSchema>
export type TokenListResponse = z.infer<typeof TokenListResponseSchema>
