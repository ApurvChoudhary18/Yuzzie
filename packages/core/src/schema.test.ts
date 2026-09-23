import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  BOARD_ID,
  CARD_ID,
  makeBoard,
  makeCard,
  makeChecklistItem,
  makeColumn,
  makeMember,
  T0,
  WORKSPACE_ID,
} from './__fixtures__/board.js'
import {
  AnchorSchema,
  ApiTokenSchema,
  BoardCreateRequestSchema,
  BoardDetailResponseSchema,
  BoardSchema,
  BoardUpdateRequestSchema,
  CardAssignRequestSchema,
  CardCreateRequestSchema,
  CardListEnvelopeSchema,
  CardListQuerySchema,
  CardMoveRequestSchema,
  CardSchema,
  CardUpdateRequestSchema,
  ChecklistItemSchema,
  ChecklistUpdateRequestSchema,
  ColumnSchema,
  CommentSchema,
  CommitSchema,
  DeviceAuthStartResponseSchema,
  ErrorEnvelopeSchema,
  GitSummarySchema,
  GitSummaryUpsertRequestSchema,
  InviteCreateRequestSchema,
  JSON_API_VERSION,
  jsonEnvelopeSchema,
  LabelSchema,
  MemberSchema,
  MembershipSchema,
  PresenceSchema,
  TokenCreateRequestSchema,
  UserSchema,
  WorkspaceSchema,
} from './schema.js'

interface EntityCase {
  readonly name: string
  readonly schema: z.ZodType
  readonly valid: unknown
  /** A single field changed to something the schema must reject. */
  readonly invalid: unknown
}

const ENTITY_CASES: readonly EntityCase[] = [
  {
    name: 'User',
    schema: UserSchema,
    valid: {
      id: CARD_ID,
      handle: 'rahul',
      email: 'rahul@acme.dev',
      displayName: 'Rahul',
      avatarUrl: 'https://avatars.example/rahul.png',
      kind: 'human',
      githubLogin: 'rahul',
      createdAt: T0,
    },
    invalid: {
      id: 'not-a-uuid',
      handle: 'rahul',
      email: null,
      displayName: null,
      avatarUrl: null,
      kind: 'human',
      githubLogin: null,
      createdAt: T0,
    },
  },
  {
    name: 'Workspace',
    schema: WorkspaceSchema,
    valid: { id: WORKSPACE_ID, slug: 'acme', name: 'Acme', createdAt: T0 },
    invalid: { id: WORKSPACE_ID, slug: 'Acme Corp', name: 'Acme', createdAt: T0 },
  },
  {
    name: 'Board',
    schema: BoardSchema,
    valid: makeBoard(),
    invalid: { ...makeBoard(), nextCardNo: 0 },
  },
  {
    name: 'Membership',
    schema: MembershipSchema,
    valid: { boardId: BOARD_ID, userId: CARD_ID, role: 'owner', createdAt: T0 },
    invalid: { boardId: BOARD_ID, userId: CARD_ID, role: 'admin', createdAt: T0 },
  },
  {
    name: 'Member',
    schema: MemberSchema,
    valid: makeMember('rahul'),
    invalid: { ...makeMember('rahul'), kind: 'robot' },
  },
  {
    name: 'Column',
    schema: ColumnSchema,
    valid: makeColumn('doing', 'b'),
    invalid: { ...makeColumn('doing', 'b'), rank: 'a0' },
  },
  {
    name: 'Label',
    schema: LabelSchema,
    valid: { name: 'bug', color: '#d73a4a' },
    invalid: { name: '', color: null },
  },
  {
    name: 'ChecklistItem',
    schema: ChecklistItemSchema,
    valid: makeChecklistItem(),
    invalid: { ...makeChecklistItem(), position: 0 },
  },
  {
    name: 'Comment',
    schema: CommentSchema,
    valid: {
      id: CARD_ID,
      cardNumber: 18,
      author: 'rahul',
      body: 'Fixed.',
      createdAt: T0,
      editedAt: null,
    },
    invalid: {
      id: CARD_ID,
      cardNumber: 18,
      author: 'rahul',
      body: '',
      createdAt: T0,
      editedAt: null,
    },
  },
  {
    name: 'GitSummary',
    schema: GitSummarySchema,
    valid: {
      branch: 'task/18-fix-github-oauth',
      baseBranch: 'main',
      commits: 3,
      filesChanged: 7,
      additions: 120,
      deletions: 14,
      pushed: true,
      prUrl: 'https://github.com/acme/payments-api/pull/204',
      prState: 'open',
      lastActivityAt: T0,
    },
    invalid: {
      branch: null,
      baseBranch: null,
      commits: -1,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      pushed: false,
      prUrl: null,
      prState: null,
      lastActivityAt: null,
    },
  },
  {
    name: 'Commit',
    schema: CommitSchema,
    valid: { sha: 'a3f9c21', message: 'fix: oauth state', author: 'rahul', committedAt: T0 },
    invalid: { sha: 'zzz', message: null, author: null, committedAt: null },
  },
  {
    name: 'Anchor',
    schema: AnchorSchema,
    valid: {
      path: 'src/auth/oauth.ts',
      line: 42,
      endLine: 88,
      commitSha: 'a3f9c21',
      primary: true,
    },
    invalid: { path: '', line: 42, endLine: null, commitSha: null, primary: true },
  },
  { name: 'Card', schema: CardSchema, valid: makeCard(), invalid: { ...makeCard(), priority: 9 } },
  {
    name: 'Presence',
    schema: PresenceSchema,
    valid: {
      handle: 'claude',
      kind: 'agent',
      state: 'working',
      cardNo: 27,
      branch: 'task/27-x',
      since: T0,
    },
    invalid: {
      handle: 'claude',
      kind: 'agent',
      state: 'napping',
      cardNo: null,
      branch: null,
      since: null,
    },
  },
  {
    name: 'ApiToken',
    schema: ApiTokenSchema,
    valid: {
      id: CARD_ID,
      name: 'ci',
      role: 'member',
      boardSlug: 'payments-api',
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: T0,
    },
    invalid: {
      id: CARD_ID,
      name: 'ci',
      role: 'member',
      boardSlug: 'payments-api',
      lastUsedAt: null,
      expiresAt: 'not-a-date',
      revokedAt: null,
      createdAt: T0,
    },
  },
]

