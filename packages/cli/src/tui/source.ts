/**
 * Adapts an SDK board to what the TUI renders: a `BoardView` that changes
 * whenever the board, presence, the connection or a toast does.
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
  viewColumns,
} from './layout.js'

const TOAST_MS = 3_000
/** Pages of the event log read, at most, to fill one card's activity panel. */
const ACTIVITY_PAGES = 4
const PAGE = 500

type Toast = NonNullable<BoardView['toast']>

export class SdkSource implements BoardSource {
  private cached: BoardView | null = null
  private readonly listeners = new Set<() => void>()
  private toast: BoardView['toast'] = null
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly conflicts = new Map<number, number>()
  private readonly activity = new Map<number, readonly ActivityEntry[] | null>()
  offline = false
  /** The first sync with the server has finished; until then the cache is all we have. */
  synced = false

  constructor(
    private readonly board: Board,
    private readonly slug: string,
    private readonly clock: () => number = Date.now,
  ) {
    board.on('change', () => this.invalidate())
    board.on('presence', () => this.invalidate())
    board.on('status', () => this.invalidate())
    board.on('*', (event) => {
      this.remember(event)
      this.say(`${actor(event)} ${describeEvent(event, board.state)}`, 'event')
    })
    board.on('conflict', ({ cardNo }) => {
      this.conflicts.set(cardNo, this.clock())
      this.later(CONFLICT_MS + 50)
      this.say(`#${cardNo} changed on the server; your edit was undone`, 'warn')
    })
  }

  say(text: string, kind: Toast['kind']): void {
    this.toast = { text, at: this.clock(), ...(kind === undefined ? {} : { kind }) }
    // Repaint once it has expired, so it goes away without a keypress.
    this.later(TOAST_MS + 50)
    this.invalidate()
  }

  /** Repaint after `ms`, for things that expire. */
  private later(ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.invalidate()
    }, ms)
    this.timers.add(timer)
  }

  invalidate(): void {
    this.cached = null
    for (const listener of this.listeners) listener()
  }

  private entry(event: EventEnvelope): ActivityEntry {
    return {
      at: Date.parse(event.ts),
      who: actor(event),
      text: describeEvent(event, this.board.state),
    }
  }

  /** A live event for a card whose activity is on screen joins its panel. */
  private remember(event: EventEnvelope): void {
    if (event.cardNo === undefined) return
    const entries = this.activity.get(event.cardNo)
    if (entries === undefined || entries === null) return
    this.activity.set(event.cardNo, [...entries, this.entry(event)].slice(-ACTIVITY_LIMIT))
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

  view = (): BoardView => {
    if (this.cached !== null) return this.cached
    const state = this.board.state
    const status = this.board.status
    const connection: Connection = this.offline
      ? 'offline'
      : !this.synced
        ? 'connecting'
        : status === 'live'
          ? 'live'
          : status === 'reconnecting'
            ? 'reconnecting'
            : 'connecting'
    this.cached = {
      slug: this.slug,
      columns: viewColumns(state.columns, Object.values(state.cards)),
      presence: this.board.presence,
      connection,
      queued: this.board.queued,
      toast: this.toast,
      now: this.clock(),
      members: state.members.map((member) => member.handle),
      me: this.board.handle,
      pending: this.board.pendingCards,
      conflicts: new Map(this.conflicts),
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
  }
}
