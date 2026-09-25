/**
 * `yuzie` with no arguments: the board, full screen (SPEC.md §7.1, §8).
 *
 * Paints from the local cache at once, before the network has answered
 * (§8.1: "Never blocks on the network"), then patches as the SDK's state
 * changes. Runs in the alternate screen buffer and leaves the terminal exactly
 * as it found it on `q`, Ctrl-C or SIGTERM.
 */

import { OfflineError } from '@yuzie/core'
import { type Board, matchColumn } from '@yuzie/sdk'
import { openCache, type YuzieCache } from '@yuzie/store'
import type { Context } from '../context.js'
import { actor, describeEvent } from '../render/events.js'
import { currentSlug } from '../session.js'
import type { BoardSource } from './App.js'
import { renderFrame } from './frame.js'
import { type BoardView, type Connection, numbersOf, viewColumns } from './layout.js'
import { type Effect, initialNav, reduce } from './state.js'
import { detectTheme } from './theme.js'

const ENTER_ALT_SCREEN = '\u001b[?1049h\u001b[?25l'
const LEAVE_ALT_SCREEN = '\u001b[?25h\u001b[?1049l'
const HOME = '\u001b[H'
const TOAST_MS = 3_000

/** What a key does until its screen exists: say how to do it from the CLI instead. */
function laterHint(effect: Effect): string | null {
  switch (effect.type) {
    case 'open':
      return `Card view is on its way. For now: yuzie card ${effect.cardNo}`
    case 'new':
      return 'Inline new-card is on its way. For now: yuzie add "…"'
    case 'move':
      return `Column picker is on its way. For now: yuzie move ${effect.cardNo} <column>`
    case 'assign':
      return `Member picker is on its way. For now: yuzie assign ${effect.cardNo} @someone`
    case 'comment':
      return `Comment box is on its way. For now: yuzie comment ${effect.cardNo} "…"`
    case 'edit':
      return `For now: yuzie edit ${effect.cardNo}`
    case 'delete':
      return `For now: yuzie rm ${effect.cardNo}`
    case 'claim':
      return 'Claiming arrives with git integration.'
    case 'openAnchor':
    case 'openBranch':
      return 'Opening code and branches arrives with git integration.'
    case 'search':
      return 'Search is on its way. For now: yuzie list --search …'
    case 'filter':
      return 'Filters are on its way. For now: yuzie list --mine / --label …'
    default:
      return null
  }
}

/** Adapts an SDK board to what the app renders. */
class SdkSource implements BoardSource {
  private cached: BoardView | null = null
  private readonly listeners = new Set<() => void>()
  private toast: BoardView['toast'] = null
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  offline = false
  /** The first sync with the server has finished; until then the cache is all we have. */
  synced = false

  constructor(
    private readonly board: Board,
    private readonly slug: string,
  ) {
    board.on('change', () => this.invalidate())
    board.on('presence', () => this.invalidate())
    board.on('status', () => this.invalidate())
    board.on('*', (event) =>
      this.say(`${actor(event)} ${describeEvent(event, board.state)}`, 'event'),
    )
  }

  say(text: string, kind: 'event' | 'info'): void {
    this.toast = { text, at: Date.now(), kind }
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
    // Repaint once it has expired, so it goes away without a keypress.
    this.toastTimer = setTimeout(() => this.invalidate(), TOAST_MS + 50)
    this.invalidate()
  }

  invalidate(): void {
    this.cached = null
    for (const listener of this.listeners) listener()
  }

  view = (): BoardView => {
    if (this.cached !== null) return this.cached
    const state = this.board.state
    const status = this.board.status
    const connection: Connection = this.offline
      ? 'offline'
      : !this.synced
        ? 'connecting'
        : status === 'live'
          ? 'live'
          : status === 'reconnecting'
            ? 'reconnecting'
            : 'connecting'
    this.cached = {
      slug: this.slug,
      columns: viewColumns(state.columns, Object.values(state.cards)),
      presence: this.board.presence,
      connection,
      queued: this.board.queued,
      toast: this.toast,
      now: Date.now(),
    }
    return this.cached
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
  }
}

