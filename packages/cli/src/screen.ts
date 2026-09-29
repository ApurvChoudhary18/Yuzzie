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
