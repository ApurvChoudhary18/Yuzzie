/**
 * Small text helpers the human formatters share (SPEC.md §7.3): relative
 * times, truncation, and padding that counts characters, not UTF-16 units.
 */

/** Visible length. Code points, so `…` and `●` count as one. */
export function width(text: string): number {
  return [...text].length
}

/** Cut to at most `max` characters, ending in `…` when anything was cut. */
export function truncate(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  if (max <= 1) return '…'.slice(0, max)
  return `${chars.slice(0, max - 1).join('')}…`
}

export function pad(text: string, size: number): string {
  const missing = size - width(text)
  return missing > 0 ? text + ' '.repeat(missing) : text
}

/** `2m`, `3h`, `1d` — the ACT column in §7.3. */
export function shortAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (days < 30) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (days < 365) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

/** `2m ago`, `just now` — prose timestamps. */
export function ago(ms: number): string {
  return ms < 10_000 ? 'just now' : `${shortAge(ms)} ago`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Fri 3 Oct`, with the year only when it is not this year. */
export function shortDate(iso: string, now: Date): string {
  const date = new Date(iso)
  const base = `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`
}

/** `09:14`, local time. */
export function clock(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** `p1`, or `—`. */
export function priorityLabel(priority: number | null): string {
  return priority === null ? '—' : `p${priority}`
}
