/**
 * Per-connection outbound queue with a hard cap (SPEC.md §18 Session 4).
 *
 * `ws.send` never refuses: hand it frames faster than the peer reads and it
 * buffers them in memory without limit. One stalled laptop on hotel Wi-Fi would
 * then grow the server's heap for as long as the board stays busy.
 *
 * So frames are handed to the socket only while fewer than `maxInflightBytes`
 * are waiting to be flushed, and the rest wait here. If more than
 * `maxQueuedFrames` wait, the queue is discarded and the owner is told to reset
 * the client with a snapshot, which replaces everything that was dropped.
 */

/** The part of a `ws` WebSocket the queue needs, so it can be tested without one. */
export interface FrameSink {
  send(data: string, callback: (error?: Error) => void): void
}

export interface OutboundLimits {
  /** Frames allowed to wait in this queue before the client is reset. */
  readonly maxQueuedFrames: number
  /** Bytes handed to the socket but not yet flushed to the kernel. */
  readonly maxInflightBytes: number
}

export type EnqueueResult = 'queued' | 'overflow'

export class OutboundQueue {
  private queue: string[] = []
  private head = 0
  private inflightBytes = 0
  private drainWaiters: Array<() => void> = []
  private closed = false
  /** The deepest the queue has been; exposed so tests can prove it stayed bounded. */
  maxDepth = 0

  constructor(
    private readonly sink: FrameSink,
    private readonly limits: OutboundLimits,
  ) {}

  get depth(): number {
    return this.queue.length - this.head
  }

  /** Nothing waiting here and nothing unflushed in the socket. */
  get idle(): boolean {
    return this.depth === 0 && this.inflightBytes === 0
  }

  enqueue(frame: string): EnqueueResult {
    if (this.closed) return 'queued'
    if (this.depth >= this.limits.maxQueuedFrames) {
      this.clear()
      return 'overflow'
    }
    this.queue.push(frame)
    if (this.depth > this.maxDepth) this.maxDepth = this.depth
    this.pump()
    return 'queued'
  }

  /** Forget everything not yet handed to the socket. */
  clear(): void {
    this.queue = []
    this.head = 0
  }

  /** Resolves once every frame accepted so far has been flushed. */
  drained(): Promise<void> {
    if (this.idle || this.closed) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.push(resolve))
  }

  close(): void {
    this.closed = true
    this.clear()
    this.release()
  }

  private pump(): void {
    while (!this.closed && this.depth > 0 && this.inflightBytes < this.limits.maxInflightBytes) {
      const frame = this.queue[this.head] as string
      this.head += 1
      const size = Buffer.byteLength(frame)
      this.inflightBytes += size
      this.sink.send(frame, () => {
        // An error means the socket is gone; its close handler tidies up. Either
        // way the bytes are no longer in flight.
        this.inflightBytes -= size
        this.pump()
        if (this.idle) this.release()
      })
    }
    // Compact occasionally so a long-lived queue does not keep a dead prefix.
    if (this.head > 1024 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head)
      this.head = 0
    }
  }

  private release(): void {
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const resolve of waiters) resolve()
  }
}
