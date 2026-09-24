/**
 * Database rows -> the domain shapes in `@yuzie/core`.
 *
 * Cards are assembled with a fixed number of queries regardless of how many
 * cards are returned: §10.4 budgets a 2,000-card board, and an N+1 would spend
 * that budget on round trips.
 */
import type {
  Anchor,
  Board,
  Card,
  ChecklistItem,
  Column,
  Comment,
  Commit,
  GitSummary,
  Label,
  Member,
  Priority,
  Role,
  User,
  UserKind,
} from '@yuzie/core'
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import {
  anchors,
  type boards,
  cardAssignees,
  cardLabels,
  cards,
  checklistItems,
  columns,
  comments,
  commits,
  gitLinks,
  labels,
  memberships,
  users,
  watchers,
} from '../db/schema.js'

export function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function toIsoRequired(value: Date | string): string {
  return toIso(value) ?? new Date(0).toISOString()
}

export function toBoard(row: typeof boards.$inferSelect): Board {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    slug: row.slug,
    name: row.name,
    repoRemote: row.repoRemote,
    baseBranch: row.baseBranch,
    branchTemplate: row.branchTemplate,
    nextCardNo: row.nextCardNo,
    archivedAt: toIso(row.archivedAt),
    createdAt: toIsoRequired(row.createdAt),
  }
}

export function toUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    handle: row.handle,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    kind: row.kind as UserKind,
    githubLogin: row.githubLogin,
    createdAt: toIsoRequired(row.createdAt),
  }
}

export function toColumn(row: typeof columns.$inferSelect): Column {
  return {
    id: row.id,
    boardId: row.boardId,
    key: row.key,
    name: row.name,
    rank: row.rank,
    semantics: row.semantics as Column['semantics'],
    wipLimit: row.wipLimit,
  }
}

export function toLabel(row: typeof labels.$inferSelect): Label {
  return { name: row.name, color: row.color }
}

function group<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>()
  for (const row of rows) {
    const id = key(row)
    const bucket = grouped.get(id)
    if (bucket === undefined) grouped.set(id, [row])
    else bucket.push(row)
  }
  return grouped
}

export interface LoadCardsOptions {
  /** Restrict to these card numbers; omitted means the whole board. */
  readonly numbers?: readonly number[]
  readonly includeArchived?: boolean
}

/**
 * Load whole cards, children included, in board order.
 *
 * Eight queries, no matter how many cards come back.
 */
