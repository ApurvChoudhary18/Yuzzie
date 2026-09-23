import {
  AnchorSchema,
  AnchorSetRequestSchema,
  BoardArchiveResponseSchema,
  BoardCreateRequestSchema,
  BoardDetailResponseSchema,
  BoardListResponseSchema,
  BoardSchema,
  BoardUpdateRequestSchema,
  CardAssignRequestSchema,
  CardCreateRequestSchema,
  CardDeleteResponseSchema,
  CardListResponseSchema,
  CardMoveRequestSchema,
  CardSchema,
  CardUpdateRequestSchema,
  ChecklistAddRequestSchema,
  ChecklistItemSchema,
  ChecklistUpdateRequestSchema,
  ColumnCreateRequestSchema,
  ColumnSchema,
  CommentCreateRequestSchema,
  CommentSchema,
  CommitSchema,
  CommitsAttachRequestSchema,
  DeviceAuthStartResponseSchema,
  DeviceTokenResponseSchema,
  ErrorEnvelopeSchema,
  EventsReplayResponseSchema,
  GitSummarySchema,
  GitSummaryUpsertRequestSchema,
  InviteCreateRequestSchema,
  MembersResponseSchema,
  MeResponseSchema,
  PresenceResponseSchema,
  TokenCreateRequestSchema,
  TokenCreateResponseSchema,
  TokenListResponseSchema,
  WatchRequestSchema,
} from '@yuzie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  call,
  createUser,
  startTestServer,
  type TestServer,
  type TestUser,
  unique,
} from './__tests__/harness.js'

/**
 * SPEC.md §18 Session 3 acceptance:
 * "every endpoint validates against @yuzie/core schemas in both directions."
 *
 * Requests are checked before they are sent, responses after they come back, so
 * a drift in either direction fails here rather than in the SDK two sessions
 * later.
 */

/** Assert a request body is well-formed, then return it unchanged. */
function request<T extends z.ZodType>(schema: T, body: z.input<T>): z.input<T> {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new Error(`request body does not match its schema: ${parsed.error.message}`)
  }
  return body
}

function expectMatches<T extends z.ZodType>(schema: T, value: unknown, label: string): z.infer<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`${label} does not match its schema:\n${parsed.error.message}`)
  }
  return parsed.data
}

