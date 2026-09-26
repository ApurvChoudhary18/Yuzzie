/**
 * What this TUI tells the board about its user (SPEC.md §8.5, §12.2):
 *
 * - viewing a card while it is open in the card view;
 * - working on a card when its branch is checked out here and the card is
 *   claimed (assigned to you) — re-checked as the board and the branch change;
 * - idle otherwise; and nothing at all once the TUI exits.
 *
 * Presence is transient, so a reconnect sends it again.
 */
import type { Board } from '@yuzie/sdk'

type Frame = { state: 'viewing' | 'working' | 'idle'; cardNo?: number; branch?: string }

/** How often the checked-out branch is looked at again. */
const BRANCH_POLL_MS = 5_000

export class PresenceReporter {
  private viewing: number | null = null
  private working: { cardNo: number; branch: string } | null = null
  private branch: string | null = null
  private sent = ''
  private readonly timer: ReturnType<typeof setInterval>
  private readonly unsubscribe: Array<() => void>
  private stopped = false

  constructor(
    private readonly board: Board,
    private readonly currentBranch: () => Promise<string | null>,
  ) {
    this.unsubscribe = [
      board.on('status', (status) => {
        // The server forgets presence with the connection: say it again.
        if (status === 'live') this.send(true)
      }),
      board.on('change', () => this.derive()),
    ]
    this.timer = setInterval(() => void this.poll(), BRANCH_POLL_MS)
    this.timer.unref?.()
    void this.poll()
  }

  /** The card view opened on `cardNo`, or closed (`null`). */
  view(cardNo: number | null): void {
    this.viewing = cardNo
    this.send()
  }

  private async poll(): Promise<void> {
    const branch = await this.currentBranch().catch(() => null)
    if (this.stopped) return
    this.branch = branch
    this.derive()
  }

  /** Working: this branch belongs to a card I am on. */
  private derive(): void {
    const me = this.board.handle
    const branch = this.branch
    const card =
      me === null || branch === null
        ? undefined
        : Object.values(this.board.state.cards).find(
            (candidate) => candidate.git?.branch === branch && candidate.assignees.includes(me),
          )
    this.working = card === undefined || branch === null ? null : { cardNo: card.number, branch }
    this.send()
  }

  frame(): Frame {
    const working = this.working
    if (this.viewing !== null && this.viewing !== working?.cardNo)
      return { state: 'viewing', cardNo: this.viewing }
    if (working !== null)
      return { state: 'working', cardNo: working.cardNo, branch: working.branch }
    return { state: 'idle' }
  }

  private send(force = false): void {
    if (this.stopped) return
    const frame = this.frame()
    const key = JSON.stringify(frame)
    if (!force && key === this.sent) return
    // Not connected: remember nothing was sent, so the next chance sends it.
    this.sent = this.board.setPresence(frame) ? key : ''
  }

  /** On the way out: say so, then stop. Closing the stream clears it on the server too. */
  stop(): void {
    if (this.stopped) return
    this.board.setPresence({ state: 'idle' })
    this.stopped = true
    clearInterval(this.timer)
    for (const off of this.unsubscribe) off()
  }
}
