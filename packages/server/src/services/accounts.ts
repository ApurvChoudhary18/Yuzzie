/**
 * Deleting an account (SPEC.md §14.3: "account deletion removes all rows
 * within 30 days").
 *
 * Deletion happens in two steps:
 * - **At once:** the account is marked deleted, every token it holds is
 *   revoked, and it can never sign in again.
 * - **After the grace period:** the purge sweep removes the user row and every
 *   row that is theirs (memberships, assignments, watches, comments, tokens,
 *   pending logins). It also clears their name from what stays on the boards:
 *   who created a card, who ticked an item, who made a commit, who did what in
 *   the activity log.
 */
import { boardError } from '@yuzie/core'
import { and, eq, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import {
  apiTokens,
  boards,
  cards,
  checklistItems,
  comments,
  commits,
  deviceCodes,
  events,
  memberships,
  users,
} from '../db/schema.js'

/** §14.3. */
export const ACCOUNT_PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

/** Boards the user is the only owner of, which would be left with nobody in charge. */
export async function boardsOnlyOwnedBy(db: Database, userId: string): Promise<string[]> {
  const owned = await db
    .select({ id: boards.id, slug: boards.slug })
    .from(memberships)
    .innerJoin(boards, eq(memberships.boardId, boards.id))
    .where(
      and(eq(memberships.userId, userId), eq(memberships.role, 'owner'), isNull(boards.archivedAt)),
    )
  const alone: string[] = []
  for (const board of owned) {
    const [other] = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(
        and(
          eq(memberships.boardId, board.id),
          eq(memberships.role, 'owner'),
          ne(memberships.userId, userId),
          isNull(users.deletedAt),
        ),
      )
      .limit(1)
    if (other === undefined) alone.push(board.slug)
  }
  return alone.sort()
}

/** Mark the account deleted and revoke its tokens. Returns when it will be purged. */
export async function deleteAccount(
  db: Database,
  userId: string,
  now: Date = new Date(),
  purgeAfterMs: number = ACCOUNT_PURGE_AFTER_MS,
): Promise<{ deletedAt: Date; purgeBy: Date }> {
  const alone = await boardsOnlyOwnedBy(db, userId)
  if (alone.length > 0) {
    const list = alone.join(', ')
    throw boardError(
      'validation_failed',
      `You are the only owner of ${list}. Make someone else an owner (\`yuzie invite @them --role owner\`) or archive ${alone.length === 1 ? 'it' : 'them'} (\`yuzie boards archive <slug>\`) first.`,
      { details: { boards: alone } },
    )
  }
  await db.transaction(async (tx) => {
    await tx.update(users).set({ deletedAt: now }).where(eq(users.id, userId))
    await tx
      .update(apiTokens)
      .set({ revokedAt: now })
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    await tx.delete(deviceCodes).where(eq(deviceCodes.userId, userId))
  })
  return { deletedAt: now, purgeBy: new Date(now.getTime() + purgeAfterMs) }
}

/**
 * Remove every account deleted at least `purgeAfterMs` ago, and everything that
 * names it. Returns the handles purged. Safe to run at any time, and repeatedly.
 */
export async function purgeDeletedAccounts(
  db: Database,
  now: Date = new Date(),
  purgeAfterMs: number = ACCOUNT_PURGE_AFTER_MS,
): Promise<string[]> {
  const due = await db
    .select({ id: users.id, handle: users.handle })
    .from(users)
    .where(
      and(isNotNull(users.deletedAt), lte(users.deletedAt, new Date(now.getTime() - purgeAfterMs))),
    )
  if (due.length === 0) return []
  const ids = due.map((user) => user.id)

  await db.transaction(async (tx) => {
    // What stays on the boards keeps its content and loses its author.
    await tx.update(cards).set({ createdBy: null }).where(inArray(cards.createdBy, ids))
    await tx.update(checklistItems).set({ doneBy: null }).where(inArray(checklistItems.doneBy, ids))
    await tx.update(commits).set({ authorId: null }).where(inArray(commits.authorId, ids))
    await tx.update(events).set({ actorId: null }).where(inArray(events.actorId, ids))
    await tx.update(apiTokens).set({ createdBy: null }).where(inArray(apiTokens.createdBy, ids))
    // What was theirs goes. Memberships, assignments, watches, tokens, logins and
    // idempotency keys go with the user row (ON DELETE CASCADE); comments do not.
    await tx.delete(comments).where(inArray(comments.authorId, ids))
    await tx.delete(users).where(inArray(users.id, ids))
  })
  return due.map((user) => user.handle).sort()
}
