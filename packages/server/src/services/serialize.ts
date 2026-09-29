/**
 * Database rows -> the domain shapes in `@yuzie/core`.
 *
 * Cards are assembled in one query regardless of how many cards are returned:
 * §10.4 budgets a 2,000-card board and 100 writes a second, and every round
 * trip is spent on both.
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
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { type boards, type columns, type labels, memberships, users } from '../db/schema.js'

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
    autoWatch: row.autoWatch,
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

export interface LoadCardsOptions {
  /** Restrict to these card numbers; omitted means the whole board. */
  readonly numbers?: readonly number[]
  readonly includeArchived?: boolean
}

/** A timestamp exactly as `Date#toISOString` writes it, from inside Postgres. */
const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

/**
 * Every card field and child in one statement: a correlated, JSON-aggregating
 * subquery per kind of child. Each is an index lookup by card, so the cost
 * stays with the rows returned, and it is one round trip (§18 Session 16:
 * reloading a card used to be ten, which capped writes to one board below
 * the 100 a second §10.4 asks for).
 */
const CARD_SELECT = `
SELECT
  c.id, c.board_id, c.number, col.key AS column_key, c.rank, c.title, c.description,
  c.priority, c.due_at, c.archived_at, c.created_at, c.updated_at, c.version,
  creator.handle AS created_by,
  (SELECT coalesce(json_agg(u.handle), '[]')
     FROM card_assignees a JOIN users u ON u.id = a.user_id WHERE a.card_id = c.id) AS assignees,
  (SELECT coalesce(json_agg(l.name), '[]')
     FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = c.id) AS labels,
  (SELECT coalesce(json_agg(u.handle), '[]')
     FROM watchers w JOIN users u ON u.id = w.user_id WHERE w.card_id = c.id) AS watchers,
  (SELECT coalesce(json_agg(json_build_object(
            'id', i.id, 'position', i.position, 'text', i.text,
            'doneAt', ${iso('i.done_at')}, 'doneBy', du.handle) ORDER BY i.position), '[]')
     FROM checklist_items i LEFT JOIN users du ON du.id = i.done_by WHERE i.card_id = c.id) AS checklist,
  (SELECT coalesce(json_agg(json_build_object(
            'id', m.id, 'author', mu.handle, 'body', m.body,
            'createdAt', ${iso('m.created_at')}, 'editedAt', ${iso('m.edited_at')})
            ORDER BY m.created_at, m.id), '[]')
     FROM comments m JOIN users mu ON mu.id = m.author_id WHERE m.card_id = c.id) AS comments,
  (SELECT coalesce(json_agg(json_build_object(
            'sha', k.sha, 'message', k.message, 'author', ku.handle,
            'committedAt', ${iso('k.committed_at')})
            ORDER BY k.committed_at NULLS LAST, k.sha), '[]')
     FROM commits k LEFT JOIN users ku ON ku.id = k.author_id WHERE k.card_id = c.id) AS commits,
  (SELECT json_build_object(
            'branch', g.branch, 'baseBranch', g.base_branch, 'commits', g.commit_count,
            'filesChanged', g.files_changed, 'additions', g.additions, 'deletions', g.deletions,
            'pushed', g.pushed, 'prUrl', g.pr_url, 'prState', g.pr_state,
            'lastActivityAt', ${iso('g.last_activity_at')})
     FROM git_links g WHERE g.card_id = c.id) AS git,
  (SELECT json_build_object(
            'path', n.path, 'line', n.line, 'endLine', n.end_line,
            'commitSha', n.commit_sha, 'primary', n.primary_anchor)
     FROM anchors n WHERE n.card_id = c.id ORDER BY n.primary_anchor DESC LIMIT 1) AS anchor
FROM cards c
JOIN columns col ON col.id = c.column_id
LEFT JOIN users creator ON creator.id = c.created_by`

interface CardSqlRow {
  id: string
  board_id: string
  number: number
  column_key: string
  rank: string
  title: string
  description: string | null
  priority: number | null
  due_at: Date | null
  archived_at: Date | null
  created_at: Date
  updated_at: Date
  version: number
  created_by: string | null
  assignees: string[]
  labels: string[]
  watchers: string[]
  checklist: ChecklistItem[]
  comments: Array<Omit<Comment, 'cardNumber'>>
  commits: Commit[]
  git: GitSummary | null
  anchor: Anchor | null
}

/**
 * Load whole cards, children included, in board order — in one query, however
 * many cards come back.
 */
export async function loadCards(
  db: Database,
  boardId: string,
  options: LoadCardsOptions = {},
): Promise<Card[]> {
  const numbers = options.numbers
  if (numbers !== undefined && numbers.length === 0) return []
  const only =
    numbers === undefined
      ? sql``
      : sql` AND c.number IN (${sql.join(
          numbers.map((number) => sql`${number}`),
          sql`, `,
        )})`
  const result = await db.execute<CardSqlRow & Record<string, unknown>>(
    sql`${sql.raw(CARD_SELECT)} WHERE c.board_id = ${boardId}${only}`,
  )
  const cardsOut: Card[] = result.rows.map((row) => ({
    id: row.id,
    boardId: row.board_id,
    number: row.number,
    column: row.column_key,
    rank: row.rank,
    title: row.title,
    description: row.description,
    priority: row.priority as Priority | null,
    dueAt: toIso(row.due_at),
    // Sorted here, not by Postgres, so the order never depends on a collation.
    assignees: [...row.assignees].sort(),
    labels: [...row.labels].sort(),
    watchers: [...row.watchers].sort(),
    checklist: row.checklist,
    comments: row.comments.map((comment) => ({ ...comment, cardNumber: row.number })),
    commits: row.commits,
    git: row.git,
    anchor: row.anchor,
    createdBy: row.created_by,
    archivedAt: toIso(row.archived_at),
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIsoRequired(row.updated_at),
    version: row.version,
  }))
  // Board order: rank, then card number (SPEC.md §11.4).
  return cardsOut.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.number - b.number))
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
