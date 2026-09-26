/**
 * Realtime in the TUI (§18 Session 10): the frame budget, the toast queue, the
 * connection status, presence emission and the per-card affordances — each
 * driven by a hand-held board, rendered through the real app where it shows.
 */
import type { EventEnvelope } from '@yuzie/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBoard, moved } from './__tests__/fake-board.js'
import { card, column, mountSource, person, settled, tick } from './__tests__/fixtures.js'
import { PresenceReporter } from './presence.js'
import { OFFLINE_AFTER_MS, SdkSource, TOAST_CAP } from './source.js'

const COLUMNS = [
  column('todo', 'Todo', 0, 'backlog'),
  column('doing', 'Doing', 1, 'in_progress'),
  column('done', 'Done', 2, 'terminal'),
]

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function setup(cards = [card(15, { title: 'Login flow' }), card(18, { title: 'Fix OAuth' })]) {
  const board = new FakeBoard(COLUMNS, cards)
  const source = new SdkSource(board.asBoard(), 'b')
  source.synced = true
  cleanup.push(() => source.dispose())
  return { board, source }
}

function render(source: SdkSource, columns = 100, rows = 30) {
  const app = mountSource(source, columns, rows, { onEffect: () => {} })
  cleanup.push(() => app.instance.unmount())
  return app
}

/** Move a card on the fake board the way a folded event would, and announce it. */
function move(board: FakeBoard, cardNo: number, to: string, actor = 'priya'): EventEnvelope {
  const current = board.state.cards[cardNo]
  if (current !== undefined)
    board.state = {
      ...board.state,
      cards: { ...board.state.cards, [cardNo]: { ...current, column: to } },
    }
  const event = moved(cardNo, to, actor)
  board.event(event)
  return event
}

describe('frame budget', () => {
  // Counted in simulated time, so a busy machine cannot change the answer:
  // only timers and the clock are faked; React and Ink run for real.
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Let Ink draw what React committed, without moving the clock. */
  const flush = () => vi.advanceTimersByTimeAsync(0)

  it('100 events in one second cause at most 20 renders', async () => {
    const { board, source } = setup()
    const app = render(source)
    await vi.advanceTimersByTimeAsync(200)
    const framesBefore = app.terminal.frames.length
    const notifiedBefore = source.notifications

    for (let index = 0; index < 100; index += 1) {
      move(board, index % 2 === 0 ? 15 : 18, index % 3 === 0 ? 'done' : 'doing')
      // 100 events, 10 ms apart: one second.
      await vi.advanceTimersByTimeAsync(10)
    }
    await flush()
    const renders = app.terminal.frames.length - framesBefore
    const notified = source.notifications - notifiedBefore
    expect(notified).toBeLessThanOrEqual(20)
    expect(renders).toBeLessThanOrEqual(20)
    // Coalesced, not dropped: the screen shows the board as it ended up.
    await vi.advanceTimersByTimeAsync(100)
    expect(app.terminal.lastFrame()).toMatch(/✓ @priya moved #1[58] /)
  })

  it('a burst reaches the screen within one frame', async () => {
    const { board, source } = setup()
    const app = render(source)
    await vi.advanceTimersByTimeAsync(200)
    move(board, 15, 'done')
    await vi.advanceTimersByTimeAsync(49)
    expect(app.terminal.lastFrame()).not.toContain('@priya moved #15')
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(app.terminal.lastFrame()).toContain('@priya moved #15')
  })
})

describe('toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('queue at most three; each waiting one still gets a second on screen', async () => {
    const { board, source } = setup()
    for (const [index, to] of ['doing', 'done', 'todo', 'doing', 'done'].entries())
      move(board, index % 2 === 0 ? 15 : 18, to)
    const first = source.view().toast
    expect(first?.text).toContain('#15')
    expect(first?.waiting).toBe(TOAST_CAP - 1)
    // The oldest waiting ones gave way to the newest: e0 shows, e3 and e4 wait.
    await vi.advanceTimersByTimeAsync(999)
    expect(source.view().toast?.text).toContain('#15')
    await vi.advanceTimersByTimeAsync(1)
    expect(source.view().toast?.text).toContain('Fix OAuth → Doing')
    expect(source.view().toast?.waiting).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(source.view().toast?.text).toContain('Login flow → Done')
    expect(source.view().toast?.waiting).toBe(0)
  })

  it('a lone toast shows for three seconds', async () => {
    const { board, source } = setup()
    move(board, 15, 'done')
    await vi.advanceTimersByTimeAsync(2_999)
    expect(source.view().toast?.text).toContain('moved #15')
    await vi.advanceTimersByTimeAsync(1)
    expect(source.view().toast).toBeNull()
  })

  it('shows the waiting count in the footer', async () => {
    const { board, source } = setup()
    const app = render(source)
    move(board, 15, 'done')
    move(board, 18, 'done')
    await vi.advanceTimersByTimeAsync(60)
    expect(app.terminal.lastFrame()).toMatch(/✓ @priya moved #15 Login flow → Done\s+\+1/)
  })
})

