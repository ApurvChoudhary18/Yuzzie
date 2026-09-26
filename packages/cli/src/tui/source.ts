/**
 * Adapts an SDK board to what the TUI renders: a `BoardView` that changes
 * whenever the board, presence, the connection or a toast does.
 *
 * Changes are coalesced: however fast events arrive, listeners hear about
 * them at most once per frame, 20 times a second (§18 Session 10). Keys never
 * wait on this — navigation lives in the reducer and repaints at once.
 */
import type { EventEnvelope } from '@yuzie/core'
import type { Board } from '@yuzie/sdk'
import { actor, describeEvent } from '../render/events.js'
import type { BoardSource } from './App.js'
import { ACTIVITY_LIMIT } from './card.js'
import {
  type ActivityEntry,
  type BoardView,
  CONFLICT_MS,
  type Connection,
  FLASH_MS,
  PUSH_MS,
  TOUCH_MS,
  type Touch,
  viewColumns,
} from './layout.js'

/** At most 20 repaints a second. */
export const FRAME_MS = 50
export const TOAST_MS = 3_000
/** With others waiting, a toast still gets this long on screen. */
const TOAST_MIN_MS = 1_000
/** Toasts queued at most, including the one showing (§18 Session 10). */
export const TOAST_CAP = 3
/** Reconnecting for longer than this reads as offline. */
export const OFFLINE_AFTER_MS = 4_000
/** While writes are queued and the stream is up, try sending them this often. */
const DRAIN_EVERY_MS = 5_000
/** Pages of the event log read, at most, to fill one card's activity panel. */
const ACTIVITY_PAGES = 4
const PAGE = 500

type ToastKind = NonNullable<BoardView['toast']>['kind']

export class SdkSource implements BoardSource {
  private cached: BoardView | null = null
  private readonly listeners = new Set<() => void>()
  private frameTimer: ReturnType<typeof setTimeout> | null = null
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly drainTimer: ReturnType<typeof setInterval>

  private readonly toasts: Array<{ text: string; kind: ToastKind }> = []
  private toastShownAt = 0
  private toastTimer: ReturnType<typeof setTimeout> | null = null

  private readonly conflicts = new Map<number, Touch>()
  private readonly touched = new Map<number, Touch>()
  private readonly flashes = new Map<number, number>()
  private readonly pushes = new Map<number, { count: number; at: number }>()
  private readonly lastActor = new Map<number, string>()
  private readonly activity = new Map<number, readonly ActivityEntry[] | null>()

  private reconnectingSince: number | null = null
  private draining = false
  offline = false
  /** The first sync with the server has finished; until then the cache is all we have. */
  synced = false
  /** Listener notifications so far: what the render budget test counts. */
  notifications = 0

  constructor(
    private readonly board: Board,
    private readonly slug: string,
    private readonly clock: () => number = Date.now,
  ) {
    board.on('change', () => this.invalidate())
    board.on('presence', () => this.invalidate())
    board.on('status', (status) => {
      if (status === 'reconnecting' && this.reconnectingSince === null) {
        this.reconnectingSince = this.clock()
        this.later(OFFLINE_AFTER_MS + 50)
      }
      if (status === 'live') {
        const wasDown = this.reconnectingSince !== null || this.offline
        this.reconnectingSince = null
        this.offline = false
        this.synced = true
        if (wasDown) void this.drain()
      }
      this.invalidate()
    })
    board.on('*', (event) => this.onEvent(event))
    board.on('conflict', ({ cardNo }) => {
      const by = this.lastActor.get(cardNo) ?? null
      this.conflicts.set(cardNo, { at: this.clock(), by })
      this.later(CONFLICT_MS + 50)
      this.say(
        `#${cardNo} ${by === null ? 'changed on the server' : `updated by ${by}`}; your edit was undone`,
        'conflict',
      )
    })
    this.drainTimer = setInterval(() => {
      if (this.board.queued > 0 && this.board.status === 'live') void this.drain()
    }, DRAIN_EVERY_MS)
    this.drainTimer.unref?.()
  }

  private onEvent(event: EventEnvelope): void {
    const now = this.clock()
    const cardNo = event.type === 'card.created' ? event.payload.number : event.cardNo
    if (cardNo !== undefined) {
      const who = actor(event)
      this.lastActor.set(cardNo, who)
      if (event.actor !== this.board.handle) {
        this.touched.set(cardNo, { at: now, by: who })
        this.later(TOUCH_MS + 50)
      }
      if (event.type === 'card.moved') {
        this.flashes.set(cardNo, now)
        this.later(FLASH_MS + 20)
      }
      if (event.type === 'card.commits.attached') {
        const before = this.pushes.get(cardNo)
        const count =
          event.payload.shas.length + (before && now - before.at < PUSH_MS ? before.count : 0)
        this.pushes.set(cardNo, { count, at: now })
        this.later(PUSH_MS + 50)
      }
      this.remember(cardNo, event)
    }
    // Toasts are news: your own changes echo back as events, but you just made
    // them, and the key that made them already said so.
    if (event.actor === null || event.actor !== this.board.handle)
      this.say(`${actor(event)} ${describeEvent(event, this.board.state)}`, 'event')
  }