export async function loadCards(
  db: Database,
  boardId: string,
  options: LoadCardsOptions = {},
): Promise<Card[]> {
  const where =
    options.numbers === undefined
      ? eq(cards.boardId, boardId)
      : and(eq(cards.boardId, boardId), inArray(cards.number, [...options.numbers]))

  const cardRows = await db
    .select({ card: cards, columnKey: columns.key })
    .from(cards)
    .innerJoin(columns, eq(cards.columnId, columns.id))
    .where(where)

  if (cardRows.length === 0) return []

  const ids = cardRows.map((row) => row.card.id)

  // Sequential, not Promise.all: inside a transaction every one of these runs on
  // the *same* connection, and concurrent queries on one client are deprecated in
  // node-postgres 8 and removed in 9. Eight round trips to a local database cost
  // far less than the correctness of the transactional read path.
  const assigneeRows = await db
    .select({ cardId: cardAssignees.cardId, handle: users.handle })
    .from(cardAssignees)
    .innerJoin(users, eq(cardAssignees.userId, users.id))
    .where(inArray(cardAssignees.cardId, ids))

  const labelRows = await db
    .select({ cardId: cardLabels.cardId, name: labels.name })
    .from(cardLabels)
    .innerJoin(labels, eq(cardLabels.labelId, labels.id))
    .where(inArray(cardLabels.cardId, ids))

  const watcherRows = await db
    .select({ cardId: watchers.cardId, handle: users.handle })
    .from(watchers)
    .innerJoin(users, eq(watchers.userId, users.id))
    .where(inArray(watchers.cardId, ids))

  const checklistRows = await db
    .select()
    .from(checklistItems)
    .where(inArray(checklistItems.cardId, ids))

  const commentRows = await db
    .select({ comment: comments, handle: users.handle })
    .from(comments)
    .innerJoin(users, eq(comments.authorId, users.id))
    .where(inArray(comments.cardId, ids))

  const commitRows = await db.select().from(commits).where(inArray(commits.cardId, ids))
  const gitRows = await db.select().from(gitLinks).where(inArray(gitLinks.cardId, ids))
  const anchorRows = await db.select().from(anchors).where(inArray(anchors.cardId, ids))

  const assigneesBy = group(assigneeRows, (row) => row.cardId)
  const labelsBy = group(labelRows, (row) => row.cardId)
  const watchersBy = group(watcherRows, (row) => row.cardId)
  const checklistBy = group(checklistRows, (row) => row.cardId)
  const commentsBy = group(commentRows, (row) => row.comment.cardId)
  const commitsBy = group(commitRows, (row) => row.cardId)
  const anchorsBy = group(anchorRows, (row) => row.cardId)
  const gitBy = new Map(gitRows.map((row) => [row.cardId, row]))

  // One more query resolves every user id a card refers to indirectly: who
  // created it, who ticked a checklist item, who authored a linked commit.
  const referencedUserIds = new Set<string>()
  for (const { card } of cardRows) {
    if (card.createdBy !== null) referencedUserIds.add(card.createdBy)
  }
  for (const row of checklistRows) {
    if (row.doneBy !== null) referencedUserIds.add(row.doneBy)
  }
  for (const row of commitRows) {
    if (row.authorId !== null) referencedUserIds.add(row.authorId)
  }

  const handleById = new Map<string, string>()
  if (referencedUserIds.size > 0) {
    const referenced = await db
      .select({ id: users.id, handle: users.handle })
      .from(users)
      .where(inArray(users.id, [...referencedUserIds]))
    for (const row of referenced) handleById.set(row.id, row.handle)
  }

  const handleFor = (id: string | null): string | null =>
    id === null ? null : (handleById.get(id) ?? null)

  const result: Card[] = cardRows.map(({ card, columnKey }) => {
    const checklist: ChecklistItem[] = (checklistBy.get(card.id) ?? [])
      .map((row) => ({
        id: row.id,
        position: row.position,
        text: row.text,
        doneAt: toIso(row.doneAt),
        doneBy: handleFor(row.doneBy),
      }))
      .sort((a, b) => a.position - b.position)

    const cardComments: Comment[] = (commentsBy.get(card.id) ?? [])
      .map(({ comment, handle }) => ({
        id: comment.id,
        cardNumber: card.number,
        author: handle,
        body: comment.body,
        createdAt: toIsoRequired(comment.createdAt),
        editedAt: toIso(comment.editedAt),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

    const cardCommits: Commit[] = (commitsBy.get(card.id) ?? []).map((row) => ({
      sha: row.sha,
      message: row.message,
      author: handleFor(row.authorId),
      committedAt: toIso(row.committedAt),
    }))

    const gitRow = gitBy.get(card.id)
    const git: GitSummary | null =
      gitRow === undefined
        ? null
        : {
            branch: gitRow.branch,
            baseBranch: gitRow.baseBranch,
            commits: gitRow.commitCount,
            filesChanged: gitRow.filesChanged,
            additions: gitRow.additions,
            deletions: gitRow.deletions,
            pushed: gitRow.pushed,
            prUrl: gitRow.prUrl,
            prState: gitRow.prState,
            lastActivityAt: toIso(gitRow.lastActivityAt),
          }

    const anchorRow =
      (anchorsBy.get(card.id) ?? []).find((row) => row.primaryAnchor) ??
      (anchorsBy.get(card.id) ?? [])[0]
    const anchor: Anchor | null =
      anchorRow === undefined
        ? null
        : {
            path: anchorRow.path,
            line: anchorRow.line,
            endLine: anchorRow.endLine,
            commitSha: anchorRow.commitSha,
            primary: anchorRow.primaryAnchor,
          }

    return {
      id: card.id,
      boardId: card.boardId,
      number: card.number,
      column: columnKey,
      rank: card.rank,
      title: card.title,
      description: card.description,
      priority: card.priority as Priority | null,
      dueAt: toIso(card.dueAt),
      assignees: (assigneesBy.get(card.id) ?? []).map((row) => row.handle).sort(),
      labels: (labelsBy.get(card.id) ?? []).map((row) => row.name).sort(),
      watchers: (watchersBy.get(card.id) ?? []).map((row) => row.handle).sort(),
      checklist,
      comments: cardComments,
      commits: cardCommits,
      git,
      anchor,
      createdBy: handleFor(card.createdBy),
      archivedAt: toIso(card.archivedAt),
      createdAt: toIsoRequired(card.createdAt),
      updatedAt: toIsoRequired(card.updatedAt),
      version: card.version,
    }
  })

  // Board order: rank, then card number (SPEC.md §11.4).
  return result.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.number - b.number))
}

export async function loadCard(
  db: Database,
  boardId: string,
  number: number,
): Promise<Card | undefined> {
  const [card] = await loadCards(db, boardId, { numbers: [number] })
  return card
}

export async function loadMembers(db: Database, boardId: string): Promise<Member[]> {
  const rows = await db
    .select({ user: users, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.boardId, boardId))

  return rows
    .map(({ user, role }) => ({
      handle: user.handle,
      displayName: user.displayName,
      kind: user.kind as UserKind,
      role: role as Role,
      lastSeenAt: null,
    }))
    .sort((a, b) => a.handle.localeCompare(b.handle))
}