describe('connection status in the header', () => {
  it('synced → reconnecting… → offline · N queued → synced, never blocking keys', async () => {
    const { board, source } = setup()
    const app = render(source)
    await settled(app.terminal)
    expect(app.terminal.lastFrame()).toContain('● 0 online · synced')

    board.setStatus('reconnecting')
    await settled(app.terminal)
    expect(app.terminal.lastFrame()).toContain('⚠ reconnecting…')

    // Keys still work while the server is away.
    app.keyboard.write('j')
    await settled(app.terminal)
    expect(app.terminal.lastFrame()).toContain('▸#18')

    board.queued = 2
    source.invalidate()
    await settled(app.terminal)
    expect(app.terminal.lastFrame()).toContain('⚠ offline · 2 queued')

    board.setStatus('live')
    await settled(app.terminal)
    // Back: what queued up is sent, exactly once.
    expect(board.syncs).toBe(1)
    expect(app.terminal.lastFrame()).toContain('synced')
    expect(app.terminal.lastFrame()).toContain('Sent 2 queued changes')
  })

  it('reads as offline once reconnecting has gone on for a while', async () => {
    const { board, source } = setup()
    board.setStatus('reconnecting')
    expect(source.view().connection).toBe('reconnecting')
    await sleep(OFFLINE_AFTER_MS + 100)
    expect(source.view().connection).toBe('offline')
  })

  it('counts who is working next to who is online', async () => {
    const { board, source } = setup()
    board.presence = [
      person('priya', 15),
      person('sam', null),
      { ...person('claude', 18), kind: 'agent' },
    ]
    const app = render(source)
    await settled(app.terminal)
    expect(app.terminal.lastFrame()).toContain('● 3 online · 2 working · synced')
  })
})

describe('card affordances', () => {
  it('a moved card flashes once', async () => {
    const { board, source } = setup()
    move(board, 18, 'done')
    expect(source.view().flashes.has(18)).toBe(true)
    const app = render(source, 120, 30)
    await sleep(900)
    await settled(app.terminal)
    // No longer highlighted: the flash is over, and nothing else changed.
    expect(source.view().now - (source.view().flashes.get(18) ?? 0)).toBeGreaterThan(700)
  })

  it('a refused write shows ⟳ updated by the person who got there first', async () => {
    const { board, source } = setup()
    const app = render(source)
    move(board, 15, 'doing', 'priya')
    board.emit('conflict', { cardNo: 15, error: new Error('409'), current: null })
    await settled(app.terminal)
    expect(app.terminal.lastFrame()).toContain('#15⟳ Login flow')
    // Queued behind the move's own toast, then shown.
    expect(source.view().toast?.waiting).toBe(1)
    await sleep(1_050)
    expect(source.view().toast?.text).toContain('#15 updated by @priya; your edit was undone')
    app.keyboard.write('l')
    await tick()
    app.keyboard.write('\r')
    await settled(app.terminal)
    expect(app.terminal.lastFrame()).toContain('⟳ updated by @priya · your edit was undone')
  })

  it('the open card says who just changed it', async () => {
    const { board, source } = setup()
    const app = render(source)
    app.keyboard.write('\r')
    await settled(app.terminal)
    board.event({
      seq: 999,
      type: 'comment.created',
      actor: 'sam',
      cardNo: 15,
      payload: {
        commentId: '77777777-7777-4777-8777-000000000001',
        body: 'looks good',
        author: 'sam',
      },
      ts: new Date().toISOString(),
    } as EventEnvelope)
    await settled(app.terminal)
    expect(app.terminal.lastFrame()).toContain('⟳ updated by @sam')
  })

  it('recent pushes show ↑n on the card', async () => {
    const withBranch = card(15, {
      title: 'Login flow',
      git: {
        branch: 'task/15',
        baseBranch: 'main',
        commits: 3,
        filesChanged: 2,
        additions: 0,
        deletions: 0,
        pushed: true,
        prUrl: null,
        prState: null,
        lastActivityAt: new Date().toISOString(),
      },
    })
    const { board, source } = setup([withBranch])
    board.event({
      seq: 1000,
      type: 'card.commits.attached',
      actor: 'priya',
      cardNo: 15,
      payload: { shas: ['a3f9c21', '8b21e04', '5c7ba91'] },
      ts: new Date().toISOString(),
    } as EventEnvelope)
    const app = render(source)
    await settled(app.terminal)
    expect(app.terminal.lastFrame()).toContain('3c/2f ↑3')
  })

  it('agents are marked in the card footer', async () => {
    const { board, source } = setup()
    board.presence = [
      { ...person('claude', 15), kind: 'agent' },
      { ...person('priya', 15), state: 'viewing' },
    ]
    const app = render(source)
    app.keyboard.write('\r')
    await settled(app.terminal)
    expect(app.terminal.lastFrame()).toContain('● @claude (agent), @priya are working on this card')
  })
})

