/**
 * The Ink shell around the pure pieces: keys go to the reducer, board changes
 * re-clamp the selection, resizes re-lay it out, and the frame is printed line
 * by line. Nothing here decides layout or behaviour.
 */
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { frameLines } from './frame.js'
import type { BoardView } from './layout.js'
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
  /**
   * Receives Ink's `suspendTerminal`, which hands the terminal to a child
   * process (`$EDITOR`) and takes it back with a full redraw.
   */
  readonly onSuspend?: (suspend: (run: () => Promise<void>) => Promise<void>) => void
}

/** How long a lone `g` waits for a second one (§8.4 `gg`). */
export const G_TIMEOUT_MS = 400

interface InkKey {
  leftArrow: boolean
  rightArrow: boolean
  upArrow: boolean
  downArrow: boolean
  return: boolean
  escape: boolean
  ctrl: boolean
  backspace: boolean
  delete: boolean
  tab: boolean
}

/** Ink's key event as a reducer action: a named key, a character, or a paste. */
export function keyAction(input: string, key: InkKey): NavAction | null {
  if (key.leftArrow) return { type: 'key', key: 'left' }
  if (key.rightArrow) return { type: 'key', key: 'right' }
  if (key.upArrow) return { type: 'key', key: 'up' }
  if (key.downArrow) return { type: 'key', key: 'down' }
  if (key.return) return { type: 'key', key: 'enter' }
  if (key.escape) return { type: 'key', key: 'escape' }
  if (key.backspace || key.delete) return { type: 'key', key: 'backspace' }
  if (key.tab) return { type: 'key', key: 'tab' }
  if (key.ctrl) return input.length === 1 ? { type: 'key', key: `ctrl-${input}` } : null
  if (input.length === 0) return null
  // More than one character at once is a paste, never a key name.
  if ([...input].length > 1) return { type: 'paste', text: input }
  return { type: 'key', key: input }
}

export function App({
  source,
  theme,
  onEffect,
  width,
  height,
  interactive = true,
  onSuspend,
}: AppProps) {
  const { stdout } = useStdout()
  const { suspendTerminal } = useApp()
  const view = useSyncExternalStore(source.subscribe, source.view)
  const size = () => ({
    width: width ?? stdout.columns ?? 80,
    height: height ?? stdout.rows ?? 24,
  })

  const [nav, setNav] = useState<NavState>(() => {
    const { width: w, height: h } = size()
    return reduce(initialNav(w, h, view.columns.length), { type: 'data' }, view).state
  })
  const navRef = useRef(nav)
  const viewRef = useRef(view)
  viewRef.current = view
  const gTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dispatch = useCallback(
    (action: NavAction) => {
      const step = reduce(navRef.current, action, viewRef.current)
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

  useEffect(() => {
    onSuspend?.((run) => suspendTerminal(run))
  }, [onSuspend, suspendTerminal])

  useInput(
    (input, key) => {
      const action = keyAction(input, key)
      if (action !== null) dispatch(action)
    },
    { isActive: interactive },
  )

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
