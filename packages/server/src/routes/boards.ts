/**
 * Boards, columns, members and tokens (SPEC.md §12.1).
 */
import {
  BoardCreateRequestSchema,
  BoardUpdateRequestSchema,
  boardError,
  ColumnCreateRequestSchema,
  type ColumnSemantics,
  InviteCreateRequestSchema,
  type Role,
  rankBetween,
  rebalance,
  slugify,
  TokenCreateRequestSchema,
} from '@yuzie/core'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authorizeOn } from '../auth/context.js'
import { generateToken, hashToken } from '../auth/tokens.js'
import {
  apiTokens,
  boards,
  cards,
  columns,
  labels,
  memberships,
  users,
  workspaces,
} from '../db/schema.js'
import { loadEvents } from '../services/log.js'
import { currentSeq, mutateBoard } from '../services/mutate.js'
import {
  loadMembers,
  toBoard,
  toColumn,
  toIso,
  toIsoRequired,
  toLabel,
  toUser,
} from '../services/serialize.js'
import {
  type AppContext,
  created,
  mutation,
  ok,
  parseBody,
  requireAuth,
  requireBoard,
} from './helpers.js'

const DEFAULT_COLUMNS: ReadonlyArray<{ name: string; semantics: ColumnSemantics }> = [
  { name: 'Todo', semantics: 'backlog' },
  { name: 'Doing', semantics: 'in_progress' },
  { name: 'Review', semantics: 'review' },
  { name: 'Done', semantics: 'terminal' },
]

