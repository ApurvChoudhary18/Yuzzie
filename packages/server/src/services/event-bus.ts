/**
 * In-process publication of committed events.
 *
 * Events are published *after* the transaction commits, so a subscriber can
 * never observe something a rollback undid. Session 4's WebSocket gateway
 * subscribes here to fan out to connected clients; for now the metrics counter
 * is the only listener.
 */
import type { EventEnvelope } from '@yuzie/core'

export type EventListener = (boardId: string, events: readonly EventEnvelope[]) => void

export interface EventBus {
  publish(boardId: string, events: readonly EventEnvelope[]): void
  subscribe(listener: EventListener): () => void
}

export function createEventBus(): EventBus {
  const listeners = new Set<EventListener>()

  return {
    publish(boardId, events) {
      if (events.length === 0) return
      for (const listener of listeners) {
        try {
          listener(boardId, events)
        } catch {
          // A broken subscriber must not fail the request that produced the
          // events; the write is already committed.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
