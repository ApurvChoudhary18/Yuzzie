/**
 * Cards and everything attached to them (SPEC.md §12.1).
 *
 * Every mutation runs through `mutateBoard`, so it is serialised on the board
 * row, appends its events in the same transaction, and bumps the card's
 * `version` for the optimistic concurrency in §11.4.
 */
import {
  AnchorSetRequestSchema,
  boardError,
  type Card,
  CardAssignRequestSchema,
  CardCreateRequestSchema,
  CardMoveRequestSchema,
  CardUpdateRequestSchema,
  ChecklistAddRequestSchema,
  ChecklistUpdateRequestSchema,
  CommentCreateRequestSchema,
  CommitsAttachRequestSchema,
  cardNotFound,
  columnNotFound,
  GitSummaryUpsertRequestSchema,
  newId,
  rankBetween,
  versionConflict,
  WatchRequestSchema,
} from '@yuzie/core'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { authorizeOn, type BoardAccess } from '../auth/context.js'
import type { Database } from '../db/client.js'
import {
  anchors,
  cardAssignees,
  cardLabels,
  cards,
  checklistItems,
  columns,
  comments,
  commits,
  gitLinks,
  labels,
  users,
  watchers,
} from '../db/schema.js'
import { type MutationContext, mutateBoard } from '../services/mutate.js'
import { loadCard, loadCards } from '../services/serialize.js'
import { type AppContext, created, mutation, ok, parseBody, requireBoard } from './helpers.js'

type CardRow = typeof cards.$inferSelect
type ColumnRow = typeof columns.$inferSelect
type Transaction = MutationContext['tx']

/**
 * A transaction exposes the same query surface as the database handle; drizzle
 * just types them as distinct classes.
 */
const asQueryable = (tx: Transaction): Database => tx as unknown as Database

function parseCardNumber(raw: string): number {
  const number = Number.parseInt(raw.replace(/^#/, ''), 10)
  if (!Number.isInteger(number) || number < 1) {
    throw boardError('validation_failed', `"${raw}" is not a card number`)
  }
  return number
}

async function requireCardRow(
  tx: Transaction,
  boardId: string,
  boardSlug: string,
  number: number,
): Promise<CardRow> {
  const [row] = await tx
    .select()
    .from(cards)
    .where(and(eq(cards.boardId, boardId), eq(cards.number, number)))
  if (row === undefined) throw cardNotFound(number, boardSlug)
  return row
}

async function resolveColumn(
  tx: Transaction,
  boardId: string,
  boardSlug: string,
  key: string | undefined,
): Promise<ColumnRow> {
  const all = await tx
    .select()
    .from(columns)
    .where(eq(columns.boardId, boardId))
    .orderBy(asc(columns.rank))

  if (key === undefined) {
    const first = all[0]
    if (first === undefined) {
      throw boardError('column_not_found', `Board ${boardSlug} has no columns`)
    }
    return first
  }

  const lowered = key.toLowerCase()
  const exact = all.find((column) => column.key === lowered)
  if (exact !== undefined) return exact

  // §7.2: "Column matched case-insensitively by prefix."
  const prefixed = all.filter((column) => column.key.startsWith(lowered))
  const only = prefixed[0]
  if (prefixed.length === 1 && only !== undefined) return only
  if (prefixed.length > 1) {
    throw boardError(
      'validation_failed',
      `"${key}" matches ${prefixed.map((column) => column.key).join(', ')}. Be more specific.`,
    )
  }
  throw columnNotFound(key, boardSlug)
}

async function rankWithin(
  tx: Transaction,
  boardId: string,
  columnId: string,
  placement: { beforeCard?: number | undefined; afterCard?: number | undefined },
  excludeCardId?: string,
): Promise<string> {
  const siblings = (
    await tx
      .select({ id: cards.id, number: cards.number, rank: cards.rank })
      .from(cards)
      .where(and(eq(cards.boardId, boardId), eq(cards.columnId, columnId)))
      .orderBy(asc(cards.rank))
  ).filter((row) => row.id !== excludeCardId)

  if (placement.beforeCard !== undefined) {
    const index = siblings.findIndex((row) => row.number === placement.beforeCard)
    if (index === -1) throw cardNotFound(placement.beforeCard, boardId)
    return rankBetween(siblings[index - 1]?.rank, siblings[index]?.rank)
  }
  if (placement.afterCard !== undefined) {
    const index = siblings.findIndex((row) => row.number === placement.afterCard)
    if (index === -1) throw cardNotFound(placement.afterCard, boardId)
    return rankBetween(siblings[index]?.rank, siblings[index + 1]?.rank)
  }
  return rankBetween(siblings.at(-1)?.rank, undefined)
}

async function enforceWipLimit(
  tx: Transaction,
  boardId: string,
  column: ColumnRow,
  incoming: number,
): Promise<void> {
  if (column.wipLimit === null) return
  const occupants = await tx
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.boardId, boardId), eq(cards.columnId, column.id)))
  if (occupants.length + incoming > column.wipLimit) {
    throw boardError(
      'wip_limit_exceeded',
      `Column "${column.name}" is limited to ${column.wipLimit} cards. Move something out first.`,
      { details: { column: column.key, wipLimit: column.wipLimit } },
    )
  }
}