describe('entity schemas', () => {
  for (const entity of ENTITY_CASES) {
    it(`${entity.name} accepts a well-formed value`, () => {
      expect(entity.schema.safeParse(entity.valid).success).toBe(true)
    })

    it(`${entity.name} rejects a malformed value`, () => {
      expect(entity.schema.safeParse(entity.invalid).success).toBe(false)
    })

    it(`${entity.name} rejects a non-object`, () => {
      expect(entity.schema.safeParse(null).success).toBe(false)
    })
  }
})

describe('CardSchema details', () => {
  it('requires a rank that is a valid fractional index', () => {
    expect(CardSchema.safeParse({ ...makeCard(), rank: 'a0' }).success).toBe(false)
    expect(CardSchema.safeParse({ ...makeCard(), rank: 'a1' }).success).toBe(true)
  })

  it('accepts every priority in p0..p3 and rejects others', () => {
    for (const priority of [0, 1, 2, 3, null]) {
      expect(CardSchema.safeParse({ ...makeCard(), priority }).success).toBe(true)
    }
    expect(CardSchema.safeParse({ ...makeCard(), priority: 4 }).success).toBe(false)
  })

  it('rejects a column key that is not URL- and shell-safe', () => {
    expect(CardSchema.safeParse({ ...makeCard(), column: 'In Progress' }).success).toBe(false)
  })
})

