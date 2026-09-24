import { describe, expect, it } from 'vitest'
import { type FrameSink, OutboundQueue } from './realtime/outbound.js'

/** A socket whose flushes complete only when the test says so. */
function manualSink() {
  const sent: string[] = []
  const callbacks: Array<(error?: Error) => void> = []
  const sink: FrameSink = {
    send(data, callback) {
      sent.push(data)
      callbacks.push(callback)
    },
  }
  return {
    sink,
    sent,
    /** Complete the oldest outstanding write. */
    flush(count = 1) {
      for (let index = 0; index < count; index += 1) callbacks.shift()?.()
    },
    get outstanding() {
      return callbacks.length
    },
  }
}

describe('OutboundQueue', () => {
  it('hands frames straight to the socket while under the in-flight budget', () => {
    const socket = manualSink()
    const queue = new OutboundQueue(socket.sink, { maxQueuedFrames: 10, maxInflightBytes: 100 })
    queue.enqueue('a'.repeat(40))
    queue.enqueue('b'.repeat(40))
    expect(socket.sent).toHaveLength(2)
    expect(queue.depth).toBe(0)
  })

  it('holds frames once the socket has enough unflushed bytes, and releases them in order', () => {
    const socket = manualSink()
    const queue = new OutboundQueue(socket.sink, { maxQueuedFrames: 10, maxInflightBytes: 100 })
    for (const letter of 'abcde') queue.enqueue(letter.repeat(60))
    // 60 bytes in flight is under 100, so a second goes; 120 is over, so the rest wait.
    expect(socket.sent.map((frame) => frame[0])).toEqual(['a', 'b'])
    expect(queue.depth).toBe(3)

    socket.flush(2)
    expect(socket.sent.map((frame) => frame[0])).toEqual(['a', 'b', 'c', 'd'])
    socket.flush(2)
    expect(socket.sent.map((frame) => frame[0])).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(queue.depth).toBe(0)
  })

  it('discards the backlog and reports overflow past the frame cap, without ever exceeding it', () => {
    const socket = manualSink()
    const queue = new OutboundQueue(socket.sink, { maxQueuedFrames: 3, maxInflightBytes: 1 })
    expect(queue.enqueue('first')).toBe('queued')
    expect(queue.enqueue('2')).toBe('queued')
    expect(queue.enqueue('3')).toBe('queued')
    expect(queue.enqueue('4')).toBe('queued')
    expect(queue.depth).toBe(3)
    expect(queue.enqueue('5')).toBe('overflow')
    expect(queue.depth).toBe(0)
    expect(queue.maxDepth).toBe(3)

    // The frame already handed to the socket still completes; nothing else was sent.
    socket.flush()
    expect(socket.sent).toEqual(['first'])
  })

  it('resolves drained() only once everything accepted has been flushed', async () => {
    const socket = manualSink()
    const queue = new OutboundQueue(socket.sink, { maxQueuedFrames: 10, maxInflightBytes: 1 })
    queue.enqueue('x')
    queue.enqueue('y')
    let drained = false
    const waiting = queue.drained().then(() => {
      drained = true
    })

    socket.flush()
    await Promise.resolve()
    expect(drained).toBe(false)
    socket.flush()
    await waiting
    expect(drained).toBe(true)
    expect(queue.idle).toBe(true)
    await queue.drained()
  })

  it('stops sending and releases waiters when closed', async () => {
    const socket = manualSink()
    const queue = new OutboundQueue(socket.sink, { maxQueuedFrames: 10, maxInflightBytes: 1 })
    queue.enqueue('x')
    queue.enqueue('y')
    const waiting = queue.drained()
    queue.close()
    await waiting
    expect(queue.enqueue('z')).toBe('queued')
    socket.flush(5)
    expect(socket.sent).toEqual(['x'])
    await queue.drained()
  })

  it('keeps its memory compact across a long run', () => {
    const socket = manualSink()
    const queue = new OutboundQueue(socket.sink, { maxQueuedFrames: 5_000, maxInflightBytes: 1 })
    for (let index = 0; index < 4_000; index += 1) queue.enqueue(String(index))
    socket.flush(3_000)
    expect(queue.depth).toBe(999)
    socket.flush(1_000)
    expect(socket.sent).toHaveLength(4_000)
    expect(socket.sent.at(-1)).toBe('3999')
  })
})