async function resolveUserIds(
  tx: Transaction,
  handles: readonly string[],
): Promise<Map<string, string>> {
  if (handles.length === 0) return new Map()
  const rows = await tx
    .select({ id: users.id, handle: users.handle })
    .from(users)
    .where(inArray(users.handle, [...handles]))

  const found = new Map(rows.map((row) => [row.handle, row.id]))
  const missing = handles.filter((handle) => !found.has(handle))
  if (missing.length > 0) {
    throw boardError(
      'validation_failed',
      `No such user: ${missing.map((handle) => `@${handle}`).join(', ')}`,
      { details: { missing } },
    )
  }
  return found
}

async function setLabels(
  tx: Transaction,
  boardId: string,
  cardId: string,
  names: readonly string[],
): Promise<void> {
  await tx.delete(cardLabels).where(eq(cardLabels.cardId, cardId))
  if (names.length === 0) return

  const existing = await tx.select().from(labels).where(eq(labels.boardId, boardId))
  const byName = new Map(existing.map((row) => [row.name, row.id]))

  const ids: string[] = []
  for (const name of new Set(names)) {
    const known = byName.get(name)
    if (known !== undefined) {
      ids.push(known)
      continue
    }
    const [row] = await tx.insert(labels).values({ boardId, name }).returning()
    if (row !== undefined) ids.push(row.id)
  }

  await tx.insert(cardLabels).values(ids.map((labelId) => ({ cardId, labelId })))
}

/** Bump `version` and `updated_at`; §11.4 makes every write observable. */
/** Bump a card's version and stamp it with the mutation's clock (see `MutationContext.now`). */
async function touchCard(tx: Transaction, cardId: string, now: Date): Promise<number> {
  const [row] = await tx.select({ version: cards.version }).from(cards).where(eq(cards.id, cardId))
  const next = (row?.version ?? 0) + 1
  await tx.update(cards).set({ version: next, updatedAt: now }).where(eq(cards.id, cardId))
  return next
}

