import type { EventEnvelope } from '@yuzie/core'
import { describe, expect, it, vi } from 'vitest'
import { createEventBus } from './services/event-bus.js'

const event = (seq: number): EventEnvelope => ({
  seq,
  type: 'card.deleted',
  actor: 'rahul',
  cardNo: 18,
  ts: '2026-08-19T09:14:22Z',
  payload: { number: 18 },
})

describe('createEventBus', () => {
  it('delivers committed events to every subscriber', () => {
    const bus = createEventBus()
    const first = vi.fn()
    const second = vi.fn()
    bus.subscribe(first)
    bus.subscribe(second)

    bus.publish('board-1', [event(1), event(2)])

    expect(first).toHaveBeenCalledWith('board-1', [event(1), event(2)])
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('does not notify anyone for an empty batch', () => {
    const bus = createEventBus()
    const listener = vi.fn()
    bus.subscribe(listener)
    bus.publish('board-1', [])
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops delivering after unsubscribe', () => {
    const bus = createEventBus()
    const listener = vi.fn()
    const unsubscribe = bus.subscribe(listener)

    bus.publish('board-1', [event(1)])
    unsubscribe()
    bus.publish('board-1', [event(2)])

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('isolates a throwing subscriber from the others', () => {
    const bus = createEventBus()
    const healthy = vi.fn()
    bus.subscribe(() => {
      throw new Error('subscriber is broken')
    })
    bus.subscribe(healthy)

    // The write already committed; a broken listener must not undo it.
    expect(() => bus.publish('board-1', [event(1)])).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
  })
})
