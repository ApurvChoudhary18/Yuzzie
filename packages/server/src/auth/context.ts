/**
 * Turning a bearer token into an actor with a role on a board.
 *
 * Every query in the routes is scoped by what this returns; §14.1 requires that
 * no board is reachable without a membership, so there is no "public" path here
 * to forget to guard.
 */
import { boardError, type Role, type UserKind } from '@yuzie/core'
import { and, eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { apiTokens, boards, memberships, users } from '../db/schema.js'
import { type Action, type Actor, authorize } from './permissions.js'
import { hashToken } from './tokens.js'

export type UserRow = typeof users.$inferSelect
export type BoardRow = typeof boards.$inferSelect
export type TokenRow = typeof apiTokens.$inferSelect

export interface Authenticated {
  readonly user: UserRow
  readonly token: TokenRow
}

export interface BoardAccess {
  readonly board: BoardRow
  readonly role: Role
  readonly user: UserRow
  readonly actor: Actor
}

function bearerFrom(header: string | undefined): string {
  if (header === undefined || header.length === 0) {
    throw boardError('unauthenticated', 'No credentials. Run `yuzie login`.')
  }
  const [scheme, value] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value.length === 0) {
    throw boardError('unauthenticated', 'Authorization must be `Bearer <token>`.')
  }
  return value
}

export async function authenticate(
  db: Database,
  authorizationHeader: string | undefined,
  now: Date = new Date(),
): Promise<Authenticated> {
  const presented = bearerFrom(authorizationHeader)

  // The stored value is a sha256 of the token, so this is an indexed lookup on
  // the hash rather than a scan comparing secrets (§14.1).
  const [row] = await db
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.userId, users.id))
    .where(eq(apiTokens.tokenHash, hashToken(presented)))

  if (row === undefined) {
    throw boardError('unauthenticated', 'That token is not valid. Run `yuzie login`.')
  }
  if (row.token.revokedAt !== null) {
    throw boardError('unauthenticated', 'That token has been revoked. Run `yuzie login`.')
  }
  if (row.token.expiresAt !== null && row.token.expiresAt.getTime() <= now.getTime()) {
    throw boardError('unauthenticated', 'That token has expired. Run `yuzie login`.')
  }

  return { user: row.user, token: row.token }
}

/**
 * Resolve a board the caller is a member of, and their role on it.
 *
 * A board the caller cannot see reports `board_not_found` rather than
 * `forbidden`, so membership cannot be probed by watching status codes.
 */
export async function resolveBoard(
  db: Database,
  auth: Authenticated,
  slug: string,
): Promise<BoardAccess> {
  const [board] = await db.select().from(boards).where(eq(boards.slug, slug))
  if (board === undefined) {
    throw boardError('board_not_found', `Board ${slug} does not exist or you are not a member`, {
      details: { boardSlug: slug },
    })
  }

  // A board-scoped token may not reach any other board (§14.1).
  if (auth.token.boardId !== null && auth.token.boardId !== board.id) {
    throw boardError(
      'forbidden',
      `This token is scoped to a different board and cannot access ${slug}`,
      { details: { boardSlug: slug } },
    )
  }

  const [membership] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.boardId, board.id), eq(memberships.userId, auth.user.id)))

  if (membership === undefined) {
    throw boardError('board_not_found', `Board ${slug} does not exist or you are not a member`, {
      details: { boardSlug: slug },
    })
  }

  // The token's role can only narrow the membership role, never widen it: a
  // member's CI token must not become an owner (§14.1).
  const role = narrowestRole(membership.role as Role, auth.token.role as Role)

  return {
    board,
    role,
    user: auth.user,
    actor: { role, kind: auth.user.kind as UserKind },
  }
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, owner: 2 }

export function narrowestRole(a: Role, b: Role): Role {
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b
}

/** Authorize `action` on a board, optionally for a card the actor may own. */
export function authorizeOn(access: BoardAccess, action: Action, ownsCard?: boolean): void {
  authorize(action, {
    ...access.actor,
    ...(ownsCard === undefined ? {} : { ownsCard }),
  })
}
