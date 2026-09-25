/**
 * A connected board (SPEC.md §13.1, §18 Session 5).
 *
 * State has two layers:
 *
 *   - `confirmed` is what the server has said, folded through `@yuzie/core`'s
 *     reducer from snapshots, replays and live events;
 *   - `pending` is this client's writes that the server has not yet confirmed.
 *
 * `board.state` is `pending` applied on top of `confirmed`, through the same
 * reducer, so it is always readable synchronously and always means the same
 * thing as a fold of the log. A write leaves `pending` when the server confirms
 * it (its response, or its event echoing back with the same idempotency key) or
 * rejects it — and on a 409 the rollback is simply dropping it, plus folding the
 * winner's card from the conflict into `confirmed`.
 */
import {
  type Anchor,
  AnchorSchema,
  type AnchorSetRequest,
  applyEvent,
  applyEvents,
  type BoardArchiveResponse,
  BoardArchiveResponseSchema,
  type BoardDetailResponse,
  BoardDetailResponseSchema,
  BoardError,
  type BoardSnapshot,
  type BoardState,
  type BoardUpdateRequest,
  type Card,
  type CardCreateRequest,
  CardDeleteResponseSchema,
  CardListResponseSchema,
  CardSchema,
  type CardUpdateRequest,
  type Column,
  type ColumnCreateRequest,
  ColumnSchema,
  type Comment,
  CommentSchema,
  type Commit,
  ConflictError,
  type EventEnvelope,
  type EventOf,
  type EventsReplayResponse,
  EventsReplayResponseSchema,
  type EventType,
  type GitSummary,
  GitSummarySchema,
  type GitSummaryUpsertRequest,
  type InviteCreateRequest,
  initialState,
  type Member,
  MembersResponseSchema,
  NotFoundError,
  newId,
  OfflineError,
  type Presence,
  PresenceResponseSchema,
  rankBetween,
  ValidationError,
} from '@yuzie/core'
import { z } from 'zod'
import { type CacheLike, createMemoryOutbox, type OutboxLike, type OutboxOpLike } from './cache.js'
import { Emitter } from './emitter.js'
import type { Http, HttpMethod } from './http.js'
import type { WebSocketFactory } from './platform.js'
import { type ConnectionStatus, RealtimeClient } from './realtime.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** `"queue"` keeps writes in the outbox while offline; `"fail"` throws `OfflineError`. */
export type OfflineMode = 'queue' | 'fail'

export interface ConflictEvent {
  readonly cardNo: number
  readonly error: ConflictError
  /** The server's card at the time of the conflict, now in `board.state`. */
  readonly current: Card | null
}

/** A queued write the server refused for a reason other than a version conflict. */
export interface RejectedEvent {
  readonly op: OutboxOpLike
  readonly error: BoardError
}

/** Every event `board.on` can subscribe to. */
export type BoardEventMap = { readonly [K in EventType]: EventOf<K> } & {
  /** Every persisted event, whatever its type. */
  readonly '*': EventEnvelope
  readonly presence: readonly Presence[]
  readonly conflict: ConflictEvent
  readonly rejected: RejectedEvent
  readonly status: ConnectionStatus
  /** `board.state` changed, for any reason. */
  readonly change: BoardState
  /** Something went wrong in the background (a frame that did not parse, a failed replay). */
  readonly error: Error
}

export type CardInput = CardCreateRequest & {
  /** Shorthand for `assignees: [assignee]`, as in §13.1. */
  readonly assignee?: string
}

export interface MoveOptions {
  /** Place above this card number in the target column. */
  readonly before?: number
  /** Place below this card number in the target column. */
  readonly after?: number
}

export interface CardFilter {
  readonly column?: string
  readonly assignee?: string
  readonly label?: string
  readonly search?: string
  readonly limit?: number
}

export interface SyncReport {
  readonly sent: number
  readonly conflicts: number
  readonly rejected: number
  /** Still queued because the server could not be reached. */
  readonly remaining: number
}