  /** Send what queued up while the server was away; the SDK keeps each write's idempotency key. */
  private async drain(): Promise<void> {
    if (this.draining || this.board.queued === 0) return
    this.draining = true
    try {
      const report = await this.board.sync()
      if (report.sent > 0)
        this.say(`Sent ${report.sent} queued change${report.sent === 1 ? '' : 's'}`, 'info')
      if (report.rejected > 0)
        this.say(
          `${report.rejected} queued change${report.rejected === 1 ? ' was' : 's were'} refused`,
          'warn',
        )
    } catch {
      // Still unreachable: the timer tries again.
    } finally {
      this.draining = false
      this.invalidate()
    }
  }

  // -- toasts ------------------------------------------------------------------

  say(text: string, kind: ToastKind): void {
    if (this.toasts.length === 0) this.toastShownAt = this.clock()
    this.toasts.push({ text, kind })
    // Cap the queue: the oldest waiting toast gives way; the one showing stays.
    while (this.toasts.length > TOAST_CAP) this.toasts.splice(1, 1)
    this.scheduleToast()
    this.invalidate()
  }

  private scheduleToast(): void {
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
    this.toastTimer = null
    if (this.toasts.length === 0) return
    const due = this.toastShownAt + (this.toasts.length > 1 ? TOAST_MIN_MS : TOAST_MS)
    this.toastTimer = setTimeout(
      () => {
        this.toasts.shift()
        this.toastShownAt = this.clock()
        this.scheduleToast()
        this.invalidate()
      },
      Math.max(0, due - this.clock()),
    )
  }

  // -- frames ------------------------------------------------------------------

  /** Repaint after `ms`, for things that expire. */
  private later(ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.invalidate()
    }, ms)
    this.timers.add(timer)
  }

  /** Something changed: listeners hear about it on the next frame, at most 20 times a second. */
  invalidate(): void {
    this.cached = null
    if (this.frameTimer !== null) return
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null
      this.notifications += 1
      for (const listener of this.listeners) listener()
    }, FRAME_MS)
  }

  // -- activity ----------------------------------------------------------------

  private entry(event: EventEnvelope): ActivityEntry {
    return {
      at: Date.parse(event.ts),
      who: actor(event),
      text: describeEvent(event, this.board.state),
    }
  }

  /** A live event for a card whose activity is on screen joins its panel. */
  private remember(cardNo: number, event: EventEnvelope): void {
    const entries = this.activity.get(cardNo)
    if (entries === undefined || entries === null) return
    this.activity.set(cardNo, [...entries, this.entry(event)].slice(-ACTIVITY_LIMIT))
  }

  /**
   * Fill a card's activity panel from the event log, newest pages first. Offline
   * it stays as it is, and the card view falls back to the card's comments.
   */
  async loadActivity(cardNo: number): Promise<void> {
    if (this.offline || this.activity.get(cardNo) === null) return
    const had = this.activity.get(cardNo)
    this.activity.set(cardNo, had ?? null)
    this.invalidate()
    try {
      const head = this.board.state.seq
      const found: EventEnvelope[] = []
      for (let page = 0, upTo = head; page < ACTIVITY_PAGES && upTo > 0; page += 1, upTo -= PAGE) {
        const since = Math.max(0, upTo - PAGE)
        const events = (await this.board.boards.events(since, PAGE)).events.filter(
          (event) => event.seq <= upTo && event.cardNo === cardNo,
        )
        found.unshift(...events)
        if (found.length >= ACTIVITY_LIMIT) break
      }
      this.activity.set(
        cardNo,
        found.slice(-ACTIVITY_LIMIT).map((event) => this.entry(event)),
      )
    } catch {
      // Unreachable or refused: show what the card itself knows instead.
      this.activity.delete(cardNo)
    }
    this.invalidate()
  }

  // -- the view ----------------------------------------------------------------

  private connection(now: number): Connection {
    const status = this.board.status
    // First: a board with no stream (`--offline`) reads as `live`, and a
    // stream that comes back clears this flag itself.
    if (this.offline) return 'offline'
    if (status === 'live') return this.synced ? 'live' : 'connecting'
    if (status === 'reconnecting') {
      const since = this.reconnectingSince ?? now
      return this.board.queued > 0 || now - since >= OFFLINE_AFTER_MS ? 'offline' : 'reconnecting'
    }
    return this.synced ? 'reconnecting' : 'connecting'
  }

  view = (): BoardView => {
    if (this.cached !== null) return this.cached
    const state = this.board.state
    const now = this.clock()
    const head = this.toasts[0]
    this.cached = {
      slug: this.slug,
      columns: viewColumns(state.columns, Object.values(state.cards)),
      presence: this.board.presence,
      connection: this.connection(now),
      queued: this.board.queued,
      toast:
        head === undefined
          ? null
          : {
              text: head.text,
              at: this.toastShownAt,
              ...(head.kind === undefined ? {} : { kind: head.kind }),
              waiting: this.toasts.length - 1,
            },
      now,
      members: state.members.map((member) => member.handle),
      me: this.board.handle,
      pending: this.board.pendingCards,
      conflicts: new Map(this.conflicts),
      touched: new Map(this.touched),
      flashes: new Map(this.flashes),
      pushes: new Map(this.pushes),
      activity: new Map(this.activity),
    }
    return this.cached
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (this.frameTimer !== null) clearTimeout(this.frameTimer)
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
    clearInterval(this.drainTimer)
  }
}
