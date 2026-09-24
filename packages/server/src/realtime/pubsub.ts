/**
 * Fan-out between server nodes (SPEC.md §10.1, §18 Session 4).
 *
 * A single node needs nothing more than a function call, and that is what
 * {@link createMemoryPubSub} is. Several nodes behind a load balancer need a
 * broker so a write on one reaches sockets held by another; that is the Redis
 * implementation in `./redis.ts`. The gateway only ever sees this interface.
 *
 * Delivery is at-most-once in both. The gateway does not rely on the broker for
 * correctness: it orders by `seq`, drops duplicates, and fills any gap it sees
 * from the event log (see `gateway.ts`).
 */

export type PubSubHandler = (message: string) => void

export interface PubSub {
  publish(topic: string, message: string): Promise<void>
  /** Resolves once the subscription is live; the returned function removes it. */
  subscribe(topic: string, handler: PubSubHandler): Promise<() => Promise<void>>
  close(): Promise<void>
}

/** Delivers synchronously, in publish order, to every handler on the topic. */
export function createMemoryPubSub(): PubSub {
  const topics = new Map<string, Set<PubSubHandler>>()

  return {
    async publish(topic, message) {
      const handlers = topics.get(topic)
      if (handlers === undefined) return
      for (const handler of [...handlers]) {
        try {
          handler(message)
        } catch {
          // One broken subscriber must not starve the others.
        }
      }
    },
    async subscribe(topic, handler) {
      let handlers = topics.get(topic)
      if (handlers === undefined) {
        handlers = new Set()
        topics.set(topic, handlers)
      }
      handlers.add(handler)
      return async () => {
        const current = topics.get(topic)
        current?.delete(handler)
        if (current?.size === 0) topics.delete(topic)
      }
    },
    async close() {
      topics.clear()
    },
  }
}