export function registerBoardRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context

  app.get('/me', async (request, reply) => {
    const auth = await requireAuth(context, request)
    const rows = await db
      .select({ board: boards, role: memberships.role })
      .from(memberships)
      .innerJoin(boards, eq(memberships.boardId, boards.id))
      .where(eq(memberships.userId, auth.user.id))

    return reply.send({
      user: toUser(auth.user),
      memberships: rows.map(({ board, role }) => ({
        boardSlug: board.slug,
        boardName: board.name,
        role: role as Role,
      })),
    })
  })

  app.get('/boards', async (request, reply) => {
    const auth = await requireAuth(context, request)
    const rows = await db
      .select({ board: boards })
      .from(memberships)
      .innerJoin(boards, eq(memberships.boardId, boards.id))
      .where(eq(memberships.userId, auth.user.id))
      .orderBy(asc(boards.slug))

    return reply.send({ boards: rows.map((row) => toBoard(row.board)) })
  })

  app.post('/boards', async (request, reply) => {
    const auth = await requireAuth(context, request)
    if (auth.token.boardId !== null) {
      throw boardError('forbidden', 'A board-scoped token cannot create new boards')
    }

    return mutation(context, request, reply, auth, async () => {
      const body = parseBody(BoardCreateRequestSchema, request.body)
      const slug = body.slug ?? slugify(body.name, 64)
      const workspaceSlug = body.workspace ?? slug

      const [clash] = await db.select().from(boards).where(eq(boards.slug, slug))
      if (clash !== undefined) {
        throw boardError('validation_failed', `A board named "${slug}" already exists`, {
          details: { boardSlug: slug },
        })
      }

      const board = await db.transaction(async (tx) => {
        const [existingWorkspace] = await tx
          .select()
          .from(workspaces)
          .where(eq(workspaces.slug, workspaceSlug))

        const workspace =
          existingWorkspace ??
          (
            await tx
              .insert(workspaces)
              .values({ slug: workspaceSlug, name: body.workspace ?? body.name })
              .returning()
          )[0]

        if (workspace === undefined) throw boardError('internal', 'Could not create the workspace')

        const [row] = await tx
          .insert(boards)
          .values({
            workspaceId: workspace.id,
            slug,
            name: body.name,
            repoRemote: body.repoRemote ?? null,
            ...(body.baseBranch === undefined ? {} : { baseBranch: body.baseBranch }),
            ...(body.branchTemplate === undefined ? {} : { branchTemplate: body.branchTemplate }),
          })
          .returning()
        if (row === undefined) throw boardError('internal', 'Could not create the board')

        const names = body.columns ?? DEFAULT_COLUMNS.map((column) => column.name)
        const ranks = rebalance(names.length)
        await tx.insert(columns).values(
          names.map((name, index) => ({
            boardId: row.id,
            key: slugify(name, 64),
            name,
            rank: ranks[index] ?? rankBetween(),
            semantics:
              body.columns === undefined ? (DEFAULT_COLUMNS[index]?.semantics ?? null) : null,
          })),
        )

        // Whoever creates the board owns it.
        await tx
          .insert(memberships)
          .values({ boardId: row.id, userId: auth.user.id, role: 'owner' })

        return row
      })

      return created(toBoard(board))
    })
  })

  app.get<{ Params: { slug: string } }>('/boards/:slug', async (request, reply) => {
    const { access } = await requireBoard(context, request, request.params.slug)

    const columnRows = await db
      .select()
      .from(columns)
      .where(eq(columns.boardId, access.board.id))
      .orderBy(asc(columns.rank))
    const labelRows = await db
      .select()
      .from(labels)
      .where(eq(labels.boardId, access.board.id))
      .orderBy(asc(labels.name))
    const members = await loadMembers(db, access.board.id)

    return reply.send({
      board: toBoard(access.board),
      columns: columnRows.map(toColumn),
      labels: labelRows.map(toLabel),
      members,
    })
  })

  app.patch<{ Params: { slug: string } }>('/boards/:slug', async (request, reply) => {
    const { auth, access } = await requireBoard(context, request, request.params.slug)
    authorizeOn(access, 'board.update')

    return mutation(context, request, reply, auth, async (idempotencyKey) => {
      const body = parseBody(BoardUpdateRequestSchema, request.body)

      const { value } = await mutateBoard(
        db,
        access.board.id,
        { id: auth.user.id, handle: auth.user.handle },
        async (ctx) => {
          const [row] = await ctx.tx
            .update(boards)
            .set({
              ...(body.name === undefined ? {} : { name: body.name }),
              ...(body.baseBranch === undefined ? {} : { baseBranch: body.baseBranch }),
              ...(body.branchTemplate === undefined ? {} : { branchTemplate: body.branchTemplate }),
            })
            .where(eq(boards.id, access.board.id))
            .returning()
          if (row === undefined) throw boardError('internal', 'Could not update the board')

          ctx.emit({ type: 'board.updated', payload: { fields: body } })
          return row
        },
        { idempotencyKey, bus: context.bus },
      )

      return ok(toBoard(value))
    })
  })

  app.delete<{ Params: { slug: string } }>('/boards/:slug', async (request, reply) => {
    const { auth, access } = await requireBoard(context, request, request.params.slug)
    authorizeOn(access, 'board.archive')

    return mutation(context, request, reply, auth, async (idempotencyKey) => {
      const archivedAt = new Date()
      await mutateBoard(
        db,
        access.board.id,
        { id: auth.user.id, handle: auth.user.handle },
        async (ctx) => {
          await ctx.tx.update(boards).set({ archivedAt }).where(eq(boards.id, access.board.id))
          ctx.emit({
            type: 'board.updated',
            payload: { fields: { archivedAt: archivedAt.toISOString() } },
          })
        },
        { idempotencyKey, bus: context.bus },
      )
      return ok({ slug: access.board.slug, archivedAt: archivedAt.toISOString() })
    })
  })

  // §7.2 requires `yuzie columns add|rm`; §12.1 omits the endpoints, so they are
  // added here using the ColumnCreateRequest schema already defined in core.
  app.post<{ Params: { slug: string } }>('/boards/:slug/columns', async (request, reply) => {
    const { auth, access } = await requireBoard(context, request, request.params.slug)
    authorizeOn(access, 'column.manage')

    return mutation(context, request, reply, auth, async () => {
      const body = parseBody(ColumnCreateRequestSchema, request.body)
      const key = body.key ?? slugify(body.name, 64)

      const existing = await db
        .select()
        .from(columns)
        .where(eq(columns.boardId, access.board.id))
        .orderBy(asc(columns.rank))

      if (existing.some((column) => column.key === key)) {
        throw boardError('validation_failed', `A column "${key}" already exists on this board`)
      }

      const afterIndex =
        body.after === undefined
          ? existing.length - 1
          : existing.findIndex((c) => c.key === body.after)
      if (body.after !== undefined && afterIndex === -1) {
        throw boardError('column_not_found', `Column "${body.after}" does not exist on this board`)
      }

      const before = existing[afterIndex]?.rank
      const next = existing[afterIndex + 1]?.rank
      const rank = rankBetween(before, next)

      const [row] = await db
        .insert(columns)
        .values({
          boardId: access.board.id,
          key,
          name: body.name,
          rank,
          semantics: body.semantics ?? null,
          wipLimit: body.wipLimit ?? null,
        })
        .returning()
      if (row === undefined) throw boardError('internal', 'Could not create the column')

      return created(toColumn(row))
    })
  })

  app.delete<{ Params: { slug: string; key: string } }>(
    '/boards/:slug/columns/:key',
    async (request, reply) => {
      const { auth, access } = await requireBoard(context, request, request.params.slug)
      authorizeOn(access, 'column.manage')

      return mutation(context, request, reply, auth, async () => {
        const [column] = await db
          .select()
          .from(columns)
          .where(and(eq(columns.boardId, access.board.id), eq(columns.key, request.params.key)))
        if (column === undefined) {
          throw boardError('column_not_found', `Column "${request.params.key}" does not exist`)
        }

        const occupants = await db
          .select({ id: cards.id })
          .from(cards)
          .where(eq(cards.columnId, column.id))
        if (occupants.length > 0) {
          throw boardError(
            'validation_failed',
            `Column "${column.key}" still holds ${occupants.length} card(s). Move them out first.`,
          )
        }

        await db.delete(columns).where(eq(columns.id, column.id))
        return ok({ key: column.key, deleted: true })
      })
    },
  )

  app.get<{ Params: { slug: string } }>('/boards/:slug/members', async (request, reply) => {
    const { access } = await requireBoard(context, request, request.params.slug)
    return reply.send({ members: await loadMembers(db, access.board.id) })
  })

  app.post<{ Params: { slug: string } }>('/boards/:slug/invites', async (request, reply) => {
    const { auth, access } = await requireBoard(context, request, request.params.slug)
    authorizeOn(access, 'member.invite')

    return mutation(context, request, reply, auth, async (idempotencyKey) => {
      const body = parseBody(InviteCreateRequestSchema, request.body)
      const handle = body.handle ?? body.email?.split('@')[0]
      if (handle === undefined) throw boardError('validation_failed', 'Could not derive a handle')

      const { value } = await mutateBoard(
        db,
        access.board.id,
        { id: auth.user.id, handle: auth.user.handle },
        async (ctx) => {
          const [existing] = await ctx.tx.select().from(users).where(eq(users.handle, handle))
          const invited =
            existing ??
            (
              await ctx.tx
                .insert(users)
                .values({ handle, email: body.email ?? null, kind: 'human' })
                .returning()
            )[0]
          if (invited === undefined) throw boardError('internal', 'Could not create the invitee')

          await ctx.tx
            .insert(memberships)
            .values({ boardId: access.board.id, userId: invited.id, role: body.role })
            .onConflictDoUpdate({
              target: [memberships.boardId, memberships.userId],
              set: { role: body.role },
            })

          ctx.emit({ type: 'member.joined', payload: { handle, role: body.role } })
          return invited
        },
        { idempotencyKey, bus: context.bus },
      )

      return created({ handle: value.handle, role: body.role })
    })
  })

  app.get<{ Params: { slug: string }; Querystring: { since?: string; limit?: string } }>(
    '/boards/:slug/events',
    async (request, reply) => {
      const { access } = await requireBoard(context, request, request.params.slug)
      const since = Number.parseInt(request.query.since ?? '0', 10)
      const limit = Math.min(Number.parseInt(request.query.limit ?? '500', 10) || 500, 500)
      if (!Number.isInteger(since) || since < 0) {
        throw boardError('validation_failed', '`since` must be a non-negative integer')
      }

      return reply.send({
        events: await loadEvents(db, access.board.id, { since, limit }),
        seq: await currentSeq(db, access.board.id),
      })
    },
  )

  app.get<{ Params: { slug: string } }>('/boards/:slug/presence', async (request, reply) => {
    const { access } = await requireBoard(context, request, request.params.slug)
    return reply.send({ users: context.presence(access.board.id) })
  })

  app.get('/tokens', async (request, reply) => {
    const auth = await requireAuth(context, request)
    const rows = await db
      .select({ token: apiTokens, boardSlug: boards.slug })
      .from(apiTokens)
      .leftJoin(boards, eq(apiTokens.boardId, boards.id))
      .where(and(eq(apiTokens.userId, auth.user.id), isNull(apiTokens.revokedAt)))

    return reply.send({
      tokens: rows.map(({ token, boardSlug }) => ({
        id: token.id,
        name: token.name,
        role: token.role as Role,
        boardSlug: boardSlug ?? null,
        lastUsedAt: toIso(token.lastUsedAt),
        expiresAt: toIso(token.expiresAt),
        revokedAt: toIso(token.revokedAt),
        createdAt: toIsoRequired(token.createdAt),
      })),
    })
  })

  app.post('/tokens', async (request, reply) => {
    const auth = await requireAuth(context, request)
    return mutation(context, request, reply, auth, async () => {
      const body = parseBody(TokenCreateRequestSchema, request.body)

      let boardId: string | null = null
      let boardSlug: string | null = null
      if (body.boardSlug !== undefined) {
        const [board] = await db.select().from(boards).where(eq(boards.slug, body.boardSlug))
        if (board === undefined) {
          throw boardError('board_not_found', `Board ${body.boardSlug} does not exist`)
        }
        const [membership] = await db
          .select()
          .from(memberships)
          .where(and(eq(memberships.boardId, board.id), eq(memberships.userId, auth.user.id)))
        if (membership === undefined) {
          throw boardError('board_not_found', `Board ${body.boardSlug} does not exist`)
        }
        boardId = board.id
        boardSlug = board.slug
      }

      const plaintext = generateToken()
      const [row] = await db
        .insert(apiTokens)
        .values({
          userId: auth.user.id,
          boardId,
          name: body.name,
          tokenHash: hashToken(plaintext),
          role: body.role,
          expiresAt: body.expiresAt === undefined ? null : new Date(body.expiresAt),
        })
        .returning()
      if (row === undefined) throw boardError('internal', 'Could not create the token')

      // §13.3: the plaintext is shown exactly once and never stored.
      return created({
        token: plaintext,
        apiToken: {
          id: row.id,
          name: row.name,
          role: row.role as Role,
          boardSlug,
          lastUsedAt: toIso(row.lastUsedAt),
          expiresAt: toIso(row.expiresAt),
          revokedAt: toIso(row.revokedAt),
          createdAt: toIsoRequired(row.createdAt),
        },
      })
    })
  })

  // `yuzie logout` revokes the token it is holding; it never knows that token's id.
  app.delete('/tokens/current', async (request, reply) => {
    const auth = await requireAuth(context, request)
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, auth.token.id))
    return reply.send({ id: auth.token.id, revoked: true })
  })

  app.delete<{ Params: { id: string } }>('/tokens/:id', async (request, reply) => {
    const auth = await requireAuth(context, request)
    const parsed = z.uuid().safeParse(request.params.id)
    if (!parsed.success) throw boardError('validation_failed', 'Token id must be a uuid')

    const revoked = await db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, request.params.id), eq(apiTokens.userId, auth.user.id)))
      .returning({ id: apiTokens.id })

    if (revoked.length === 0) {
      throw boardError('card_not_found', 'No such token', { status: 404 })
    }
    return reply.send({ id: request.params.id, revoked: true })
  })
}
