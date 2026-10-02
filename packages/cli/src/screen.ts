/**
 * Whether the board owns the terminal right now (alternate screen, raw mode),
 * and how to give it back. The process-wide signal and crash handlers in
 * main.ts leave a running board to its own clean exit, and restore the
 * terminal themselves only when that exit cannot happen (§18 Session 16).
 */
export const screen = {
  active: false,
  restore: (): void => {},
}

/**
 * A command supervising a child process (`yuzie serve`) handles Ctrl-C itself:
 * it passes the signal on and exits once the child has stopped, so main.ts
 * must not exit first and leave the child running.
 */
export const supervisor = {
  active: false,
}