describe('the JSON output envelope (§7.3)', () => {
  it('wraps a card list with a stable apiVersion and kind', () => {
    const parsed = CardListEnvelopeSchema.safeParse({
      apiVersion: JSON_API_VERSION,
      kind: 'CardList',
      data: [makeCard()],
      meta: { count: 1, boardSlug: 'payments-api', synced: true },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a different apiVersion, which is what a major bump would mean', () => {
    const parsed = CardListEnvelopeSchema.safeParse({
      apiVersion: 'yuzie/v2',
      kind: 'CardList',
      data: [],
      meta: {},
    })
    expect(parsed.success).toBe(false)
  })

  it('allows a command to add its own meta keys', () => {
    const schema = jsonEnvelopeSchema('Thing', CardSchema)
    const parsed = schema.safeParse({
      apiVersion: JSON_API_VERSION,
      kind: 'Thing',
      data: makeCard(),
      meta: { count: 1, staleDays: 3 },
    })
    expect(parsed.success).toBe(true)
  })
})

describe('the error envelope (§12.1)', () => {
  it('accepts the example from the spec verbatim', () => {
    const parsed = ErrorEnvelopeSchema.safeParse({
      error: {
        code: 'card_not_found',
        message: 'Card #99 does not exist on board payments-api',
        status: 404,
        details: { boardSlug: 'payments-api', number: 99 },
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a code outside the documented set', () => {
    const parsed = ErrorEnvelopeSchema.safeParse({
      error: { code: 'kaboom', message: 'x', status: 500 },
    })
    expect(parsed.success).toBe(false)
  })
})

describe('request bodies', () => {
  it('BoardCreateRequest needs only a name', () => {
    expect(BoardCreateRequestSchema.safeParse({ name: 'payments-api' }).success).toBe(true)
    expect(BoardCreateRequestSchema.safeParse({}).success).toBe(false)
  })

  it('BoardUpdateRequest refuses an empty patch', () => {
    expect(BoardUpdateRequestSchema.safeParse({}).success).toBe(false)
    expect(BoardUpdateRequestSchema.safeParse({ name: 'Payments' }).success).toBe(true)
  })

  it('BoardDetailResponse carries columns, labels and members', () => {
    const parsed = BoardDetailResponseSchema.safeParse({
      board: makeBoard(),
      columns: [makeColumn('todo', 'a'), makeColumn('doing', 'b')],
      labels: [{ name: 'bug', color: null }],
      members: [makeMember('rahul', { role: 'owner' })],
    })
    expect(parsed.success).toBe(true)
  })

  it('CardCreateRequest needs a title and accepts an anchor', () => {
    expect(CardCreateRequestSchema.safeParse({ title: 'Fix OAuth' }).success).toBe(true)
    expect(
      CardCreateRequestSchema.safeParse({
        title: 'Fix OAuth',
        anchor: { path: 'src/auth/oauth.ts', line: 42 },
        priority: 1,
      }).success,
    ).toBe(true)
    expect(CardCreateRequestSchema.safeParse({ title: '' }).success).toBe(false)
  })

  it('CardUpdateRequest refuses an empty patch but allows clearing a field', () => {
    expect(CardUpdateRequestSchema.safeParse({}).success).toBe(false)
    expect(CardUpdateRequestSchema.safeParse({ description: null }).success).toBe(true)
  })

  it('accepts a column reference as the user typed it, but stores a canonical key', () => {
    // §7.2 matches columns case-insensitively by prefix, so a request body has
    // to carry `REV` even though the entity's key is `review`.
    expect(CardMoveRequestSchema.safeParse({ column: 'REV' }).success).toBe(true)
    expect(CardCreateRequestSchema.safeParse({ title: 'x', column: 'Doing' }).success).toBe(true)
    expect(CardListQuerySchema.safeParse({ column: 'Done' }).success).toBe(true)

    // The entity itself is still strict: a stored key is lowercase.
    expect(CardSchema.safeParse({ ...makeCard(), column: 'Doing' }).success).toBe(false)
  })

  it('CardMoveRequest requires a target column', () => {
    expect(CardMoveRequestSchema.safeParse({ column: 'review' }).success).toBe(true)
    expect(CardMoveRequestSchema.safeParse({ beforeCard: 3 }).success).toBe(false)
  })

  it('CardAssignRequest refuses a no-op', () => {
    expect(CardAssignRequestSchema.safeParse({ add: [], remove: [] }).success).toBe(false)
    expect(CardAssignRequestSchema.safeParse({ add: ['claude'] }).success).toBe(true)
  })

  it('ChecklistUpdateRequest refuses an empty patch', () => {
    expect(ChecklistUpdateRequestSchema.safeParse({}).success).toBe(false)
    expect(ChecklistUpdateRequestSchema.safeParse({ done: true }).success).toBe(true)
  })

  it('GitSummaryUpsertRequest accepts a partial summary from the client', () => {
    expect(GitSummaryUpsertRequestSchema.safeParse({ commits: 3, filesChanged: 7 }).success).toBe(
      true,
    )
    expect(GitSummaryUpsertRequestSchema.safeParse({ commits: -3 }).success).toBe(false)
  })

  it('InviteCreateRequest needs an email or a handle, and defaults the role', () => {
    expect(InviteCreateRequestSchema.safeParse({}).success).toBe(false)
    const parsed = InviteCreateRequestSchema.safeParse({ email: 'adarsh@acme.dev' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.role).toBe('member')
  })

  it('TokenCreateRequest needs a name and a role', () => {
    expect(TokenCreateRequestSchema.safeParse({ name: 'ci', role: 'member' }).success).toBe(true)
    expect(TokenCreateRequestSchema.safeParse({ name: 'ci' }).success).toBe(false)
  })

  it('CardListQuery caps the limit at a full board', () => {
    expect(CardListQuerySchema.safeParse({ limit: 2000 }).success).toBe(true)
    expect(CardListQuerySchema.safeParse({ limit: 2001 }).success).toBe(false)
    expect(CardListQuerySchema.safeParse({ sort: 'sideways' }).success).toBe(false)
  })

  it('DeviceAuthStartResponse matches the device flow in §6.1', () => {
    const parsed = DeviceAuthStartResponseSchema.safeParse({
      deviceCode: 'dc_123',
      userCode: 'WXYZ-4821',
      verifyUrl: 'https://yuzie.dev/device',
      interval: 5,
      expiresIn: 900,
    })
    expect(parsed.success).toBe(true)
  })
})
