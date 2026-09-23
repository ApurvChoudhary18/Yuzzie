/**
 * Retry pacing for the outbox.
 *
 * The same curve the realtime client uses for reconnects (SPEC.md §12.2):
 * 0.5s, 1, 2, 4, 8, capped at 30s, with jitter so a fleet of clients coming back
 * online together does not arrive as a thundering herd.
 */
export const BASE_DELAY_MS = 500
export const MAX_DELAY_MS = 30_000

/**
 * Delay before attempt number `attempts` (1 = the first retry).
 *
 * `jitter` is a 0..1 fraction, injectable so tests are deterministic.
 */
export function backoffDelayMs(attempts: number, jitter = Math.random()): number {
  if (attempts <= 0) return 0
  const exponential = Math.min(BASE_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS)
  // Full jitter over the bottom half of the window: never shorter than half the
  // nominal delay, never longer than the nominal delay.
  return Math.round(exponential * (0.5 + 0.5 * jitter))
}