describe('the §12.1 wire contract', () => {
  let server: TestServer
  let owner: TestUser
  let boardSlug: string
  let cardNumber: number
  let checklistItemId: string

  beforeAll(async () => {
    server = await startTestServer()
    owner = await createUser(server)
  })

  afterAll(async () => {
    await server?.close()
  })

  it('POST /auth/device', async () => {
    const response = await call(server, { method: 'POST', url: '/v1/auth/device' })
    expect(response.status).toBe(201)
    expectMatches(DeviceAuthStartResponseSchema, response.body, 'DeviceAuthStartResponse')
  })

  it('POST /auth/device/token completes the whole device flow', async () => {
    const started = await call<{ deviceCode: string; userCode: string }>(server, {
      method: 'POST',
      url: '/v1/auth/device',
    })

    const pending = await call<{ error: { status: number } }>(server, {
      method: 'POST',
      url: '/v1/auth/device/token',
      body: { deviceCode: started.body.deviceCode },
    })
    // Polling before approval is a normal state, not a failure (§6.1).
    expect(pending.status).toBe(428)
    expectMatches(ErrorEnvelopeSchema, pending.body, 'pending envelope')

    const handle = unique('device').replace(/[^a-z0-9-]/g, '')
    const approved = await call(server, {
      method: 'POST',
      url: '/v1/auth/device/approve',
      body: { userCode: started.body.userCode, handle },
    })
    expect(approved.status).toBe(200)

    const issued = await call(server, {
      method: 'POST',
      url: '/v1/auth/device/token',
      body: { deviceCode: started.body.deviceCode },
    })
    expect(issued.status).toBe(200)
    const token = expectMatches(DeviceTokenResponseSchema, issued.body, 'DeviceTokenResponse')
    expect(token.user.handle).toBe(handle)

    // A device code is single use.
    const reused = await call(server, {
      method: 'POST',
      url: '/v1/auth/device/token',
      body: { deviceCode: started.body.deviceCode },
    })
    expect(reused.status).toBe(401)
    expectMatches(ErrorEnvelopeSchema, reused.body, 'reuse envelope')
  })

  it('GET /me', async () => {
    const response = await call(server, { method: 'GET', url: '/v1/me', token: owner.token })
    expect(response.status).toBe(200)
    expectMatches(MeResponseSchema, response.body, 'MeResponse')
  })

  it('POST /boards', async () => {
    const name = unique('board')
    const body = request(BoardCreateRequestSchema, { name, repoRemote: 'github.com/acme/api' })

    const response = await call<{ slug: string }>(server, {
      method: 'POST',
      url: '/v1/boards',
      token: owner.token,
      body,
    })
    expect(response.status).toBe(201)
    const board = expectMatches(BoardSchema, response.body, 'Board')
    boardSlug = board.slug
  })

  it('GET /boards', async () => {
    const response = await call(server, { method: 'GET', url: '/v1/boards', token: owner.token })
    expect(response.status).toBe(200)
    expectMatches(BoardListResponseSchema, response.body, 'BoardListResponse')
  })

  it('GET /boards/:slug', async () => {
    const response = await call(server, {
      method: 'GET',
      url: `/v1/boards/${boardSlug}`,
      token: owner.token,
    })
    expect(response.status).toBe(200)
    const detail = expectMatches(BoardDetailResponseSchema, response.body, 'BoardDetailResponse')
    expect(detail.columns.map((column) => column.key)).toEqual(['todo', 'doing', 'review', 'done'])
    expect(detail.members.map((member) => member.handle)).toEqual([owner.handle])
  })

  it('POST /boards/:slug/columns', async () => {
    const body = request(ColumnCreateRequestSchema, { name: 'Blocked', after: 'doing' })
    const response = await call(server, {
      method: 'POST',
      url: `/v1/boards/${boardSlug}/columns`,
      token: owner.token,
      body,
    })
    expect(response.status).toBe(201)
    expectMatches(ColumnSchema, response.body, 'Column')
  })

  it('POST /boards/:slug/cards', async () => {
    const body = request(CardCreateRequestSchema, {
      title: 'Fix GitHub OAuth',
      description: 'OAuth callback drops the state param.',
      column: 'doing',
      labels: ['bug', 'auth'],
      priority: 1,
      anchor: { path: 'src/auth/oauth.ts', line: 42 },
    })

    const response = await call<{ number: number }>(server, {
      method: 'POST',
      url: `/v1/boards/${boardSlug}/cards`,
      token: owner.token,
      body,
    })
    expect(response.status).toBe(201)
    const card = expectMatches(CardSchema, response.body, 'Card')
    cardNumber = card.number

    expect(card.column).toBe('doing')
    expect(card.labels).toEqual(['auth', 'bug'])
    expect(card.anchor?.path).toBe('src/auth/oauth.ts')
    expect(card.createdBy).toBe(owner.handle)
  })

  it('GET /boards/:slug/cards', async () => {
    const response = await call(server, {
      method: 'GET',
      url: `/v1/boards/${boardSlug}/cards`,
      token: owner.token,
    })
    expect(response.status).toBe(200)
    expectMatches(CardListResponseSchema, response.body, 'CardListResponse')
  })

  it('GET /boards/:slug/cards/:no', async () => {
    const response = await call(server, {
      method: 'GET',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}`,
      token: owner.token,
    })
    expect(response.status).toBe(200)
    expectMatches(CardSchema, response.body, 'Card')
  })

  it('PATCH /boards/:slug/cards/:no', async () => {
    const body = request(CardUpdateRequestSchema, { title: 'Fix OAuth callback', priority: 0 })
    const response = await call(server, {
      method: 'PATCH',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}`,
      token: owner.token,
      body,
    })
    expect(response.status).toBe(200)
    const card = expectMatches(CardSchema, response.body, 'Card')
    expect(card.title).toBe('Fix OAuth callback')
    expect(card.priority).toBe(0)
  })

  it('POST /boards/:slug/cards/:no/move', async () => {
    const body = request(CardMoveRequestSchema, { column: 'review' })
    const response = await call(server, {
      method: 'POST',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}/move`,
      token: owner.token,
      body,
    })
    expect(response.status).toBe(200)
    const card = expectMatches(CardSchema, response.body, 'Card')
    expect(card.column).toBe('review')
  })

  it('POST /boards/:slug/cards/:no/assign', async () => {
    const body = request(CardAssignRequestSchema, { add: [owner.handle] })
    const response = await call(server, {
      method: 'POST',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}/assign`,
      token: owner.token,
      body,
    })
    expect(response.status).toBe(200)
    const card = expectMatches(CardSchema, response.body, 'Card')
    expect(card.assignees).toEqual([owner.handle])
  })

  it('POST /boards/:slug/cards/:no/comments', async () => {
    const body = request(CommentCreateRequestSchema, { body: 'Callback drops the state param.' })
    const response = await call(server, {
      method: 'POST',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}/comments`,
      token: owner.token,
      body,
    })
    expect(response.status).toBe(201)
    const comment = expectMatches(CommentSchema, response.body, 'Comment')
    expect(comment.author).toBe(owner.handle)
    expect(comment.cardNumber).toBe(cardNumber)
  })

  it('POST /boards/:slug/cards/:no/checklist', async () => {
    const body = request(ChecklistAddRequestSchema, { text: 'Fix callback state handling' })
    const response = await call(server, {
      method: 'POST',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}/checklist`,
      token: owner.token,
      body,
    })
    expect(response.status).toBe(201)
    const item = expectMatches(ChecklistItemSchema, response.body, 'ChecklistItem')
    checklistItemId = item.id
  })

  it('PATCH /boards/:slug/cards/:no/checklist/:itemId', async () => {
    const body = request(ChecklistUpdateRequestSchema, { done: true })
    const response = await call(server, {
      method: 'PATCH',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}/checklist/${checklistItemId}`,
      token: owner.token,
      body,
    })
    expect(response.status).toBe(200)
    const item = expectMatches(ChecklistItemSchema, response.body, 'ChecklistItem')
    expect(item.doneAt).not.toBeNull()
    expect(item.doneBy).toBe(owner.handle)
  })

  it('PUT /boards/:slug/cards/:no/git', async () => {
    const body = request(GitSummaryUpsertRequestSchema, {
      branch: 'task/1-fix-github-oauth',
      baseBranch: 'main',
      commits: 3,
      filesChanged: 7,
      additions: 120,
      deletions: 14,
      pushed: true,
      prUrl: 'https://github.com/acme/api/pull/204',
    })
    const response = await call(server, {
      method: 'PUT',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}/git`,
      token: owner.token,
      body,
    })
    expect(response.status).toBe(200)
    const git = expectMatches(GitSummarySchema, response.body, 'GitSummary')
    expect(git.commits).toBe(3)
    expect(git.pushed).toBe(true)
  })

  it('POST /boards/:slug/cards/:no/commits', async () => {
    const body = request(CommitsAttachRequestSchema, {
      commits: [
        {
          sha: 'a3f9c21',
          message: 'fix: handle oauth callback state mismatch',
          author: owner.handle,
          committedAt: new Date().toISOString(),
        },
      ],
    })
    const response = await call<{ commits: unknown[] }>(server, {
      method: 'POST',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}/commits`,
      token: owner.token,
      body,
    })
    expect(response.status).toBe(200)
    for (const commit of response.body.commits) {
      expectMatches(CommitSchema, commit, 'Commit')
    }
  })

  it('PUT /boards/:slug/cards/:no/anchor', async () => {
    const body = request(AnchorSetRequestSchema, {
      path: 'src/auth/oauth.ts',
      line: 42,
      endLine: 88,
      commitSha: 'a3f9c21',
    })
    const response = await call(server, {
      method: 'PUT',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}/anchor`,
      token: owner.token,
      body,
    })
    expect(response.status).toBe(200)
    const anchor = expectMatches(AnchorSchema, response.body, 'Anchor')
    expect(anchor.endLine).toBe(88)
  })

  it('POST /boards/:slug/cards/:no/watch', async () => {
    const body = request(WatchRequestSchema, { watching: true })
    const response = await call<{ watching: boolean }>(server, {
      method: 'POST',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}/watch`,
      token: owner.token,
      body,
    })
    expect(response.status).toBe(200)
    expect(response.body.watching).toBe(true)

    const card = await call(server, {
      method: 'GET',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}`,
      token: owner.token,
    })
    const parsed = expectMatches(CardSchema, card.body, 'Card')
    expect(parsed.watchers).toEqual([owner.handle])
  })

  it('GET /boards/:slug/events replays envelopes that parse as events', async () => {
    const response = await call(server, {
      method: 'GET',
      url: `/v1/boards/${boardSlug}/events?since=0&limit=500`,
      token: owner.token,
    })
    expect(response.status).toBe(200)

    // Every stored payload must parse as the event union — which also proves the
    // write path validated before it stored anything.
    const replay = expectMatches(EventsReplayResponseSchema, response.body, 'EventsReplayResponse')
    expect(replay.events.length).toBeGreaterThan(5)
    expect(replay.events.map((event) => event.seq)).toEqual(
      [...replay.events].map((event) => event.seq).sort((a, b) => a - b),
    )

    const types = new Set(replay.events.map((event) => event.type))
    expect(types).toContain('card.created')
    expect(types).toContain('card.moved')
    expect(types).toContain('comment.created')
    expect(types).toContain('card.branch.linked')
  })

  it('GET /boards/:slug/presence', async () => {
    const response = await call(server, {
      method: 'GET',
      url: `/v1/boards/${boardSlug}/presence`,
      token: owner.token,
    })
    expect(response.status).toBe(200)
    expectMatches(PresenceResponseSchema, response.body, 'PresenceResponse')
  })

  it('GET /boards/:slug/members and POST /boards/:slug/invites', async () => {
    const body = request(InviteCreateRequestSchema, {
      handle: unique('invitee').replace(/[^a-z0-9-]/g, ''),
      role: 'member',
    })
    const invited = await call(server, {
      method: 'POST',
      url: `/v1/boards/${boardSlug}/invites`,
      token: owner.token,
      body,
    })
    expect(invited.status).toBe(201)

    const members = await call(server, {
      method: 'GET',
      url: `/v1/boards/${boardSlug}/members`,
      token: owner.token,
    })
    expect(members.status).toBe(200)
    const parsed = expectMatches(MembersResponseSchema, members.body, 'MembersResponse')
    expect(parsed.members).toHaveLength(2)
  })

  it('POST /tokens, GET /tokens, DELETE /tokens/:id', async () => {
    const body = request(TokenCreateRequestSchema, {
      name: 'ci',
      role: 'member',
      boardSlug,
    })
    const minted = await call<{ token: string; apiToken: { id: string } }>(server, {
      method: 'POST',
      url: '/v1/tokens',
      token: owner.token,
      body,
    })
    expect(minted.status).toBe(201)
    const created = expectMatches(TokenCreateResponseSchema, minted.body, 'TokenCreateResponse')
    expect(created.token.startsWith('yz_')).toBe(true)

    const listed = await call(server, { method: 'GET', url: '/v1/tokens', token: owner.token })
    const tokens = expectMatches(TokenListResponseSchema, listed.body, 'TokenListResponse')
    // §13.3: the plaintext is shown exactly once, never in a listing.
    expect(JSON.stringify(tokens)).not.toContain(created.token)

    const revoked = await call<{ revoked: boolean }>(server, {
      method: 'DELETE',
      url: `/v1/tokens/${created.apiToken.id}`,
      token: owner.token,
    })
    expect(revoked.status).toBe(200)
    expect(revoked.body.revoked).toBe(true)

    // A revoked token stops working immediately.
    const afterRevoke = await call(server, {
      method: 'GET',
      url: '/v1/me',
      token: created.token,
    })
    expect(afterRevoke.status).toBe(401)
  })

  it('PATCH /boards/:slug then DELETE /boards/:slug', async () => {
    const patch = request(BoardUpdateRequestSchema, { name: 'Payments', baseBranch: 'trunk' })
    const patched = await call(server, {
      method: 'PATCH',
      url: `/v1/boards/${boardSlug}`,
      token: owner.token,
      body: patch,
    })
    expect(patched.status).toBe(200)
    const board = expectMatches(BoardSchema, patched.body, 'Board')
    expect(board.name).toBe('Payments')
    expect(board.baseBranch).toBe('trunk')

    const deletedCard = await call(server, {
      method: 'DELETE',
      url: `/v1/boards/${boardSlug}/cards/${cardNumber}`,
      token: owner.token,
    })
    expectMatches(CardDeleteResponseSchema, deletedCard.body, 'CardDeleteResponse')

    const archived = await call(server, {
      method: 'DELETE',
      url: `/v1/boards/${boardSlug}`,
      token: owner.token,
    })
    expect(archived.status).toBe(200)
    expectMatches(BoardArchiveResponseSchema, archived.body, 'BoardArchiveResponse')
  })

  it('reports every failure in the §12.1 envelope', async () => {
    const cases = [
      {
        method: 'GET' as const,
        url: '/v1/boards/nope-does-not-exist',
        token: owner.token,
        status: 404,
      },
      { method: 'GET' as const, url: '/v1/me', token: 'yz_not-a-real-token', status: 401 },
      { method: 'GET' as const, url: '/v1/nonsense', token: owner.token, status: 404 },
      { method: 'POST' as const, url: '/v1/boards', token: owner.token, body: {}, status: 400 },
    ]

    for (const testCase of cases) {
      const response = await call(server, testCase)
      expect(response.status, testCase.url).toBe(testCase.status)
      expectMatches(ErrorEnvelopeSchema, response.body, `error for ${testCase.url}`)
    }
  })

  it('serves /healthz and /metrics outside the versioned prefix', async () => {
    const health = await call<{ status: string }>(server, { method: 'GET', url: '/healthz' })
    expect(health.status).toBe(200)
    expect(health.body.status).toBe('ok')

    const metrics = await call<string>(server, { method: 'GET', url: '/metrics' })
    expect(metrics.status).toBe(200)
    expect(String(metrics.body)).toContain('yuzie_http_duration_seconds')
  })
})
