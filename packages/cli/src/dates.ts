/**
 * `--due` in plain words (SPEC.md §7.2): `friday`, `tomorrow`, `+3d`, `2026-10-02`.
 *
 * A due *day* means the end of that day, local time: "due friday" is met by
 * anything finished before Friday is over. A full ISO timestamp is taken as is.
 * `none` (or `clear`, `-`) removes the due date.
 */
import { UsageError } from './exit.js'

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function endOfDay(date: Date): Date {
  const end = new Date(date)
  end.setHours(23, 59, 59, 999)
  return end
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function weekday(word: string): number | null {
  const index = WEEKDAYS.findIndex(
    (day) => day === word || (word.length >= 3 && day.startsWith(word)),
  )
  return index === -1 ? null : index
}

/** The due timestamp as ISO, `null` to clear it. Throws a usage error it can explain. */
export function parseDue(input: string, now: Date = new Date()): string | null {
  const text = input.trim().toLowerCase()
  if (['none', 'clear', '-', 'never'].includes(text)) return null
  if (text === 'today') return endOfDay(now).toISOString()
  if (text === 'tomorrow') return endOfDay(addDays(now, 1)).toISOString()

  const relative = /^(?:\+|in\s+)?(\d+)\s*(d|day|days|w|wk|week|weeks)$/.exec(text)
  if (relative !== null) {
    const amount = Number(relative[1])
    const days = (relative[2] as string).startsWith('w') ? amount * 7 : amount
    return endOfDay(addDays(now, days)).toISOString()
  }

  // `friday` is the next Friday (a week away if today is Friday); `next friday` too.
  const named = /^(?:next\s+)?([a-z]+)$/.exec(text)
  if (named !== null) {
    const target = weekday(named[1] as string)
    if (target !== null) {
      const ahead = (target - now.getDay() + 7) % 7 || 7
      return endOfDay(addDays(now, ahead)).toISOString()
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number) as [number, number, number]
    const date = new Date(year, month - 1, day)
    if (date.getMonth() === month - 1 && date.getDate() === day) return endOfDay(date).toISOString()
  } else if (/^\d{4}-\d{2}-\d{2}t/.test(text)) {
    const date = new Date(input.trim())
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }

  throw new UsageError(
    `Cannot read "${input}" as a date.`,
    'Try `friday`, `tomorrow`, `+3d`, `2026-10-02`, or `none`.',
  )
}

/** `2d`, `36h`, `1w` → milliseconds, for `--stale` and `--since`. */
export function parseDuration(input: string): number {
  const match = /^(\d+)\s*(m|min|h|d|w)$/i.exec(input.trim())
  if (match === null) {
    throw new UsageError(`Cannot read "${input}" as a duration.`, 'Try `30m`, `12h`, `2d` or `1w`.')
  }
  const amount = Number(match[1])
  const unit = (match[2] as string).toLowerCase()
  const minute = 60_000
  const scale =
    unit === 'm' || unit === 'min'
      ? minute
      : unit === 'h'
        ? 60 * minute
        : unit === 'd'
          ? 1440 * minute
          : 10_080 * minute
  return amount * scale
}

/** `p0`…`p3`, `0`…`3`, or `none`. */
export function parsePriority(input: string): 0 | 1 | 2 | 3 | null {
  const text = input.trim().toLowerCase()
  if (['none', 'clear', '-'].includes(text)) return null
  const match = /^p?([0-3])$/.exec(text)
  if (match === null)
    throw new UsageError(`Priority must be p0, p1, p2, p3 or none, not "${input}".`)
  return Number(match[1]) as 0 | 1 | 2 | 3
}
