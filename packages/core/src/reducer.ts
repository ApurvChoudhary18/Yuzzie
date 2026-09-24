/**
 * The pure projection from an event log to board state (SPEC.md §18 Session 1).
 *
 * Properties this module guarantees, because the SDK, the TUI, and the local
 * cache all depend on them:
 *
 *   - **Pure.** No I/O, no clock, no randomness. Timestamps come from the event.
 *   - **Immutable.** Inputs are never mutated; a new state is returned.
 *   - **Total.** An event this version does not understand advances `seq` and
 *     changes nothing else. It is never thrown on, because a client running an
 *     older build must still stay in sync with a newer server.
 *   - **Order-insensitive.** `seq` totally orders the log, so {@link applyEvents}
 *     sorts before folding and ignores anything already applied. Replaying a
 *     shuffled window converges on the same state.
 */
import { compareEvents, type EventEnvelope } from './events.js'
import { compareRanks } from './rank.js'
import type { Board, Card, Column, Commit, GitSummary, Label, Member } from './types.js'

export interface BoardState {
  readonly board: Board | null
  readonly columns: readonly Column[]
  readonly labels: readonly Label[]
  readonly members: readonly Member[]
  /** Keyed by the `#18` card number, which is unique per board. */
  readonly cards: Readonly<Record<number, Card>>
  /** The highest event sequence folded into this state. */
  readonly seq: number
}

const EMPTY_STATE: BoardState = {
  board: null,
  columns: [],
  labels: [],
  members: [],
  cards: {},
  seq: 0,
}

export function initialState(seed: Partial<BoardState> = {}): BoardState {
  return { ...EMPTY_STATE, ...seed }
}

const EMPTY_GIT: GitSummary = {
  branch: null,
  baseBranch: null,
  commits: 0,
  filesChanged: 0,
  additions: 0,
  deletions: 0,
  pushed: false,
  prUrl: null,
  prState: null,
  lastActivityAt: null,
}

/** Drop `undefined` values so a spread never blanks a field the event omitted. */
function defined<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out as Partial<T>
}

function withCard(state: BoardState, number: number, update: (card: Card) => Card): BoardState {
  const card = state.cards[number]
  // An event for a card we have never seen is ignored rather than synthesised:
  // a partial card would render as a real one.
  if (card === undefined) return state

  const updated = update(card)
  if (updated === card) return state
  return { ...state, cards: { ...state.cards, [number]: updated } }
}

