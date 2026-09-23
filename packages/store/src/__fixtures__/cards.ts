import type {
  Card,
  ChecklistItem,
  Column,
  Comment,
  EventEnvelope,
  EventType,
  GitSummary,
} from '@yuzie/core'

export const BOARD = 'payments-api'
export const BOARD_ID = '11111111-1111-4111-8111-111111111111'
export const T0 = '2026-08-19T09:00:00Z'
export const T1 = '2026-08-19T09:14:22Z'

let counter = 0
function uuid(): string {
  counter += 1
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
}

export function resetIds(): void {
  counter = 0
}

export function makeComment(cardNumber: number, overrides: Partial<Comment> = {}): Comment {
  return {
    id: uuid(),
    cardNumber,
    author: 'rahul',
    body: 'Callback was dropping the state param.',
    createdAt: T1,
    editedAt: null,
    ...overrides,
  }
}

export function makeChecklistItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    id: uuid(),
    position: 1,
    text: 'Fix callback state handling',
    doneAt: null,
    doneBy: null,
    ...overrides,
  }
}

export function makeGit(overrides: Partial<GitSummary> = {}): GitSummary {
  return {
    branch: 'task/18-fix-github-oauth',
    baseBranch: 'main',
    commits: 3,
    filesChanged: 7,
    additions: 120,
    deletions: 14,
    pushed: true,
    prUrl: 'https://github.com/acme/payments-api/pull/204',
    prState: 'open',
    lastActivityAt: T1,
    ...overrides,
  }
}

export function makeColumn(key: string, rank: string, overrides: Partial<Column> = {}): Column {
  return {
    id: uuid(),
    boardId: BOARD_ID,
    key,
    name: key.charAt(0).toUpperCase() + key.slice(1),
    rank,
    semantics: null,
    wipLimit: null,
    ...overrides,
  }
}

export function makeCard(number: number, overrides: Partial<Card> = {}): Card {
  return {
    id: uuid(),
    boardId: BOARD_ID,
    number,
    column: 'doing',
    rank: 'V',
    title: `Card ${number}`,
    description: null,
    priority: null,
    dueAt: null,
    assignees: [],
    labels: [],
    watchers: [],
    checklist: [],
    comments: [],
    commits: [],
    git: null,
    anchor: null,
    createdBy: 'rahul',
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
    ...overrides,
  }
}

/** A card with every optional part populated, for round-trip tests. */
export function makeFullCard(number = 18): Card {
  return makeCard(number, {
    column: 'doing',
    rank: 'V',
    title: 'Fix GitHub OAuth',
    description: 'OAuth callback drops the state param on redirect.',
    priority: 1,
    dueAt: '2026-08-21T17:00:00Z',
    assignees: ['rahul', 'claude'],
    labels: ['bug', 'auth'],
    watchers: ['priya'],
    checklist: [
      makeChecklistItem({ position: 1 }),
      makeChecklistItem({ position: 2, doneAt: T1, doneBy: 'rahul' }),
    ],
    comments: [makeComment(number)],
    commits: [{ sha: 'a3f9c21', message: 'fix: oauth state', author: 'rahul', committedAt: T1 }],
    git: makeGit(),
    anchor: {
      path: 'src/auth/oauth.ts',
      line: 42,
      endLine: 88,
      commitSha: 'a3f9c21',
      primary: true,
    },
    version: 4,
  })
}

export function makeEvent<TType extends EventType>(
  type: TType,
  seq: number,
  payload: Extract<EventEnvelope, { type: TType }>['payload'],
  extra: { cardNo?: number; actor?: string | null; ts?: string } = {},
): EventEnvelope {
  return {
    type,
    seq,
    actor: extra.actor === undefined ? 'rahul' : extra.actor,
    cardNo: extra.cardNo ?? 18,
    ts: extra.ts ?? T1,
    payload,
    // Safe by construction: `payload` is already constrained to this type's
    // payload, but TypeScript cannot relate both sides of a discriminated union
    // through a generic parameter.
  } as EventEnvelope
}
