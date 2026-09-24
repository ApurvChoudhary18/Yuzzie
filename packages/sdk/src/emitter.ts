/** A tiny typed emitter; a throwing listener never stops the others. */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>()

  on<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(handler as (payload: never) => void)
    return () => {
      set.delete(handler as (payload: never) => void)
    }
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type)
    if (set === undefined) return
    for (const handler of [...set]) {
      try {
        ;(handler as (payload: Events[K]) => void)(payload)
      } catch {
        // A broken subscriber must not break the stream for everyone else.
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