export function registerCardRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context

  const board = (request: Parameters<typeof requireBoard>[1], slug: string) =>
    requireBoard(context, request, slug)

  app.get<{ Params: { slug: string }; Querystring: Record<string, string | undefined> }>(
    '/boards/:slug/cards',
    async (request, reply) => {
      const { access } = await board(request, request.params.slug)
      const query = request.query

      let list = await loadCards(db, access.board.id)

      const { column, assignee, label, search } = query

      if (column !== undefined) list = list.filter((card) => card.column === column)
      if (assignee !== undefined) {
        const handle = assignee.replace(/^@/, '')
        list = list.filter((card) => card.assignees.includes(handle))
      }
      if (label !== undefined) list = list.filter((card) => card.labels.includes(label))
      if (search !== undefined) {
        const needle = search.toLowerCase()
        list = list.filter(
          (card) =>
            card.title.toLowerCase().includes(needle) ||
            (card.description ?? '').toLowerCase().includes(needle),
        )
      }
      const limit = Number.parseInt(query.limit ?? '', 10)
      if (Number.isInteger(limit) && limit > 0) list = list.slice(0, limit)

      return reply.send({
        cards: list,
        boardSlug: access.board.slug,
        count: list.length,
      })
    },
  )

  app.post<{ Params: { slug: string } }>('/boards/:slug/cards', async (request, reply) => {
    const { auth, access } = await board(request, request.params.slug)
    authorizeOn(access, 'card.write')

    return mutation(context, request, reply, auth, async (idempotencyKey) => {
      const body = parseBody(CardCreateRequestSchema, request.body)

      const { value } = await mutateBoard(
        db,
        access.board.id,
        { id: auth.user.id, handle: auth.user.handle },
        async (ctx) => {
          const column = await resolveColumn(
            ctx.tx,
            access.board.id,
            access.board.slug,
            body.column,
          )
          await enforceWipLimit(ctx.tx, access.board.id, column, 1)

          const rank = await rankWithin(ctx.tx, access.board.id, column.id, {
            beforeCard: body.beforeCard,
            afterCard: body.afterCard,
          })
          const number = ctx.nextCardNumber()

          const [row] = await ctx.tx
            .insert(cards)
            .values({
              boardId: access.board.id,
              number,
              columnId: column.id,
              rank,
              title: body.title,
              description: body.description ?? null,
              priority: body.priority ?? null,
              dueAt: body.dueAt === undefined ? null : new Date(body.dueAt),
              createdAt: ctx.now,
              updatedAt: ctx.now,
              createdBy: auth.user.id,
            })
            .returning()
          if (row === undefined) throw boardError('internal', 'Could not create the card')

          if (body.assignees !== undefined && body.assignees.length > 0) {
            const ids = await resolveUserIds(ctx.tx, body.assignees)
            await ctx.tx
              .insert(cardAssignees)
              .values([...ids.values()].map((userId) => ({ cardId: row.id, userId })))
          }
          if (body.labels !== undefined) {
            await setLabels(ctx.tx, access.board.id, row.id, body.labels)
          }
          if (body.anchor !== undefined) {
            await ctx.tx.insert(anchors).values({
              cardId: row.id,
              path: body.anchor.path,
              line: body.anchor.line ?? null,
              endLine: body.anchor.endLine ?? null,
              commitSha: body.anchor.commitSha ?? null,
              primaryAnchor: true,
            })
          }

          const card = await loadCard(asQueryable(ctx.tx), access.board.id, number)
          if (card === undefined) throw boardError('internal', 'Card vanished after insert')

          ctx.emit({ type: 'card.created', cardId: row.id, cardNo: number, payload: card })
          return card
        },
        { idempotencyKey, bus: context.bus },
      )

      return created(value)
    })
  })

  app.get<{ Params: { slug: string; no: string } }>(
    '/boards/:slug/cards/:no',
    async (request, reply) => {
      const { access } = await board(request, request.params.slug)
      const number = parseCardNumber(request.params.no)
      const card = await loadCard(db, access.board.id, number)
      if (card === undefined) throw cardNotFound(number, access.board.slug)
      return reply.send(card)
    },
  )

  app.patch<{ Params: { slug: string; no: string } }>(
    '/boards/:slug/cards/:no',
    async (request, reply) => {
      const { auth, access } = await board(request, request.params.slug)
      authorizeOn(access, 'card.write')
      const number = parseCardNumber(request.params.no)

      return mutation(context, request, reply, auth, async (idempotencyKey) => {
        const body = parseBody(CardUpdateRequestSchema, request.body)
        const ifMatch = request.headers['if-match']

        const { value } = await mutateBoard(
          db,
          access.board.id,
          { id: auth.user.id, handle: auth.user.handle },
          async (ctx) => {
            const row = await requireCardRow(ctx.tx, access.board.id, access.board.slug, number)
            await assertVersionMatches(ctx, access, ifMatch, row, number)

            const scalarPatch = {
              ...(body.title === undefined ? {} : { title: body.title }),
              ...(body.description === undefined ? {} : { description: body.description }),
              ...(body.priority === undefined ? {} : { priority: body.priority }),
              ...(body.dueAt === undefined
                ? {}
                : { dueAt: body.dueAt === null ? null : new Date(body.dueAt) }),
            }
            // A patch of only `labels` or only `checklist` touches no column on
            // `cards`, and an UPDATE with an empty SET is an error, not a no-op.
            if (Object.keys(scalarPatch).length > 0) {
              await ctx.tx.update(cards).set(scalarPatch).where(eq(cards.id, row.id))
            }

            if (body.labels !== undefined) {
              await setLabels(ctx.tx, access.board.id, row.id, body.labels)
            }
            if (body.checklist !== undefined) {
              await ctx.tx.delete(checklistItems).where(eq(checklistItems.cardId, row.id))
              if (body.checklist.length > 0) {
                await ctx.tx.insert(checklistItems).values(
                  body.checklist.map((item) => ({
                    id: item.id,
                    cardId: row.id,
                    position: item.position,
                    text: item.text,
                    doneAt: item.doneAt === null ? null : new Date(item.doneAt),
                    doneBy: null,
                  })),
                )
              }
            }

            const version = await touchCard(ctx.tx, row.id, ctx.now)
            ctx.emit({
              type: 'card.updated',
              cardId: row.id,
              cardNo: number,
              payload: { fields: body, version },
            })

            const card = await loadCard(asQueryable(ctx.tx), access.board.id, number)
            if (card === undefined) throw boardError('internal', 'Card vanished during update')
            return card
          },
          { idempotencyKey, bus: context.bus },
        )

        return ok(value)
      })
    },
  )

  app.delete<{ Params: { slug: string; no: string } }>(
    '/boards/:slug/cards/:no',
    async (request, reply) => {
      const { auth, access } = await board(request, request.params.slug)
      const number = parseCardNumber(request.params.no)

      const [existing] = await db
        .select({ createdBy: cards.createdBy })
        .from(cards)
        .where(and(eq(cards.boardId, access.board.id), eq(cards.number, number)))
      if (existing === undefined) throw cardNotFound(number, access.board.slug)

      authorizeOn(access, 'card.delete', existing.createdBy === auth.user.id)

      return mutation(context, request, reply, auth, async (idempotencyKey) => {
        await mutateBoard(
          db,
          access.board.id,
          { id: auth.user.id, handle: auth.user.handle },
          async (ctx) => {
            const row = await requireCardRow(ctx.tx, access.board.id, access.board.slug, number)
            await ctx.tx.delete(cards).where(eq(cards.id, row.id))
            ctx.emit({ type: 'card.deleted', cardNo: number, payload: { number } })
          },
          { idempotencyKey, bus: context.bus },
        )
        return ok({ number, deleted: true })
      })
    },
  )

  app.post<{ Params: { slug: string; no: string } }>(
    '/boards/:slug/cards/:no/move',
    async (request, reply) => {
      const { auth, access } = await board(request, request.params.slug)
      authorizeOn(access, 'card.write')
      const number = parseCardNumber(request.params.no)

      return mutation(context, request, reply, auth, async (idempotencyKey) => {
        const body = parseBody(CardMoveRequestSchema, request.body)

        const { value } = await mutateBoard(
          db,
          access.board.id,
          { id: auth.user.id, handle: auth.user.handle },
          async (ctx) => {
            const row = await requireCardRow(ctx.tx, access.board.id, access.board.slug, number)
            const target = await resolveColumn(
              ctx.tx,
              access.board.id,
              access.board.slug,
              body.column,
            )
            const [from] = await ctx.tx.select().from(columns).where(eq(columns.id, row.columnId))

            if (target.id !== row.columnId) {
              await enforceWipLimit(ctx.tx, access.board.id, target, 1)
            }

            const rank = await rankWithin(
              ctx.tx,
              access.board.id,
              target.id,
              { beforeCard: body.beforeCard, afterCard: body.afterCard },
              row.id,
            )

            await ctx.tx
              .update(cards)
              .set({ columnId: target.id, rank })
              .where(eq(cards.id, row.id))
            await touchCard(ctx.tx, row.id, ctx.now)

            ctx.emit({
              type: 'card.moved',
              cardId: row.id,
              cardNo: number,
              payload: { from: from?.key ?? target.key, to: target.key, rank },
            })

            const card = await loadCard(asQueryable(ctx.tx), access.board.id, number)
            if (card === undefined) throw boardError('internal', 'Card vanished during move')
            return card
          },
          { idempotencyKey, bus: context.bus },
        )

        return ok(value)
      })
    },
  )

  app.post<{ Params: { slug: string; no: string } }>(
    '/boards/:slug/cards/:no/assign',
    async (request, reply) => {
      const { auth, access } = await board(request, request.params.slug)
      authorizeOn(access, 'card.assign')
      const number = parseCardNumber(request.params.no)

      return mutation(context, request, reply, auth, async (idempotencyKey) => {
        const body = parseBody(CardAssignRequestSchema, request.body)
        const add = (body.add ?? []).map((handle) => handle.replace(/^@/, ''))
        const remove = (body.remove ?? []).map((handle) => handle.replace(/^@/, ''))

        const { value } = await mutateBoard(
          db,
          access.board.id,
          { id: auth.user.id, handle: auth.user.handle },
          async (ctx) => {
            const row = await requireCardRow(ctx.tx, access.board.id, access.board.slug, number)

            if (remove.length > 0) {
              const ids = await resolveUserIds(ctx.tx, remove)
              await ctx.tx
                .delete(cardAssignees)
                .where(
                  and(
                    eq(cardAssignees.cardId, row.id),
                    inArray(cardAssignees.userId, [...ids.values()]),
                  ),
                )
            }
            if (add.length > 0) {
              const ids = await resolveUserIds(ctx.tx, add)
              await ctx.tx
                .insert(cardAssignees)
                .values([...ids.values()].map((userId) => ({ cardId: row.id, userId })))
                .onConflictDoNothing()
            }

            await touchCard(ctx.tx, row.id, ctx.now)
            ctx.emit({
              type: 'card.assigned',
              cardId: row.id,
              cardNo: number,
              payload: { added: add, removed: remove },
            })

            const card = await loadCard(asQueryable(ctx.tx), access.board.id, number)
            if (card === undefined) throw boardError('internal', 'Card vanished during assign')
            return card
          },
          { idempotencyKey, bus: context.bus },
        )

        return ok(value)
      })
    },
  )

  app.post<{ Params: { slug: string; no: string } }>(
    '/boards/:slug/cards/:no/comments',
    async (request, reply) => {
      const { auth, access } = await board(request, request.params.slug)
      authorizeOn(access, 'comment.create')
      const number = parseCardNumber(request.params.no)

      return mutation(context, request, reply, auth, async (idempotencyKey) => {
        const body = parseBody(CommentCreateRequestSchema, request.body)

        const { value } = await mutateBoard(
          db,
          access.board.id,
          { id: auth.user.id, handle: auth.user.handle },
          async (ctx) => {
            const row = await requireCardRow(ctx.tx, access.board.id, access.board.slug, number)
            const commentId = newId()

            await ctx.tx.insert(comments).values({
              id: commentId,
              cardId: row.id,
              authorId: auth.user.id,
              body: body.body,
              createdAt: ctx.now,
            })

            ctx.emit({
              type: 'comment.created',
              cardId: row.id,
              cardNo: number,
              payload: { commentId, body: body.body, author: auth.user.handle },
            })

            const card = await loadCard(asQueryable(ctx.tx), access.board.id, number)
            const comment = card?.comments.find((item) => item.id === commentId)
            if (comment === undefined) throw boardError('internal', 'Comment vanished after insert')
            return comment
          },
          { idempotencyKey, bus: context.bus },
        )

        return created(value)
      })
    },
  )

  app.post<{ Params: { slug: string; no: string } }>(
    '/boards/:slug/cards/:no/checklist',
    async (request, reply) => {
      const { auth, access } = await board(request, request.params.slug)
      authorizeOn(access, 'checklist.write')
      const number = parseCardNumber(request.params.no)

      return mutation(context, request, reply, auth, async (idempotencyKey) => {
        const body = parseBody(ChecklistAddRequestSchema, request.body)

        const { value } = await mutateBoard(
          db,
          access.board.id,
          { id: auth.user.id, handle: auth.user.handle },
          async (ctx) => {
            const row = await requireCardRow(ctx.tx, access.board.id, access.board.slug, number)
            const existing = await ctx.tx
              .select()
              .from(checklistItems)
              .where(eq(checklistItems.cardId, row.id))

            const position =
              body.position ?? existing.reduce((max, item) => Math.max(max, item.position), 0) + 1

            const [item] = await ctx.tx
              .insert(checklistItems)
              .values({ cardId: row.id, position, text: body.text })
              .returning()
            if (item === undefined) throw boardError('internal', 'Could not add the checklist item')

            const version = await touchCard(ctx.tx, row.id, ctx.now)
            const card = await loadCard(asQueryable(ctx.tx), access.board.id, number)
            ctx.emit({
              type: 'card.updated',
              cardId: row.id,
              cardNo: number,
              payload: { fields: { checklist: card?.checklist ?? [] }, version },
            })

            return {
              id: item.id,
              position: item.position,
              text: item.text,
              doneAt: null,
              doneBy: null,
            }
          },
          { idempotencyKey, bus: context.bus },
        )

        return created(value)
      })
    },
  )

  app.patch<{ Params: { slug: string; no: string; itemId: string } }>(
    '/boards/:slug/cards/:no/checklist/:itemId',
    async (request, reply) => {
      const { auth, access } = await board(request, request.params.slug)
      authorizeOn(access, 'checklist.write')
      const number = parseCardNumber(request.params.no)

      return mutation(context, request, reply, auth, async (idempotencyKey) => {
        const body = parseBody(ChecklistUpdateRequestSchema, request.body)

        const { value } = await mutateBoard(
          db,
          access.board.id,
          { id: auth.user.id, handle: auth.user.handle },
          async (ctx) => {
            const row = await requireCardRow(ctx.tx, access.board.id, access.board.slug, number)
            const [item] = await ctx.tx
              .select()
              .from(checklistItems)
              .where(
                and(
                  eq(checklistItems.cardId, row.id),
                  eq(checklistItems.id, request.params.itemId),
                ),
              )
            if (item === undefined) {
              throw boardError('card_not_found', 'No such checklist item on this card', {
                status: 404,
              })
            }

            const doneAt = body.done === undefined ? item.doneAt : body.done ? ctx.now : null
            await ctx.tx
              .update(checklistItems)
              .set({
                doneAt,
                doneBy:
                  body.done === true ? auth.user.id : body.done === false ? null : item.doneBy,
                ...(body.text === undefined ? {} : { text: body.text }),
                ...(body.position === undefined ? {} : { position: body.position }),
              })
              .where(eq(checklistItems.id, item.id))

            await touchCard(ctx.tx, row.id, ctx.now)
            if (body.done !== undefined) {
              ctx.emit({
                type: 'checklist.updated',
                cardId: row.id,
                cardNo: number,
                payload: { itemId: item.id, done: body.done },
              })
            }

            const card = await loadCard(asQueryable(ctx.tx), access.board.id, number)
            const updated = card?.checklist.find((entry) => entry.id === item.id)
            if (updated === undefined) throw boardError('internal', 'Checklist item vanished')
            return updated
          },
          { idempotencyKey, bus: context.bus },
        )

        return ok(value)
      })
    },
  )

  app.put<{ Params: { slug: string; no: string } }>(
    '/boards/:slug/cards/:no/git',
    async (request, reply) => {
      const { auth, access } = await board(request, request.params.slug)
      authorizeOn(access, 'git.write')
      const number = parseCardNumber(request.params.no)

      return mutation(context, request, reply, auth, async (idempotencyKey) => {
        const body = parseBody(GitSummaryUpsertRequestSchema, request.body)

        const { value } = await mutateBoard(
          db,
          access.board.id,
          { id: auth.user.id, handle: auth.user.handle },
          async (ctx) => {
            const row = await requireCardRow(ctx.tx, access.board.id, access.board.slug, number)

            const patch = {
              ...(body.branch === undefined ? {} : { branch: body.branch }),
              ...(body.baseBranch === undefined ? {} : { baseBranch: body.baseBranch }),
              ...(body.commits === undefined ? {} : { commitCount: body.commits }),
              ...(body.filesChanged === undefined ? {} : { filesChanged: body.filesChanged }),
              ...(body.additions === undefined ? {} : { additions: body.additions }),
              ...(body.deletions === undefined ? {} : { deletions: body.deletions }),
              ...(body.pushed === undefined ? {} : { pushed: body.pushed }),
              ...(body.prUrl === undefined ? {} : { prUrl: body.prUrl }),
              ...(body.prState === undefined ? {} : { prState: body.prState }),
              lastActivityAt:
                body.lastActivityAt === undefined || body.lastActivityAt === null
                  ? ctx.now
                  : new Date(body.lastActivityAt),
              updatedAt: ctx.now,
            }

            await ctx.tx
              .insert(gitLinks)
              .values({ cardId: row.id, ...patch })
              .onConflictDoUpdate({ target: gitLinks.cardId, set: patch })

            await touchCard(ctx.tx, row.id, ctx.now)

            const card = await loadCard(asQueryable(ctx.tx), access.board.id, number)
            const git = card?.git
            if (git == null) throw boardError('internal', 'Git summary vanished')

            // Every value in these events is read back from what was stored, so a
            // client folding them lands on exactly the summary a snapshot shows.
            // A branch link and a metric refresh are different events (§12.3).
            if (body.branch !== undefined && git.branch !== null) {
              ctx.emit({
                type: 'card.branch.linked',
                cardId: row.id,
                cardNo: number,
                payload: { branch: git.branch, base: git.baseBranch },
              })
            }
            ctx.emit({
              type: 'card.git.updated',
              cardId: row.id,
              cardNo: number,
              payload: {
                ...(body.commits === undefined ? {} : { commits: git.commits }),
                ...(body.filesChanged === undefined ? {} : { filesChanged: git.filesChanged }),
                ...(body.additions === undefined ? {} : { additions: git.additions }),
                ...(body.deletions === undefined ? {} : { deletions: git.deletions }),
                ...(body.pushed === undefined ? {} : { pushed: git.pushed }),
                ...(body.prUrl === undefined ? {} : { prUrl: git.prUrl }),
                ...(body.prState === undefined ? {} : { prState: git.prState }),
                lastActivityAt: git.lastActivityAt,
              },
            })

            return git
          },
          { idempotencyKey, bus: context.bus },
        )

        return ok(value)
      })
    },
  )

  app.post<{ Params: { slug: string; no: string } }>(
    '/boards/:slug/cards/:no/commits',
    async (request, reply) => {
      const { auth, access } = await board(request, request.params.slug)
      authorizeOn(access, 'git.write')
      const number = parseCardNumber(request.params.no)

      return mutation(context, request, reply, auth, async (idempotencyKey) => {
        const body = parseBody(CommitsAttachRequestSchema, request.body)

        const { value } = await mutateBoard(
          db,
          access.board.id,
          { id: auth.user.id, handle: auth.user.handle },
          async (ctx) => {
            const row = await requireCardRow(ctx.tx, access.board.id, access.board.slug, number)

            await ctx.tx
              .insert(commits)
              .values(
                body.commits.map((commit) => ({
                  sha: commit.sha,
                  cardId: row.id,
                  authorId: auth.user.id,
                  message: commit.message,
                  committedAt: commit.committedAt === null ? null : new Date(commit.committedAt),
                })),
              )
              .onConflictDoNothing()

            await touchCard(ctx.tx, row.id, ctx.now)
            const card = await loadCard(asQueryable(ctx.tx), access.board.id, number)
            const shas = body.commits.map((commit) => commit.sha)
            ctx.emit({
              type: 'card.commits.attached',
              cardId: row.id,
              cardNo: number,
              payload: {
                shas,
                // As stored, so a client folding this matches a snapshot.
                commits: (card?.commits ?? []).filter((commit) => shas.includes(commit.sha)),
              },
            })
            return card?.commits ?? []
          },
          { idempotencyKey, bus: context.bus },
        )

        return ok({ commits: value })
      })
    },
  )

  app.put<{ Params: { slug: string; no: string } }>(
    '/boards/:slug/cards/:no/anchor',
    async (request, reply) => {
      const { auth, access } = await board(request, request.params.slug)
      authorizeOn(access, 'card.write')
      const number = parseCardNumber(request.params.no)

      return mutation(context, request, reply, auth, async (idempotencyKey) => {
        const body = parseBody(AnchorSetRequestSchema, request.body)

        const { value } = await mutateBoard(
          db,
          access.board.id,
          { id: auth.user.id, handle: auth.user.handle },
          async (ctx) => {
            const row = await requireCardRow(ctx.tx, access.board.id, access.board.slug, number)

            await ctx.tx
              .delete(anchors)
              .where(and(eq(anchors.cardId, row.id), eq(anchors.primaryAnchor, true)))
            await ctx.tx.insert(anchors).values({
              cardId: row.id,
              path: body.path,
              line: body.line ?? null,
              endLine: body.endLine ?? null,
              commitSha: body.commitSha ?? null,
              primaryAnchor: true,
            })

            await touchCard(ctx.tx, row.id, ctx.now)
            ctx.emit({
              type: 'card.anchor.set',
              cardId: row.id,
              cardNo: number,
              payload: {
                path: body.path,
                line: body.line ?? null,
                ...(body.endLine === undefined ? {} : { endLine: body.endLine }),
                ...(body.commitSha === undefined ? {} : { commitSha: body.commitSha }),
              },
            })

            const card = await loadCard(asQueryable(ctx.tx), access.board.id, number)
            if (card?.anchor == null) throw boardError('internal', 'Anchor vanished after insert')
            return card.anchor
          },
          { idempotencyKey, bus: context.bus },
        )

        return ok(value)
      })
    },
  )

  app.post<{ Params: { slug: string; no: string } }>(
    '/boards/:slug/cards/:no/watch',
    async (request, reply) => {
      const { auth, access } = await board(request, request.params.slug)
      authorizeOn(access, 'watch.write')
      const number = parseCardNumber(request.params.no)

      return mutation(context, request, reply, auth, async (idempotencyKey) => {
        const body = parseBody(WatchRequestSchema, request.body)

        await mutateBoard(
          db,
          access.board.id,
          { id: auth.user.id, handle: auth.user.handle },
          async (ctx) => {
            const row = await requireCardRow(ctx.tx, access.board.id, access.board.slug, number)

            if (body.watching) {
              await ctx.tx
                .insert(watchers)
                .values({ cardId: row.id, userId: auth.user.id })
                .onConflictDoNothing()
            } else {
              await ctx.tx
                .delete(watchers)
                .where(and(eq(watchers.cardId, row.id), eq(watchers.userId, auth.user.id)))
            }

            // Watching is not editing, so the version is left alone — bumping it
            // would make every pending edit to this card conflict. `updatedAt`
            // moves with the event's `ts`, which is what the reducer does.
            await ctx.tx.update(cards).set({ updatedAt: ctx.now }).where(eq(cards.id, row.id))
            const card = await loadCard(asQueryable(ctx.tx), access.board.id, number)
            ctx.emit({
              type: 'card.updated',
              cardId: row.id,
              cardNo: number,
              payload: { fields: { watchers: card?.watchers ?? [] }, version: row.version },
            })
          },
          { idempotencyKey, bus: context.bus },
        )

        return ok({ number, watching: body.watching })
      })
    },
  )
}

/**
 * `If-Match: <version>` optimistic concurrency (SPEC.md §11.4).
 *
 * A mismatch returns 409 carrying the *current* card, so the client can replace
 * its optimistic state without a second round trip.
 */
async function assertVersionMatches(
  ctx: MutationContext,
  access: BoardAccess,
  ifMatch: string | undefined,
  row: CardRow,
  number: number,
): Promise<void> {
  if (ifMatch === undefined) return

  const expected = Number.parseInt(ifMatch.replace(/^(W\/)?"?|"?$/g, ''), 10)
  if (!Number.isInteger(expected)) {
    throw boardError('validation_failed', 'If-Match must be the card version, e.g. `If-Match: 3`')
  }
  if (expected === row.version) return

  const current = await loadCard(asQueryable(ctx.tx), access.board.id, number)
  const conflict = versionConflict(number, expected, row.version)
  throw boardError(conflict.code, conflict.message, {
    details: { ...conflict.details, current: current as unknown as Card },
  })
}