export interface BoardOptions {
  readonly slug: string
  readonly http: Http
  readonly offline: OfflineMode
  readonly cache?: CacheLike
  readonly socket?: WebSocketFactory
  readonly realtime: boolean
  readonly token: () => string | undefined
  readonly client?: string
  readonly connectTimeoutMs: number
  readonly random?: () => number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type LocalEvent = DistributiveOmit<EventEnvelope, 'seq' | 'ts' | 'actor'>

/** Fold an event the server has not sent yet, without claiming its `seq`. */
function applyLocally(state: BoardState, event: LocalEvent): BoardState {
  const next = applyEvent(state, {
    ...event,
    seq: state.seq + 1,
    ts: new Date().toISOString(),
    actor: null,
  } as EventEnvelope)
  return { ...next, seq: state.seq }
}

function withCard(state: BoardState, card: Card): BoardState {
  return { ...state, cards: { ...state.cards, [card.number]: card } }
}

function withoutCard(state: BoardState, number: number): BoardState {
  if (state.cards[number] === undefined) return state
  const { [number]: _removed, ...cards } = state.cards
  return { ...state, cards }
}

export function stateFromSnapshot(seq: number, snapshot: BoardSnapshot): BoardState {
  const cards: Record<number, Card> = {}
  for (const card of snapshot.cards) cards[card.number] = card
  return initialState({
    board: snapshot.board,
    columns: snapshot.columns,
    labels: snapshot.labels,
    members: snapshot.members,
    cards,
    seq,
  })
}

/**
 * §7.2: a column reference matches its key exactly, else case-insensitively by a
 * unique prefix. Mirrors the server so an optimistic move lands where the server
 * will put it.
 */
export function matchColumn(columns: readonly Column[], ref: string): Column | undefined {
  const lowered = ref.toLowerCase()
  const exact = columns.find((column) => column.key === lowered)
  if (exact !== undefined) return exact
  const prefixed = columns.filter((column) => column.key.startsWith(lowered))
  return prefixed.length === 1 ? prefixed[0] : undefined
}

function lastRankIn(state: BoardState, column: string): string | undefined {
  let last: string | undefined
  for (const card of Object.values(state.cards)) {
    if (card.column !== column) continue
    if (last === undefined || card.rank > last) last = card.rank
  }
  return last
}

function cardPath(slug: string, number: number, suffix = ''): string {
  return `/boards/${encodeURIComponent(slug)}/cards/${number}${suffix}`
}

function isRetryableFailure(error: unknown): boolean {
  if (error instanceof OfflineError) return true
  return error instanceof BoardError && (error.status === 429 || error.status >= 500)
}

const UnknownBody = z.unknown()

function isHandleList(value: unknown): value is readonly string[] {
  return Array.isArray(value)
}

function stripHandles(list: readonly string[] | undefined): string[] {
  return (list ?? []).map((handle) => handle.replace(/^@/, ''))
}
const CARD_PATH = /\/cards\/(\d+)(\/.*)?$/

interface Pending {
  readonly key: string
  readonly apply: (state: BoardState) => BoardState
  /** The card the write is about, when it is about one. */
  readonly cardNo: number | null
}

interface WriteSpec<T> {
  readonly method: HttpMethod
  readonly path: string
  readonly body?: unknown
  readonly ifMatch?: number
  readonly schema: z.ZodType<T>
  /** The optimistic effect on `board.state`. */
  readonly optimistic?: (state: BoardState) => BoardState
  /** Fold the server's answer into confirmed state. */
  readonly settle: (result: T) => Promise<void> | void
  /** What to return when the write is queued offline instead of sent. */
  readonly queued: (state: BoardState) => T
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export class Board {
  readonly slug: string
  readonly cards: CardsResource
  readonly boards: BoardsResource
  readonly members: MembersResource
  readonly comments: CommentsResource

  private confirmed: BoardState = initialState()
  private pending: Pending[] = []
  private view: BoardState | null = null
  private presenceList: readonly Presence[] = []
  private me: string | null = null
  private readonly emitter = new Emitter<BoardEventMap>()
  private readonly outbox: OutboxLike
  private realtime: RealtimeClient | null = null
  private incoming: Promise<void> = Promise.resolve()
  private provisional = 0
  private synced = false
  private syncWaiters: Array<() => void> = []
  private resumeTarget: number | null = null
  private closed = false

  constructor(private readonly options: BoardOptions) {
    this.slug = options.slug
    this.outbox = options.cache?.outbox ?? createMemoryOutbox()
    this.cards = new CardsResource(this)
    this.boards = new BoardsResource(this)
    this.members = new MembersResource(this)
    this.comments = new CommentsResource(this)
  }

  // -- reading ----------------------------------------------------------------

  /** The board as this client sees it right now, optimistic writes included. */
  get state(): BoardState {
    if (this.view === null) {
      this.view = this.pending.reduce((state, write) => write.apply(state), this.confirmed)
    }
    return this.view
  }

  /** Who is on the board, as of the last presence broadcast. */
  get presence(): readonly Presence[] {
    return this.presenceList
  }

  get status(): ConnectionStatus {
    return this.realtime?.status ?? (this.closed ? 'closed' : 'live')
  }

  /** Writes waiting in the outbox for `sync()`. */
  get queued(): number {
    return this.outbox.size(this.slug)
  }

  /** Writes applied optimistically and not yet confirmed or rejected. */
  get unconfirmed(): number {
    return this.pending.length
  }

  /**
   * Cards with a write applied optimistically and not yet confirmed, so a UI
   * can mark them. A card created offline also has a negative (provisional) number.
   */
  get pendingCards(): ReadonlySet<number> {
    const cards = new Set<number>()
    for (const write of this.pending) if (write.cardNo !== null) cards.add(write.cardNo)
    return cards
  }

  on<K extends keyof BoardEventMap>(
    type: K,
    handler: (event: BoardEventMap[K]) => void,
  ): () => void {
    return this.emitter.on(type, handler)
  }

  /** Tell everyone what you are doing (§8.5). Presence is transient; offline it is dropped. */
  setPresence(frame: {
    state: 'viewing' | 'working' | 'idle'
    cardNo?: number
    branch?: string
  }): boolean {
    return this.realtime?.sendPresence(frame) ?? false
  }

  // -- lifecycle ----------------------------------------------------------------

  /** Load cached state, then the server's, then start streaming. Used by `Yuzie.connect`. */
  async open(): Promise<void> {
    this.hydrateFromCache()

    let reachable = true
    try {
      await this.boards.get()
      const me = await this.options.http.request({
        method: 'GET',
        path: '/me',
        schema: z.object({ user: z.object({ handle: z.string() }) }),
      })
      this.me = me.user.handle
    } catch (error) {
      if (!(error instanceof OfflineError) || this.options.offline === 'fail') throw error
      reachable = false
    }

    if (this.options.realtime && this.options.socket !== undefined) {
      this.startRealtime(this.options.socket)
      if (reachable) await this.waitForSync(this.options.connectTimeoutMs)
    } else if (reachable) {
      await this.refresh()
    }
  }

  /**
   * Reload the whole board over HTTP. Used without realtime, and after draining
   * the outbox when no stream is carrying the echoes.
   */
  async refresh(): Promise<void> {
    const head = await this.options.http.request({
      method: 'GET',
      path: `/boards/${encodeURIComponent(this.slug)}/events`,
      query: { since: 0, limit: 1 },
      schema: EventsReplayResponseSchema,
    })
    const detail = await this.boards.get()
    const list = await this.options.http.request({
      method: 'GET',
      path: `/boards/${encodeURIComponent(this.slug)}/cards`,
      schema: CardListResponseSchema,
    })
    this.replaceConfirmed(stateFromSnapshot(head.seq, { ...detail, cards: list.cards }))
  }

  /**
   * Send every queued write, oldest first, each with its original idempotency
   * key so a write that did reach the server before the link dropped is not
   * applied twice (§12.1).
   */
  async sync(): Promise<SyncReport> {
    let sent = 0
    let conflicts = 0
    let rejected = 0

    for (const entry of this.outbox.list(this.slug)) {
      const { op } = entry
      try {
        const result = await this.options.http.request({
          method: op.method,
          path: op.path,
          schema: UnknownBody,
          idempotencyKey: op.idempotencyKey,
          ...(op.body === undefined ? {} : { body: op.body }),
          ...(op.ifMatch === undefined ? {} : { ifMatch: op.ifMatch }),
        })
        this.outbox.remove(entry.id)
        await this.settleQueued(op, result)
        this.dropPending(op.idempotencyKey)
        sent += 1
      } catch (error) {
        if (isRetryableFailure(error)) {
          this.outbox.recordFailure(
            entry.id,
            error instanceof Error ? error.message : String(error),
          )
          break
        }
        this.outbox.remove(entry.id)
        this.dropPending(op.idempotencyKey)
        if (error instanceof ConflictError) {
          conflicts += 1
          this.handleConflict(error)
        } else if (error instanceof BoardError) {
          rejected += 1
          this.emitter.emit('rejected', { op, error })
        } else {
          throw error
        }
      }
    }

    this.changed()
    return { sent, conflicts, rejected, remaining: this.outbox.size(this.slug) }
  }

  async close(): Promise<void> {
    this.closed = true
    this.realtime?.close()
    this.realtime = null
    await this.incoming.catch(() => {})
    this.emitter.clear()
  }

  // -- writes (used by the resources) ------------------------------------------

  /** @internal */
  get http(): Http {
    return this.options.http
  }

  /** @internal */
  get handle(): string | null {
    return this.me
  }

  /** @internal The next provisional (negative) number for a card created offline. */
  nextProvisionalNumber(): number {
    this.provisional -= 1
    return this.provisional
  }

  /** @internal */
  confirmedCard(number: number): Card | undefined {
    return this.confirmed.cards[number]
  }

  /** @internal */
  upsertConfirmed(card: Card): void {
    this.confirmed = withCard(this.confirmed, card)
    this.persistCard(card.number)
    this.changed()
  }

  /** @internal */
  removeConfirmed(number: number): void {
    this.confirmed = withoutCard(this.confirmed, number)
    this.persistCard(number)
    this.changed()
  }

  /** @internal */
  setBoardDetail(detail: BoardDetailResponse): void {
    this.confirmed = {
      ...this.confirmed,
      board: detail.board,
      columns: detail.columns,
      labels: detail.labels,
      members: detail.members,
    }
    this.options.cache?.transaction(() => {
      this.options.cache?.columns.clear(this.slug)
      this.options.cache?.columns.putMany(this.slug, detail.columns)
    })
    this.changed()
  }

  /** @internal Run one write through the optimistic pipeline. */
  async write<T>(spec: WriteSpec<T>): Promise<T> {
    const key = newId()
    if (spec.optimistic !== undefined) {
      const match = CARD_PATH.exec(spec.path)
      this.pending.push({
        key,
        apply: spec.optimistic,
        cardNo: match === null ? null : Number(match[1]),
      })
      this.changed()
    }

    const op: OutboxOpLike = {
      method: spec.method as OutboxOpLike['method'],
      path: spec.path,
      idempotencyKey: key,
      ...(spec.body === undefined ? {} : { body: spec.body }),
      ...(spec.ifMatch === undefined ? {} : { ifMatch: spec.ifMatch }),
    }

    // Writes must reach the server in the order they were made, so once
    // anything is queued, everything after it queues too.
    if (this.options.offline === 'queue' && this.outbox.size(this.slug) > 0) {
      return this.enqueue(op, spec)
    }

    try {
      const result = await this.options.http.request({
        method: spec.method,
        path: spec.path,
        schema: spec.schema,
        idempotencyKey: key,
        ...(spec.body === undefined ? {} : { body: spec.body }),
        ...(spec.ifMatch === undefined ? {} : { ifMatch: spec.ifMatch }),
      })
      await spec.settle(result)
      this.dropPending(key)
      return result
    } catch (error) {
      if (error instanceof OfflineError && this.options.offline === 'queue') {
        return this.enqueue(op, spec)
      }
      this.dropPending(key)
      if (error instanceof ConflictError) this.handleConflict(error)
      throw error
    }
  }

  // -- internals --------------------------------------------------------------

  private enqueue<T>(op: OutboxOpLike, spec: WriteSpec<T>): T {
    this.outbox.enqueue(this.slug, op)
    return spec.queued(this.state)
  }

  /** Fold the answer to a queued write, which was sent without its original callback. */
  private async settleQueued(op: OutboxOpLike, result: unknown): Promise<void> {
    const card = CardSchema.safeParse(result)
    if (card.success) {
      this.upsertConfirmed(card.data)
      return
    }
    const match = CARD_PATH.exec(op.path)
    if (match === null) return
    const number = Number(match[1])
    if (op.method === 'DELETE' && match[2] === undefined) {
      this.removeConfirmed(number)
      return
    }
    await this.cards.get(number)
  }

  private handleConflict(error: ConflictError): void {
    const current = CardSchema.safeParse(error.details.current)
    const cardNo = typeof error.details.number === 'number' ? error.details.number : 0
    if (current.success) this.upsertConfirmed(current.data)
    else this.changed()
    this.emitter.emit('conflict', {
      cardNo: current.success ? current.data.number : cardNo,
      error,
      current: current.success ? current.data : null,
    })
  }

  private dropPending(key: string | undefined): void {
    if (key === undefined) return
    const before = this.pending.length
    this.pending = this.pending.filter((write) => write.key !== key)
    if (this.pending.length !== before) this.changed()
  }

  private changed(): void {
    this.view = null
    this.emitter.emit('change', this.state)
  }

  private hydrateFromCache(): void {
    const cache = this.options.cache
    if (cache === undefined) return
    const cards: Record<number, Card> = {}
    for (const card of cache.cards.list(this.slug)) cards[card.number] = card
    this.confirmed = initialState({
      columns: cache.columns.list(this.slug),
      cards,
      seq: cache.sync.get(this.slug).lastSeq,
    })
    this.changed()
  }

  private replaceConfirmed(state: BoardState): void {
    this.confirmed = state
    const cache = this.options.cache
    cache?.transaction(() => {
      cache.cards.clear(this.slug)
      cache.cards.putMany(this.slug, Object.values(state.cards))
      cache.columns.clear(this.slug)
      cache.columns.putMany(this.slug, state.columns)
      cache.sync.set({ boardSlug: this.slug, lastSeq: state.seq, syncedAt: Date.now() })
    })
    this.changed()
  }

  private persistCard(number: number): void {
    const cache = this.options.cache
    if (cache === undefined) return
    const card = this.confirmed.cards[number]
    if (card === undefined) cache.cards.delete(this.slug, number)
    else cache.cards.put(this.slug, card)
  }

  private startRealtime(socket: WebSocketFactory): void {
    this.realtime = new RealtimeClient(
      {
        baseUrl: this.options.http.baseUrl,
        slug: this.slug,
        token: this.options.token,
        socket,
        ...(this.options.client === undefined ? {} : { client: this.options.client }),
        ...(this.options.random === undefined ? {} : { random: this.options.random }),
      },
      {
        // A cache that has never synced has nothing to resume from.
        lastSeq: () => (this.confirmed.seq > 0 || this.synced ? this.confirmed.seq : undefined),
        onWelcome: (frame) => {
          this.resumeTarget = frame.resumed ? frame.seq : null
          this.enqueueIncoming(async () => this.checkSynced())
        },
        onSnapshot: (frame) =>
          this.enqueueIncoming(async () => {
            this.replaceConfirmed(stateFromSnapshot(frame.seq, frame.board))
            this.markSynced()
          }),
        onEvent: (event) => this.enqueueIncoming(() => this.ingest(event)),
        onPresence: (users) => {
          this.presenceList = users
          this.emitter.emit('presence', users)
        },
        onStatus: (status) => this.emitter.emit('status', status),
        onProtocolError: (error) => this.emitter.emit('error', error),
      },
    )
    this.realtime.start()
  }

  /** Events are processed strictly one at a time, so a replay can finish before the next one. */
  private enqueueIncoming(task: () => Promise<void>): void {
    this.incoming = this.incoming.then(task).catch((error: unknown) => {
      this.emitter.emit('error', error instanceof Error ? error : new Error(String(error)))
    })
  }

  private async ingest(event: EventEnvelope): Promise<void> {
    if (event.seq <= this.confirmed.seq) {
      // Already folded (a replay overlapping a live event); still resolves a pending write.
      this.dropPending(event.idempotencyKey)
      return
    }
    // §12.2: a client that sees a gap asks for the missing events over REST.
    if (event.seq > this.confirmed.seq + 1) await this.catchUp(event.seq - 1)
    this.fold([event])
    this.checkSynced()
  }

  private async catchUp(upTo: number): Promise<void> {
    while (this.confirmed.seq < upTo) {
      const page: EventsReplayResponse = await this.options.http.request({
        method: 'GET',
        path: `/boards/${encodeURIComponent(this.slug)}/events`,
        query: { since: this.confirmed.seq, limit: 500 },
        schema: EventsReplayResponseSchema,
      })
      const events = page.events.filter((event) => event.seq <= upTo)
      if (events.length === 0) return
      this.fold(events)
    }
  }

  private fold(events: readonly EventEnvelope[]): void {
    const before = this.confirmed
    this.confirmed = applyEvents(this.confirmed, events)

    const cache = this.options.cache
    cache?.transaction(() => {
      for (const event of events) {
        const number = event.type === 'card.created' ? event.payload.number : event.cardNo
        if (number !== undefined) this.persistCard(number)
      }
      cache.sync.set({ boardSlug: this.slug, lastSeq: this.confirmed.seq, syncedAt: Date.now() })
    })

    for (const event of events) {
      if (event.seq <= before.seq) continue
      this.dropPending(event.idempotencyKey)
      this.emitter.emit(event.type, event as never)
      this.emitter.emit('*', event)
    }
    this.changed()
  }

  private checkSynced(): void {
    if (this.resumeTarget !== null && this.confirmed.seq >= this.resumeTarget) {
      this.resumeTarget = null
      this.markSynced()
    }
  }

  private markSynced(): void {
    this.synced = true
    const waiters = this.syncWaiters
    this.syncWaiters = []
    for (const resolve of waiters) resolve()
  }

  private waitForSync(timeoutMs: number): Promise<void> {
    if (this.synced) return Promise.resolve()
    return new Promise((resolve) => {
      // Resolve on timeout too: an unreachable stream leaves the board usable
      // from cache, with realtime retrying in the background.
      const timer = setTimeout(resolve, timeoutMs)
      this.syncWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export class CardsResource {
  constructor(private readonly board: Board) {}

  /** From the server; from local state when offline in `"queue"` mode. */
  async list(filter: CardFilter = {}): Promise<Card[]> {
    const board = this.board
    const column =
      filter.column === undefined
        ? undefined
        : (matchColumn(board.state.columns, filter.column)?.key ?? filter.column.toLowerCase())
    try {
      const response = await board.http.request({
        method: 'GET',
        path: `/boards/${encodeURIComponent(board.slug)}/cards`,
        query: {
          column,
          assignee: filter.assignee,
          label: filter.label,
          search: filter.search,
          limit: filter.limit,
        },
        schema: CardListResponseSchema,
      })
      return response.cards
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error
      return this.listLocal({ ...filter, ...(column === undefined ? {} : { column }) })
    }
  }

  /** The same filters, answered from `board.state` without the network. */
  listLocal(filter: CardFilter = {}): Card[] {
    const needle = filter.search?.toLowerCase()
    const assignee = filter.assignee?.replace(/^@/, '')
    const cards = Object.values(this.board.state.cards)
      .filter((card) => filter.column === undefined || card.column === filter.column)
      .filter((card) => assignee === undefined || card.assignees.includes(assignee))
      .filter((card) => filter.label === undefined || card.labels.includes(filter.label))
      .filter(
        (card) =>
          needle === undefined ||
          card.title.toLowerCase().includes(needle) ||
          (card.description ?? '').toLowerCase().includes(needle),
      )
      .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.number - b.number))
    return filter.limit === undefined ? cards : cards.slice(0, filter.limit)
  }

  async get(number: number): Promise<Card> {
    const board = this.board
    try {
      const card = await board.http.request({
        method: 'GET',
        path: cardPath(board.slug, number),
        schema: CardSchema,
      })
      board.upsertConfirmed(card)
      return card
    } catch (error) {
      if (error instanceof NotFoundError && board.confirmedCard(number) !== undefined) {
        board.removeConfirmed(number)
      }
      if (!(error instanceof OfflineError)) throw error
      const local = board.state.cards[number]
      if (local === undefined) throw error
      return local
    }
  }

  async create(input: CardInput): Promise<Card> {
    const board = this.board
    const { assignee, ...rest } = input
    const body: CardCreateRequest = {
      ...rest,
      ...(assignee === undefined
        ? {}
        : { assignees: [...new Set([...(rest.assignees ?? []), assignee.replace(/^@/, '')])] }),
    }

    const number = board.nextProvisionalNumber()
    const provisional = (state: BoardState): Card | null => {
      const column =
        body.column === undefined ? state.columns[0] : matchColumn(state.columns, body.column)
      if (column === undefined) return null
      const now = new Date().toISOString()
      return {
        id: newId(),
        boardId: state.board?.id ?? '00000000-0000-4000-8000-000000000000',
        number,
        column: column.key,
        rank: rankBetween(lastRankIn(state, column.key)),
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? null,
        dueAt: body.dueAt ?? null,
        assignees: body.assignees ?? [],
        labels: body.labels ?? [],
        watchers: [],
        checklist: [],
        comments: [],
        commits: [],
        git: null,
        anchor: null,
        createdBy: board.handle,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      }
    }

    return board.write({
      method: 'POST',
      path: `/boards/${encodeURIComponent(board.slug)}/cards`,
      body,
      schema: CardSchema,
      optimistic: (state) => {
        const card = provisional(state)
        return card === null ? state : withCard(state, card)
      },
      settle: (card) => board.upsertConfirmed(card),
      queued: (state) => {
        const card = state.cards[number] ?? provisional(state)
        if (card === null)
          throw new ValidationError('validation_failed', 'No such column on this board')
        return card
      },
    })
  }

  /** Edit fields, guarded by the card's version so a concurrent edit is a 409 (§11.4). */
  async update(number: number, fields: CardUpdateRequest): Promise<Card> {
    const board = this.board
    const version = board.confirmedCard(number)?.version
    return board.write({
      method: 'PATCH',
      path: cardPath(board.slug, number),
      body: fields,
      ...(version === undefined ? {} : { ifMatch: version }),
      schema: CardSchema,
      optimistic: (state) =>
        applyLocally(state, {
          type: 'card.updated',
          cardNo: number,
          payload: { fields, version: (state.cards[number]?.version ?? 0) + 1 },
        } as LocalEvent),
      settle: (card) => board.upsertConfirmed(card),
      queued: (state) => this.local(state, number),
    })
  }

  async move(number: number, column: string, options: MoveOptions = {}): Promise<Card> {
    const board = this.board
    return board.write({
      method: 'POST',
      path: cardPath(board.slug, number, '/move'),
      body: {
        column,
        ...(options.before === undefined ? {} : { beforeCard: options.before }),
        ...(options.after === undefined ? {} : { afterCard: options.after }),
      },
      schema: CardSchema,
      optimistic: (state) => {
        const card = state.cards[number]
        const target = matchColumn(state.columns, column)
        if (card === undefined || target === undefined) return state
        const below = options.after === undefined ? undefined : state.cards[options.after]?.rank
        const above = options.before === undefined ? undefined : state.cards[options.before]?.rank
        const rank =
          below === undefined && above === undefined
            ? rankBetween(lastRankIn(state, target.key))
            : rankBetween(below, above)
        return applyLocally(state, {
          type: 'card.moved',
          cardNo: number,
          payload: { from: card.column, to: target.key, rank },
        })
      },
      settle: (card) => board.upsertConfirmed(card),
      queued: (state) => this.local(state, number),
    })
  }

  /** `assign(18, ["rahul"])` adds; pass `{ add, remove }` to do both. */
  async assign(
    number: number,
    handles:
      | readonly string[]
      | { readonly add?: readonly string[]; readonly remove?: readonly string[] },
  ): Promise<Card> {
    const board = this.board
    const change = isHandleList(handles) ? { add: handles } : handles
    const add = stripHandles(change.add)
    const remove = stripHandles('remove' in change ? change.remove : undefined)
    return board.write({
      method: 'POST',
      path: cardPath(board.slug, number, '/assign'),
      body: { ...(add.length > 0 ? { add } : {}), ...(remove.length > 0 ? { remove } : {}) },
      schema: CardSchema,
      optimistic: (state) =>
        applyLocally(state, {
          type: 'card.assigned',
          cardNo: number,
          payload: { added: add, removed: remove },
        }),
      settle: (card) => board.upsertConfirmed(card),
      queued: (state) => this.local(state, number),
    })
  }

  async comment(number: number, body: string): Promise<Comment> {
    const board = this.board
    const commentId = newId()
    const provisional = (): Comment => ({
      id: commentId,
      cardNumber: number,
      author: board.handle ?? 'you',
      body,
      createdAt: new Date().toISOString(),
      editedAt: null,
    })
    return board.write({
      method: 'POST',
      path: cardPath(board.slug, number, '/comments'),
      body: { body },
      schema: CommentSchema,
      optimistic: (state) =>
        applyLocally(state, {
          type: 'comment.created',
          cardNo: number,
          payload: { commentId, body, author: board.handle ?? 'you' },
        }),
      settle: async () => {
        await this.get(number)
      },
      queued: provisional,
    })
  }

  /**
   * Tick a checklist item. `item` is its 1-based position on the card, as in
   * `check(18, 3, true)`, or its id.
   */
  async check(number: number, item: number | string, done: boolean): Promise<Card> {
    const board = this.board
    const card = board.state.cards[number]
    const itemId =
      typeof item === 'string' ? item : card?.checklist.find((entry) => entry.position === item)?.id
    if (itemId === undefined) {
      throw new ValidationError(
        'validation_failed',
        `Card #${number} has no checklist item ${String(item)}`,
        { details: { number, item } },
      )
    }
    return board
      .write({
        method: 'PATCH',
        path: cardPath(board.slug, number, `/checklist/${itemId}`),
        body: { done },
        schema: UnknownBody,
        optimistic: (state) =>
          applyLocally(state, {
            type: 'checklist.updated',
            cardNo: number,
            payload: { itemId, done },
          }),
        settle: async () => {
          await this.get(number)
        },
        queued: (state) => this.local(state, number),
      })
      .then(() => this.local(board.state, number))
  }

  async addChecklistItem(number: number, text: string, position?: number): Promise<Card> {
    const board = this.board
    await board.write({
      method: 'POST',
      path: cardPath(board.slug, number, '/checklist'),
      body: { text, ...(position === undefined ? {} : { position }) },
      schema: UnknownBody,
      settle: async () => {
        await this.get(number)
      },
      queued: () => undefined,
    })
    return this.local(board.state, number)
  }

  async delete(number: number): Promise<void> {
    const board = this.board
    await board.write({
      method: 'DELETE',
      path: cardPath(board.slug, number),
      schema: CardDeleteResponseSchema,
      optimistic: (state) => withoutCard(state, number),
      settle: () => board.removeConfirmed(number),
      queued: () => ({ number, deleted: true as const }),
    })
  }

  /** Record the branch a card lives on (§9.2). */
  async linkBranch(number: number, branch: string, baseBranch?: string): Promise<GitSummary> {
    return this.updateGit(number, { branch, ...(baseBranch === undefined ? {} : { baseBranch }) })
  }

  /** Upsert the locally derived git summary; no repository content is sent (§14.3). */
  async updateGit(number: number, summary: GitSummaryUpsertRequest): Promise<GitSummary> {
    const board = this.board
    return board.write({
      method: 'PUT',
      path: cardPath(board.slug, number, '/git'),
      body: summary,
      schema: GitSummarySchema,
      optimistic: (state) => {
        const card = state.cards[number]
        if (card === undefined) return state
        const base: GitSummary = card.git ?? {
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
        return withCard(state, { ...card, git: { ...base, ...summary } })
      },
      settle: async () => {
        await this.get(number)
      },
      queued: (state) => {
        const git = state.cards[number]?.git
        if (git === null || git === undefined)
          throw new NotFoundError('card_not_found', `No card #${number}`)
        return git
      },
    })
  }

  async attachCommits(number: number, commits: readonly Commit[]): Promise<Commit[]> {
    const board = this.board
    const result = await board.write({
      method: 'POST',
      path: cardPath(board.slug, number, '/commits'),
      body: { commits },
      schema: z.object({ commits: z.array(z.unknown()) }),
      settle: async () => {
        await this.get(number)
      },
      queued: () => ({ commits: [...commits] }),
    })
    return result.commits.length === 0 ? [] : (board.state.cards[number]?.commits ?? [...commits])
  }

  async setAnchor(number: number, anchor: AnchorSetRequest): Promise<Anchor> {
    const board = this.board
    return board.write({
      method: 'PUT',
      path: cardPath(board.slug, number, '/anchor'),
      body: anchor,
      schema: AnchorSchema,
      settle: async () => {
        await this.get(number)
      },
      queued: () => ({
        path: anchor.path,
        line: anchor.line ?? null,
        endLine: anchor.endLine ?? null,
        commitSha: anchor.commitSha ?? null,
        primary: anchor.primary ?? true,
      }),
    })
  }

  async watch(number: number, watching = true): Promise<void> {
    const board = this.board
    await board.write({
      method: 'POST',
      path: cardPath(board.slug, number, '/watch'),
      body: { watching },
      schema: z.object({ number: z.number(), watching: z.boolean() }),
      settle: async () => {
        await this.get(number)
      },
      queued: () => ({ number, watching }),
    })
  }

  private local(state: BoardState, number: number): Card {
    const card = state.cards[number]
    if (card === undefined) {
      throw new NotFoundError(
        'card_not_found',
        `Card #${number} does not exist on board ${this.board.slug}`,
        {
          details: { boardSlug: this.board.slug, number },
        },
      )
    }
    return card
  }
}

export class BoardsResource {
  constructor(private readonly board: Board) {}

  /** The board with its columns, labels and members; refreshes `board.state`. */
  async get(): Promise<BoardDetailResponse> {
    const detail = await this.board.http.request({
      method: 'GET',
      path: `/boards/${encodeURIComponent(this.board.slug)}`,
      schema: BoardDetailResponseSchema,
    })
    this.board.setBoardDetail(detail)
    return detail
  }

  async update(fields: BoardUpdateRequest): Promise<void> {
    await this.board.http.request({
      method: 'PATCH',
      path: `/boards/${encodeURIComponent(this.board.slug)}`,
      body: fields,
      idempotencyKey: newId(),
      schema: UnknownBody,
    })
    await this.get()
  }

  async archive(): Promise<BoardArchiveResponse> {
    return this.board.http.request({
      method: 'DELETE',
      path: `/boards/${encodeURIComponent(this.board.slug)}`,
      idempotencyKey: newId(),
      schema: BoardArchiveResponseSchema,
    })
  }

  async addColumn(column: ColumnCreateRequest): Promise<Column> {
    const created = await this.board.http.request({
      method: 'POST',
      path: `/boards/${encodeURIComponent(this.board.slug)}/columns`,
      body: column,
      idempotencyKey: newId(),
      schema: ColumnSchema,
    })
    await this.get()
    return created
  }

  async removeColumn(key: string): Promise<void> {
    await this.board.http.request({
      method: 'DELETE',
      path: `/boards/${encodeURIComponent(this.board.slug)}/columns/${encodeURIComponent(key)}`,
      idempotencyKey: newId(),
      schema: UnknownBody,
    })
    await this.get()
  }

  /** The event log after `since` — `yuzie activity` is a projection over this (§12.3). */
  async events(since = 0, limit = 500): Promise<EventsReplayResponse> {
    return this.board.http.request({
      method: 'GET',
      path: `/boards/${encodeURIComponent(this.board.slug)}/events`,
      query: { since, limit },
      schema: EventsReplayResponseSchema,
    })
  }

  /** Presence over REST, for a client that is not streaming. */
  async presence(): Promise<Presence[]> {
    const response = await this.board.http.request({
      method: 'GET',
      path: `/boards/${encodeURIComponent(this.board.slug)}/presence`,
      schema: PresenceResponseSchema,
    })
    return response.users
  }
}

export class MembersResource {
  constructor(private readonly board: Board) {}

  async list(): Promise<Member[]> {
    const response = await this.board.http.request({
      method: 'GET',
      path: `/boards/${encodeURIComponent(this.board.slug)}/members`,
      schema: MembersResponseSchema,
    })
    return response.members
  }

  async invite(invite: InviteCreateRequest): Promise<{ handle: string; role: string }> {
    const result = await this.board.http.request({
      method: 'POST',
      path: `/boards/${encodeURIComponent(this.board.slug)}/invites`,
      body: invite,
      idempotencyKey: newId(),
      schema: z.object({ handle: z.string(), role: z.string() }),
    })
    await this.board.boards.get()
    return result
  }
}

export class CommentsResource {
  constructor(private readonly board: Board) {}

  /** Comments on a card, oldest first. */
  async list(number: number): Promise<Comment[]> {
    const card = await this.board.cards.get(number)
    return card.comments
  }

  create(number: number, body: string): Promise<Comment> {
    return this.board.cards.comment(number, body)
  }
}
