/**
 * OS notifications for watched cards while the board is open (SPEC.md §18
 * Session 14). Off by default (`ui.notifications`); node-notifier is an
 * optional dependency, loaded only when asked for, and its absence is not an
 * error — the footer toast still says it.
 */
import type { Notify } from './source.js'

type Env = Readonly<Record<string, string | undefined>>

export async function osNotifier(enabled: boolean, env: Env): Promise<Notify | null> {
  if (!enabled || env.YUZIE_NO_NOTIFY === '1' || env.CI !== undefined) return null
  try {
    const { default: notifier } = await import('node-notifier')
    return (title, message) => {
      notifier.notify({ title, message, wait: false })
    }
  } catch {
    return null
  }
}
