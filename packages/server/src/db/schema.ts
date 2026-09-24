/**
 * Drizzle's view of the Postgres schema (SPEC.md §11.2).
 *
 * The tables are created by the hand-written SQL in `migrations/postgres`, which
 * is the source of truth — §10.3 calls for SQL-first migrations. This file only
 * describes those tables so queries are typed.
 */
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  handle: text('handle').notNull().unique(),
  email: text('email').unique(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  kind: text('kind').notNull().default('human'),
  githubLogin: text('github_login'),
  createdAt: createdAt(),
})

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: createdAt(),
})

export const boards = pgTable(
  'boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    repoRemote: text('repo_remote'),
    baseBranch: text('base_branch').notNull().default('main'),
    branchTemplate: text('branch_template').notNull().default('task/{id}-{slug}'),
    nextCardNo: integer('next_card_no').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('boards_slug_key').on(table.slug)],
)

export const memberships = pgTable(
  'memberships',
  {
    boardId: uuid('board_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.boardId, table.userId] })],
)

export const columns = pgTable(
  'columns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id').notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    rank: text('rank').notNull(),
    semantics: text('semantics'),
    wipLimit: integer('wip_limit'),
  },
  (table) => [uniqueIndex('columns_board_key').on(table.boardId, table.key)],
)

export const cards = pgTable(
  'cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id').notNull(),
    number: integer('number').notNull(),
    columnId: uuid('column_id').notNull(),
    rank: text('rank').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    priority: smallint('priority'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('cards_board_number').on(table.boardId, table.number),
    index('cards_board_column_rank').on(table.boardId, table.columnId, table.rank),
  ],
)

export const cardAssignees = pgTable(
  'card_assignees',
  {
    cardId: uuid('card_id').notNull(),
    userId: uuid('user_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.cardId, table.userId] })],
)

export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    boardId: uuid('board_id').notNull(),
    name: text('name').notNull(),
    color: text('color'),
  },
  (table) => [uniqueIndex('labels_board_name').on(table.boardId, table.name)],
)

export const cardLabels = pgTable(
  'card_labels',
  {
    cardId: uuid('card_id').notNull(),
    labelId: uuid('label_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.cardId, table.labelId] })],
)

export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').notNull(),
  authorId: uuid('author_id').notNull(),
  body: text('body').notNull(),
  createdAt: createdAt(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
})

export const checklistItems = pgTable('checklist_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').notNull(),
  position: integer('position').notNull(),
  text: text('text').notNull(),
  doneAt: timestamp('done_at', { withTimezone: true }),
  doneBy: uuid('done_by'),
})

export const watchers = pgTable(
  'watchers',
  {
    cardId: uuid('card_id').notNull(),
    userId: uuid('user_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.cardId, table.userId] })],
)

export const gitLinks = pgTable('git_links', {
  cardId: uuid('card_id').primaryKey(),
  branch: text('branch'),
  baseBranch: text('base_branch'),
  commitCount: integer('commit_count').notNull().default(0),
  filesChanged: integer('files_changed').notNull().default(0),
  additions: integer('additions').notNull().default(0),
  deletions: integer('deletions').notNull().default(0),
  pushed: boolean('pushed').notNull().default(false),
  prUrl: text('pr_url'),
  prState: text('pr_state'),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const commits = pgTable(
  'commits',
  {
    sha: text('sha').notNull(),
    cardId: uuid('card_id').notNull(),
    authorId: uuid('author_id'),
    message: text('message'),
    committedAt: timestamp('committed_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.cardId, table.sha] })],
)

export const anchors = pgTable('anchors', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id').notNull(),
  path: text('path').notNull(),
  line: integer('line'),
  endLine: integer('end_line'),
  commitSha: text('commit_sha'),
  primaryAnchor: boolean('primary_anchor').notNull().default(false),
})

export const events = pgTable(
  'events',
  {
    boardId: uuid('board_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    id: uuid('id').notNull(),
    type: text('type').notNull(),
    actorId: uuid('actor_id'),
    cardId: uuid('card_id'),
    cardNo: integer('card_no'),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
    idempotencyKey: text('idempotency_key'),
  },
  (table) => [primaryKey({ columns: [table.boardId, table.seq] })],
)

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  boardId: uuid('board_id'),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  role: text('role').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export const deviceCodes = pgTable('device_codes', {
  deviceCode: text('device_code').primaryKey(),
  userCode: text('user_code').notNull().unique(),
  userId: uuid('user_id'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
})

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    userId: uuid('user_id').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    status: integer('status'),
    response: jsonb('response'),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.key, table.userId] })],
)

export const schema = {
  users,
  workspaces,
  boards,
  memberships,
  columns,
  cards,
  cardAssignees,
  labels,
  cardLabels,
  comments,
  checklistItems,
  watchers,
  gitLinks,
  commits,
  anchors,
  events,
  apiTokens,
  deviceCodes,
  idempotencyKeys,
}