describe('presence emission', () => {
  function reporter(board: FakeBoard, branch: string | null = null) {
    let current = branch
    const presence = new PresenceReporter(board.asBoard(), async () => current)
    cleanup.push(() => presence.stop())
    return {
      presence,
      checkout: (next: string | null) => {
        current = next
      },
    }
  }

  it('viewing while a card is open; idle when it closes', async () => {
    const board = new FakeBoard(COLUMNS, [card(18, { title: 'Fix OAuth' })])
    const { presence } = reporter(board)
    await sleep(10)
    presence.view(18)
    presence.view(null)
    // Idle on arrival, viewing while open, idle again once closed.
    expect(board.sentPresence).toEqual([
      { state: 'idle' },
      { state: 'viewing', cardNo: 18 },
      { state: 'idle' },
    ])
  })

  it('working when the checked-out branch belongs to a card you claimed', async () => {
    const claimed = card(18, {
      title: 'Fix OAuth',
      assignees: ['rahul'],
      git: {
        branch: 'task/18-fix-oauth',
        baseBranch: 'main',
        commits: 0,
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        pushed: false,
        prUrl: null,
        prState: null,
        lastActivityAt: null,
      },
    })
    const board = new FakeBoard(COLUMNS, [claimed, card(15, { title: 'Login flow' })])
    const { presence } = reporter(board, 'task/18-fix-oauth')
    await sleep(20)
    expect(board.sentPresence.at(-1)).toEqual({
      state: 'working',
      cardNo: 18,
      branch: 'task/18-fix-oauth',
    })
    // Looking at another card is viewing; closing it goes back to working.
    presence.view(15)
    expect(board.sentPresence.at(-1)).toEqual({ state: 'viewing', cardNo: 15 })
    presence.view(null)
    expect(board.sentPresence.at(-1)).toMatchObject({ state: 'working', cardNo: 18 })
  })

  it('not working on a branch you have not claimed', async () => {
    const theirs = card(18, {
      assignees: ['priya'],
      git: {
        branch: 'task/18',
        baseBranch: 'main',
        commits: 0,
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        pushed: false,
        prUrl: null,
        prState: null,
        lastActivityAt: null,
      },
    })
    const board = new FakeBoard(COLUMNS, [theirs])
    reporter(board, 'task/18')
    await sleep(20)
    expect(board.sentPresence).toEqual([{ state: 'idle' }])
  })

  it('says it again after a reconnect, and clears on exit', async () => {
    const board = new FakeBoard(COLUMNS, [card(18)])
    const { presence } = reporter(board)
    await sleep(10)
    board.connected = false
    presence.view(18)
    expect(board.sentPresence).toEqual([{ state: 'idle' }])
    board.connected = true
    board.setStatus('live')
    expect(board.sentPresence.at(-1)).toEqual({ state: 'viewing', cardNo: 18 })
    presence.stop()
    expect(board.sentPresence.at(-1)).toEqual({ state: 'idle' })
  })
})
