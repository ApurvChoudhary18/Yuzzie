/**
 * An SDK board that the test drives by hand: emit events, flip the connection,
 * count presence frames and syncs. For the source and presence tests, where a
 * real board would bury what is being checked under networking.
 */
import type { BoardState, Card, Column, EventEnvelope, Presence } from '@yuzie/core'
import { initialState } from '@yuzie/core'
import type { Board, ConnectionStatus } from '@yuzie/sdk'

type Handler = (payload: never) => void

export class FakeBoard {
  state: BoardState
  status: ConnectionStatus = 'live'
  presence: readonly Presence[] = []
  queued = 0
  pendingCards: ReadonlySet<number> = new Set()
  handle: string | null = 'rahul'
  /** Presence frames sent; `connected` decides whether sending works. */
  readonly sentPresence: Array<Record<string, unknown>> = []
  connected = true
  syncs = 0
  private readonly handlers = new Map<string, Set<Handler>>()
  readonly boards = {
    events: async () => ({ events: [] as EventEnvelope[], seq: 0 }),
  }

  constructor(columns: Column[], cards: Card[]) {
    const byNumber: Record<number, Card> = {}
    for (const card of cards) byNumber[card.number] = card
    this.state = initialState({ columns, cards: byNumber })
  }

  on(type: string, handler: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set()
    set.add(handler)
    this.handlers.set(type, set)
    return () => set.delete(handler)
  }

  emit(type: string, payload?: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) (handler as (p: unknown) => void)(payload)
  }

  /** A persisted event, as the SDK announces it: its type, then `*`. */
  event(event: EventEnvelope): void {
    this.emit(event.type, event)
    this.emit('*', event)
    this.emit('change', this.state)
  }

  setStatus(status: ConnectionStatus): void {
    this.status = status
    this.emit('status', status)
  }

  setPresence(frame: Record<string, unknown>): boolean {
    if (!this.connected) return false
    this.sentPresence.push(frame)
    return true
  }

  async sync() {
    this.syncs += 1
    const sent = this.queued
    this.queued = 0
    return { sent, conflicts: 0, rejected: 0, remaining: 0 }
  }

  asBoard(): Board {
    return this as unknown as Board
  }
}

let seq = 0
export function moved(cardNo: number, to: string, actor = 'priya'): EventEnvelope {
  seq += 1
  return {
    seq,
    type: 'card.moved',
    actor,
    cardNo,
    payload: { from: 'todo', to, rank: `z${seq}` },
    ts: new Date().toISOString(),
  } as EventEnvelope
}
