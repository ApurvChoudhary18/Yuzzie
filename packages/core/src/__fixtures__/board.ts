/**
 * Shared fixtures. Every value here is a *valid* domain object, so a test that
 * wants an invalid one has to say so explicitly and the reader can see why.
 */
import type { EventEnvelope, EventType } from '../events.js'
import type { BoardState } from '../reducer.js'
import { initialState } from '../reducer.js'
import type { Board, Card, ChecklistItem, Column, Member } from '../types.js'

export const BOARD_ID = '11111111-1111-4111-8111-111111111111'
export const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
export const CARD_ID = '33333333-3333-4333-8333-333333333333'
export const ITEM_ID = '44444444-4444-4444-8444-444444444444'
export const COMMENT_ID = '55555555-5555-4555-8555-555555555555'
export const T0 = '2026-08-19T09:00:00Z'
export const T1 = '2026-08-19T09:14:22Z'

export function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: BOARD_ID,
    workspaceId: WORKSPACE_ID,
    slug: 'payments-api',
    name: 'payments-api',
    repoRemote: 'github.com/acme/payments-api',
    baseBranch: 'main',
    branchTemplate: 'task/{id}-{slug}',
    nextCardNo: 19,
    archivedAt: null,
    createdAt: T0,
    ...overrides,
  }
}

/** A deterministic hex tail so fixture ids are stable *and* valid UUIDs. */
function hex12(seed: string): string {
  let hash = 0
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return hash.toString(16).padStart(12, '0').slice(-12)
}

export function makeColumn(key: string, rank: string, overrides: Partial<Column> = {}): Column {
  return {
    id: `66666666-6666-4666-8666-${hex12(key)}`,
    boardId: BOARD_ID,
    key,
    name: key.charAt(0).toUpperCase() + key.slice(1),
    rank,
    semantics: null,
    wipLimit: null,
    ...overrides,
  }
}

export function makeChecklistItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    id: ITEM_ID,
    position: 1,
    text: 'Fix callback state handling',
    doneAt: null,
    doneBy: null,
    ...overrides,
  }
}

export function makeMember(handle: string, overrides: Partial<Member> = {}): Member {
  return {
    handle,
    displayName: null,
    kind: 'human',
    role: 'member',
    lastSeenAt: null,
    ...overrides,
  }
}

export function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: CARD_ID,
    boardId: BOARD_ID,
    number: 18,
    column: 'doing',
    rank: 'V',
    title: 'Fix GitHub OAuth',
    description: 'OAuth callback drops the state param on redirect.',
    priority: 1,
    dueAt: null,
    assignees: ['rahul'],
    labels: ['bug', 'auth'],
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

export function stateWithCard(card: Card = makeCard(), seq = 0): BoardState {
  return initialState({ cards: { [card.number]: card }, seq })
}

/** Build any event without restating the envelope fields in every test. */
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
    // The cast is safe by construction: `payload` is already constrained to the
    // payload of `TType`, but TypeScript cannot relate the two sides of a
    // discriminated union through a generic parameter.
  } as EventEnvelope
}