export async function startTui(context: Context): Promise<number> {
  const slug = await currentSlug(context)
  const client = await context.client()
  const env = context.io.env
  const stdout = context.io.stdout as NodeJS.WriteStream
  const stdin = context.io.stdin as NodeJS.ReadStream

  let cache: YuzieCache | undefined
  try {
    cache = openCache({ boardSlug: slug, cwd: context.io.cwd, home: context.home, env })
  } catch {
    cache = undefined
  }

  const offline = context.options.offline === true
  const board = client.board(slug, {
    realtime: !offline,
    offline: 'queue',
    ...(cache === undefined ? {} : { cache }),
  })
  const source = new SdkSource(board, slug)

  // Not awaited: `open()` fills the state from the cache before its first
  // network call, so the first frame can show cached cards straight away.
  const opening = board.open().then(
    () => {
      source.synced = true
      source.invalidate()
    },
    (error: unknown) => {
      if (error instanceof OfflineError) {
        source.offline = true
        source.invalidate()
      } else {
        source.say(error instanceof Error ? error.message : String(error), 'info')
      }
    },
  )
  if (offline) source.offline = true

  const theme = detectTheme(env, context.options.color === false ? { color: false } : {})
  const interactive = stdin.isTTY === true
  let finish: () => void = () => {}

  const onEffect = (effect: Effect) => {
    const run = async () => {
      switch (effect.type) {
        case 'quit':
          finish()
          return
        case 'refresh':
          await board.refresh()
          source.say('Refreshed', 'info')
          return
        case 'watch': {
          const me = board.handle
          const card = board.state.cards[effect.cardNo]
          const watching = me !== null && card?.watchers.includes(me) === true
          await board.cards.watch(effect.cardNo, !watching)
          source.say(`${watching ? 'Stopped watching' : 'Watching'} #${effect.cardNo}`, 'info')
          return
        }
        case 'done': {
          const { config } = await context.config()
          const column =
            matchColumn(board.state.columns, config.flow.doneColumn) ??
            board.state.columns.find((c) => c.semantics === 'terminal')
          if (column === undefined) {
            source.say('This board has no done column.', 'info')
            return
          }
          await board.cards.move(effect.cardNo, column.key)
          return
        }
        default: {
          const hint = laterHint(effect)
          if (hint !== null) source.say(hint, 'info')
        }
      }
    }
    run().catch((error: unknown) =>
      source.say(error instanceof Error ? error.message : String(error), 'info'),
    )
  }

  // Paint the cached board with the pure renderer before Ink has even loaded
  // (it is most of our start-up time), then park the cursor at the top so
  // Ink's first frame lands exactly over this one.
  const width = stdout.columns ?? 80
  const height = stdout.rows ?? 24
  const first = source.view()
  const nav = reduce(
    initialNav(width, height, first.columns.length),
    { type: 'data' },
    numbersOf(first),
  ).state
  stdout.write(`${ENTER_ALT_SCREEN}${renderFrame(first, nav, theme)}${HOME}`)
  const restore = () => stdout.write(LEAVE_ALT_SCREEN)

  let quitting = false
  finish = () => {
    quitting = true
  }
  const onTerm = () => finish()
  // `on`, not `once`: Ink's signal-exit re-raises the signal if it finds itself
  // the only listener left, which would kill us before the terminal is restored.
  process.on('SIGTERM', onTerm)

  const [{ render }, { createElement }, { App }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./App.js'),
  ])
  const app = render(createElement(App, { source, theme, onEffect, interactive }), {
    stdout,
    stdin,
    // We only get here for a terminal (or YUZIE_FORCE_TUI); Ink's own guess
    // would hold every frame back until exit under CI=1 or a piped stdout.
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  finish = () => app.unmount()
  if (quitting) finish()

  // Bounded, so an unanswered close cannot hold the terminal hostage.
  const stop = context.io.stop
  if (stop !== undefined) void stop.then(() => finish())

  try {
    await app.waitUntilExit()
  } finally {
    process.off('SIGTERM', onTerm)
    restore()
    source.dispose()
    context.abortRequests()
    await Promise.race([opening, new Promise((resolve) => setTimeout(resolve, 200))])
    await board.close()
    cache?.close()
  }
  return 0
}
