/**
 * The Redis {@link PubSub}, for multi-node deployments (SPEC.md §10.1).
 *
 * Redis is optional: `ioredis` is imported only when a `REDIS_URL` is
 * configured, so a single-node self-host never loads it.
 *
 * A Redis connection in subscriber mode cannot publish, so there are two: one
 * for each direction. Each topic is subscribed in Redis once, however many local
 * handlers share it.
 */
import type { PubSub, PubSubHandler } from './pubsub.js'

export interface RedisPubSubOptions {
  /** Called for connection errors; ioredis reconnects on its own meanwhile. */
  readonly onError?: (error: Error) => void
}

export async function createRedisPubSub(
  url: string,
  options: RedisPubSubOptions = {},
): Promise<PubSub> {
  const { Redis } = await import('ioredis')
  const onError = options.onError ?? (() => {})

  // `lazyConnect` so a bad URL is a rejected promise here, not an unhandled
  // error event later.
  const publisher = new Redis(url, { lazyConnect: true })
  const subscriber = new Redis(url, { lazyConnect: true })
  publisher.on('error', onError)
  subscriber.on('error', onError)
  try {
    await Promise.all([publisher.connect(), subscriber.connect()])
  } catch (error) {
    publisher.disconnect()
    subscriber.disconnect()
    throw error
  }

  interface Topic {
    readonly handlers: Set<PubSubHandler>
    /** Every subscriber waits on this, not just the one that created the topic. */
    readonly ready: Promise<unknown>
  }
  const topics = new Map<string, Topic>()

  subscriber.on('message', (topic: string, message: string) => {
    const entry = topics.get(topic)
    if (entry === undefined) return
    for (const handler of [...entry.handlers]) {
      try {
        handler(message)
      } catch {
        // As in the in-memory broker: isolate subscribers from one another.
      }
    }
  })

  return {
    async publish(topic, message) {
      await publisher.publish(topic, message)
    },
    async subscribe(topic, handler) {
      let entry = topics.get(topic)
      if (entry === undefined) {
        entry = { handlers: new Set(), ready: subscriber.subscribe(topic) }
        topics.set(topic, entry)
      }
      entry.handlers.add(handler)
      await entry.ready

      return async () => {
        const current = topics.get(topic)
        if (current === undefined) return
        current.handlers.delete(handler)
        if (current.handlers.size === 0) {
          topics.delete(topic)
          await subscriber.unsubscribe(topic)
        }
      }
    },
    async close() {
      topics.clear()
      await Promise.allSettled([publisher.quit(), subscriber.quit()])
    },
  }
}