function reduce(state: BoardState, event: EventEnvelope): BoardState {
  switch (event.type) {
    case 'card.created': {
      const card = event.payload
      return { ...state, cards: { ...state.cards, [card.number]: card } }
    }

    case 'card.updated':
      return withCard(state, event.cardNo, (card) => ({
        ...card,
        ...defined(event.payload.fields),
        version: event.payload.version,
        updatedAt: event.ts,
      }))

    case 'card.moved':
      return withCard(state, event.cardNo, (card) => ({
        ...card,
        column: event.payload.to,
        rank: event.payload.rank,
        updatedAt: event.ts,
      }))

    case 'card.assigned':
      return withCard(state, event.cardNo, (card) => {
        const { added, removed } = event.payload
        const kept = card.assignees.filter((handle) => !removed.includes(handle))
        const appended = added.filter((handle) => !kept.includes(handle))
        // Assignees are a set, kept in handle order: the server stores no order
        // and returns them sorted, so folding events must land on the same array
        // a snapshot would, or two clients would disagree about one card.
        return { ...card, assignees: [...kept, ...appended].sort(), updatedAt: event.ts }
      })

    case 'card.deleted': {
      const { [event.payload.number]: deleted, ...remaining } = state.cards
      if (deleted === undefined) return state
      return { ...state, cards: remaining }
    }

    case 'comment.created':
      return withCard(state, event.cardNo, (card) => {
        if (card.comments.some((comment) => comment.id === event.payload.commentId)) return card
        return {
          ...card,
          comments: [
            ...card.comments,
            {
              id: event.payload.commentId,
              cardNumber: event.cardNo,
              author: event.payload.author,
              body: event.payload.body,
              createdAt: event.ts,
              editedAt: null,
            },
          ],
        }
      })

    case 'checklist.updated':
      return withCard(state, event.cardNo, (card) => ({
        ...card,
        checklist: card.checklist.map((item) =>
          item.id === event.payload.itemId
            ? {
                ...item,
                doneAt: event.payload.done ? event.ts : null,
                doneBy: event.payload.done ? event.actor : null,
              }
            : item,
        ),
        updatedAt: event.ts,
      }))

    case 'card.branch.linked':
      return withCard(state, event.cardNo, (card) => ({
        ...card,
        git: {
          ...(card.git ?? EMPTY_GIT),
          branch: event.payload.branch,
          baseBranch: event.payload.base,
        },
        updatedAt: event.ts,
      }))

    case 'card.git.updated':
      return withCard(state, event.cardNo, (card) => ({
        ...card,
        git: {
          ...(card.git ?? EMPTY_GIT),
          ...defined(event.payload),
          // The server's stored value when it sends one; older servers did not.
          lastActivityAt: event.payload.lastActivityAt ?? event.ts,
        },
        updatedAt: event.ts,
      }))

    case 'card.commits.attached':
      return withCard(state, event.cardNo, (card) => {
        const known = new Set(card.commits.map((commit) => commit.sha))
        const full = new Map((event.payload.commits ?? []).map((commit) => [commit.sha, commit]))
        const added: Commit[] = event.payload.shas
          .filter((sha) => !known.has(sha))
          .map(
            (sha) =>
              full.get(sha) ?? { sha, message: null, author: event.actor, committedAt: event.ts },
          )
        if (added.length === 0) return card
        return { ...card, commits: [...card.commits, ...added], updatedAt: event.ts }
      })

    case 'card.anchor.set':
      return withCard(state, event.cardNo, (card) => ({
        ...card,
        anchor: {
          path: event.payload.path,
          line: event.payload.line,
          endLine: event.payload.endLine ?? null,
          commitSha: event.payload.commitSha ?? null,
          primary: true,
        },
        updatedAt: event.ts,
      }))

    case 'member.joined': {
      const joined: Member = {
        handle: event.payload.handle,
        displayName: null,
        kind: 'human',
        role: event.payload.role,
        lastSeenAt: event.ts,
      }
      const existing = state.members.find((member) => member.handle === joined.handle)
      const members = existing
        ? state.members.map((member) =>
            member.handle === joined.handle ? { ...member, role: joined.role } : member,
          )
        : [...state.members, joined]
      return { ...state, members }
    }

    case 'member.left': {
      const members = state.members.filter((member) => member.handle !== event.payload.handle)
      if (members.length === state.members.length) return state
      return { ...state, members }
    }

    case 'board.updated': {
      if (state.board === null) return state
      return { ...state, board: { ...state.board, ...defined(event.payload.fields) } }
    }

    default:
      // Unreachable for the current union. It is what keeps the reducer total
      // when a newer server emits an event type this build has never heard of.
      return state
  }
}

/**
 * Fold one event into the state.
 *
 * Events at or below `state.seq` have already been applied and are ignored, so
 * a duplicate delivery (the echo of the client's own write, §12.2) is a no-op.
 */
export function applyEvent(state: BoardState, event: EventEnvelope): BoardState {
  if (event.seq <= state.seq) return state
  const next = reduce(state, event)
  const number = event.type === 'card.created' ? event.payload.number : event.cardNo
  const card = number === undefined ? undefined : next.cards[number]
  if (event.version === undefined || card === undefined || card.version === event.version) {
    return { ...next, seq: event.seq }
  }
  return {
    ...next,
    cards: { ...next.cards, [card.number]: { ...card, version: event.version } },
    seq: event.seq,
  }
}

/**
 * Fold a batch of events, in `seq` order regardless of arrival order.
 *
 * The input array is not mutated.
 */
export function applyEvents(state: BoardState, events: readonly EventEnvelope[]): BoardState {
  return [...events].sort(compareEvents).reduce(applyEvent, state)
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function cardByNumber(state: BoardState, number: number): Card | undefined {
  return state.cards[number]
}

/** Every card, ordered by column rank then card number. */
export function allCards(state: BoardState): Card[] {
  return Object.values(state.cards).sort(
    (a, b) => compareRanks(a.rank, b.rank) || a.number - b.number,
  )
}

/** The cards in one column, in board order (SPEC.md §11.4). */
export function cardsInColumn(state: BoardState, columnKey: string): Card[] {
  return allCards(state).filter((card) => card.column === columnKey)
}

/** Columns in board order. */
export function orderedColumns(state: BoardState): Column[] {
  return [...state.columns].sort((a, b) => compareRanks(a.rank, b.rank))
}
