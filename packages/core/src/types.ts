/**
 * Domain types for Yuzie (SPEC.md §11.1).
 *
 * These describe the domain as the API exposes it, not as Postgres stores it.
 * Two deliberate differences from the SQL in §11.2:
 *
 *   - A card references its column by `key` ("doing"), not by uuid. Every event
 *     payload and every JSON body in the spec speaks in column keys (§7.3, §12.2),
 *     and the server maps key <-> uuid at its own boundary.
 *   - People are referenced by handle ("rahul"), not by uuid, for the same reason.
 *
 * Absent values are always `null`, never `undefined`, so a parsed JSON body and a
 * locally constructed value have the same shape.
 */

/** A v4 UUID as produced by {@link newId}. */
export type Uuid = string
/** A user or agent handle, without the leading `@`. */
export type Handle = string
/** An RFC 3339 / ISO 8601 timestamp in UTC. */
export type IsoDateTime = string
/** A lexicographic fractional index (see `rank.ts`). */
export type Rank = string

export type Role = 'owner' | 'member' | 'viewer'
export const ROLES = ['owner', 'member', 'viewer'] as const satisfies readonly Role[]

export type UserKind = 'human' | 'agent'
export const USER_KINDS = ['human', 'agent'] as const satisfies readonly UserKind[]

/** Drives `claim` and `finish` column selection (SPEC.md §9.3, §9.4). */
export type ColumnSemantics = 'backlog' | 'in_progress' | 'review' | 'terminal'
export const COLUMN_SEMANTICS = [
  'backlog',
  'in_progress',
  'review',
  'terminal',
] as const satisfies readonly ColumnSemantics[]

/** p0 is the most urgent (SPEC.md §7.2 `yuzie priority <id> <p0..p3>`). */
export type Priority = 0 | 1 | 2 | 3
export const PRIORITIES = [0, 1, 2, 3] as const satisfies readonly Priority[]

export type PresenceState = 'online' | 'viewing' | 'working'
export const PRESENCE_STATES = [
  'online',
  'viewing',
  'working',
] as const satisfies readonly PresenceState[]

export interface User {
  readonly id: Uuid
  readonly handle: Handle
  readonly email: string | null
  readonly displayName: string | null
  readonly avatarUrl: string | null
  readonly kind: UserKind
  readonly githubLogin: string | null
  readonly createdAt: IsoDateTime
}

export interface Workspace {
  readonly id: Uuid
  readonly slug: string
  readonly name: string
  readonly createdAt: IsoDateTime
}

export interface Board {
  readonly id: Uuid
  readonly workspaceId: Uuid
  readonly slug: string
  readonly name: string
  /** e.g. `github.com/acme/payments-api`. */
  readonly repoRemote: string | null
  readonly baseBranch: string
  readonly branchTemplate: string
  readonly nextCardNo: number
  readonly archivedAt: IsoDateTime | null
  readonly createdAt: IsoDateTime
}

export interface Membership {
  readonly boardId: Uuid
  readonly userId: Uuid
  readonly role: Role
  readonly createdAt: IsoDateTime
}

/** A board member as rendered by `yuzie members` (SPEC.md §7.2). */
export interface Member {
  readonly handle: Handle
  readonly displayName: string | null
  readonly kind: UserKind
  readonly role: Role
  readonly lastSeenAt: IsoDateTime | null
}

export interface Column {
  readonly id: Uuid
  readonly boardId: Uuid
  /** Stable identifier used everywhere in the API: `todo`, `doing`, … */
  readonly key: string
  readonly name: string
  readonly rank: Rank
  readonly semantics: ColumnSemantics | null
  readonly wipLimit: number | null
}

export interface Label {
  readonly name: string
  readonly color: string | null
}

export interface ChecklistItem {
  readonly id: Uuid
  /** 1-based, matching the `n` a user types in `yuzie check <id> <n>`. */
  readonly position: number
  readonly text: string
  readonly doneAt: IsoDateTime | null
  readonly doneBy: Handle | null
}

export interface Comment {
  readonly id: Uuid
  readonly cardNumber: number
  readonly author: Handle
  readonly body: string
  readonly createdAt: IsoDateTime
  readonly editedAt: IsoDateTime | null
}

/** Derived on the client from the repo and pushed to the server (SPEC.md §9.1). */
export interface GitSummary {
  readonly branch: string | null
  readonly baseBranch: string | null
  readonly commits: number
  readonly filesChanged: number
  readonly additions: number
  readonly deletions: number
  readonly pushed: boolean
  readonly prUrl: string | null
  readonly prState: string | null
  readonly lastActivityAt: IsoDateTime | null
}

export interface Commit {
  readonly sha: string
  readonly message: string | null
  readonly author: Handle | null
  readonly committedAt: IsoDateTime | null
}

/** A `file:line` reference stored on a card (SPEC.md §9.7). */
export interface Anchor {
  readonly path: string
  readonly line: number | null
  readonly endLine: number | null
  /** The commit the anchor was created at, used for staleness detection. */
  readonly commitSha: string | null
  readonly primary: boolean
}

/**
 * The list fields are `readonly` as properties but hold mutable array types, so a
 * `Card` and a `CardSchema.parse(...)` result are the same type in both directions.
 * Immutability of board state is upheld by the reducer, which never writes in place.
 */
export interface Card {
  readonly id: Uuid
  readonly boardId: Uuid
  /** The `#18` users type. Unique per board, monotonic. */
  readonly number: number
  readonly column: string
  readonly rank: Rank
  readonly title: string
  readonly description: string | null
  readonly priority: Priority | null
  readonly dueAt: IsoDateTime | null
  readonly assignees: Handle[]
  readonly labels: string[]
  readonly watchers: Handle[]
  readonly checklist: ChecklistItem[]
  readonly comments: Comment[]
  readonly commits: Commit[]
  readonly git: GitSummary | null
  readonly anchor: Anchor | null
  readonly createdBy: Handle | null
  readonly archivedAt: IsoDateTime | null
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
  /** Bumped by the server on every mutation; the basis of `If-Match` (§11.4). */
  readonly version: number
}

/** Transient; never written to the event log (SPEC.md §12.3). */
export interface Presence {
  readonly handle: Handle
  readonly kind: UserKind
  readonly state: PresenceState
  readonly cardNo: number | null
  readonly branch: string | null
  readonly since: IsoDateTime | null
}

/** Never carries the plaintext token; that is shown exactly once at creation (§13.3). */
export interface ApiToken {
  readonly id: Uuid
  readonly name: string
  readonly role: Role
  readonly boardSlug: string | null
  readonly lastUsedAt: IsoDateTime | null
  readonly expiresAt: IsoDateTime | null
  readonly revokedAt: IsoDateTime | null
  readonly createdAt: IsoDateTime
}
