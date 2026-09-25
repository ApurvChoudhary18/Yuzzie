/**
 * `yuzie` with no arguments: the board, full screen (SPEC.md §7.1, §8).
 *
 * Paints from the local cache at once, before the network has answered
 * (§8.1: "Never blocks on the network"), then patches as the SDK's state
 * changes. Runs in the alternate screen buffer and leaves the terminal exactly
 * as it found it on `q`, Ctrl-C or SIGTERM.
 */

import { OfflineError } from '@yuzie/core'
import { openCache, type YuzieCache } from '@yuzie/store'
import type { Context } from '../context.js'
import { currentSlug } from '../session.js'
import { type EffectContext, ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, perform } from './effects.js'
import { renderFrame } from './frame.js'
import { SdkSource } from './source.js'
import { type Effect, initialNav, reduce } from './state.js'
import { detectTheme } from './theme.js'

const HOME = '\u001b[H'

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
        source.say(error instanceof Error ? error.message : String(error), 'warn')
      }
    },
  )
  if (offline) source.offline = true

  const theme = detectTheme(env, context.options.color === false ? { color: false } : {})
  const interactive = stdin.isTTY === true
  let finish: () => void = () => {}
  let suspend: EffectContext['suspend'] = async (run) => run()

  const effects: EffectContext = {
    board,
    source,
    env,
    stdout,
    doneColumn: async () => (await context.config()).config.flow.doneColumn,
    suspend: (run) => suspend(run),
    quit: () => finish(),
  }
  const onEffect = (effect: Effect) => perform(effect, effects)
  const onSuspend = (inkSuspend: EffectContext['suspend']) => {
    suspend = inkSuspend
  }

  // Paint the cached board with the pure renderer before Ink has even loaded
  // (it is most of our start-up time), then park the cursor at the top so
  // Ink's first frame lands exactly over this one.
  const width = stdout.columns ?? 80
  const height = stdout.rows ?? 24
  const first = source.view()
  const nav = reduce(initialNav(width, height, first.columns.length), { type: 'data' }, first).state
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
  const app = render(createElement(App, { source, theme, onEffect, interactive, onSuspend }), {
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
