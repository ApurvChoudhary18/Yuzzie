/**
 * The Ink shell around the pure pieces: keys go to the reducer, board changes
 * re-clamp the selection, resizes re-lay it out, and the frame is printed line
 * by line. Nothing here decides layout or behaviour.
 */
import { Box, Text, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { frameLines } from './frame.js'
import { type BoardView, numbersOf } from './layout.js'
import { type Effect, initialNav, type NavAction, type NavState, reduce } from './state.js'
import { paintLine } from './text.js'
import type { Theme } from './theme.js'

/** Where the board comes from: the SDK in the app, a fixture in tests. */
export interface BoardSource {
  /** The current view; the same object until something changes. */
  view(): BoardView
  subscribe(listener: () => void): () => void
}

export interface AppProps {
  readonly source: BoardSource
  readonly theme: Theme
  readonly onEffect: (effect: Effect) => void
  /** Fixed size (tests); otherwise the terminal's, following resizes. */
  readonly width?: number
  readonly height?: number
  /** False when stdin cannot be put in raw mode, e.g. under a pipe. */
  readonly interactive?: boolean
}

/** How long a lone `g` waits for a second one (§8.4 `gg`). */
export const G_TIMEOUT_MS = 400

function keyName(
  input: string,
  key: {
    leftArrow: boolean
    rightArrow: boolean
    upArrow: boolean
    downArrow: boolean
    return: boolean
    escape: boolean
    ctrl: boolean
  },
): string {
  if (key.leftArrow) return 'left'
  if (key.rightArrow) return 'right'
  if (key.upArrow) return 'up'
  if (key.downArrow) return 'down'
  if (key.return) return 'enter'
  if (key.escape) return 'escape'
  if (key.ctrl && input === 'c') return 'ctrl-c'
  return input
}

export function App({ source, theme, onEffect, width, height, interactive = true }: AppProps) {
  const { stdout } = useStdout()
  const view = useSyncExternalStore(source.subscribe, source.view)
  const size = () => ({
    width: width ?? stdout.columns ?? 80,
    height: height ?? stdout.rows ?? 24,
  })

  const [nav, setNav] = useState<NavState>(() => {
    const { width: w, height: h } = size()
    return reduce(initialNav(w, h, view.columns.length), { type: 'data' }, numbersOf(view)).state
  })
  const navRef = useRef(nav)
  const viewRef = useRef(view)
  viewRef.current = view
  const gTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dispatch = useCallback(
    (action: NavAction) => {
      const step = reduce(navRef.current, action, numbersOf(viewRef.current))
      navRef.current = step.state
      setNav(step.state)
      for (const effect of step.effects) onEffect(effect)
      if (gTimer.current !== null) {
        clearTimeout(gTimer.current)
        gTimer.current = null
      }
      if (step.state.pendingG) {
        gTimer.current = setTimeout(() => dispatch({ type: 'gTimeout' }), G_TIMEOUT_MS)
      }
    },
    [onEffect],
  )

  // The board changed under us (cache → server, a live event): keep the selection valid.
  useEffect(() => {
    viewRef.current = view
    dispatch({ type: 'data' })
  }, [view, dispatch])

  useEffect(() => {
    if (width !== undefined && height !== undefined) {
      dispatch({ type: 'resize', width, height })
      return
    }
    const onResize = () =>
      dispatch({ type: 'resize', width: stdout.columns ?? 80, height: stdout.rows ?? 24 })
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout, width, height, dispatch])

  useEffect(
    () => () => {
      if (gTimer.current !== null) clearTimeout(gTimer.current)
    },
    [],
  )

  useInput((input, key) => dispatch({ type: 'key', key: keyName(input, key) }), {
    isActive: interactive,
  })

  const lines = frameLines(view, nav, theme).map((line) => paintLine(line, theme))
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional by nature
        <Text key={index} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}
