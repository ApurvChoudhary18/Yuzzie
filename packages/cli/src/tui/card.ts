/**
 * The card detail view's scrolling body (SPEC.md §8.3): facts, description,
 * code and git, checklist, activity. Pure, like the board frame; the reducer
 * uses its height to keep scrolling in range.
 */
import type { Card } from '@yuzie/core'
import { plural, shortAge, shortDate } from '../render/text.js'
import type { ActivityEntry, BoardView } from './layout.js'
import { fitLine, type Line, lineWidth, seg, wrap } from './text.js'
import { makeTheme, type Theme } from './theme.js'

const LEFT_LABEL = 11
const RIGHT_LABEL = 10
/** Below this inner width the facts stack in one column. */
const TWO_COLUMN_MIN = 60
/** The panel shows the latest entries, oldest first (§18 Session 9: 50 entries). */
export const ACTIVITY_LIMIT = 50

function label(text: string, size: number): Line {
  return [seg(text.padEnd(size), 'dim')]
}

function orNone(values: readonly string[], theme: Theme, separator = ', '): Line {
  return values.length === 0 ? [seg(theme.glyphs.none, 'dim')] : [seg(values.join(separator))]
}

function assigneeValue(card: Card, view: BoardView, theme: Theme): Line {
  if (card.assignees.length === 0) return [seg(theme.glyphs.none, 'dim')]
  const line: Line = []
  card.assignees.forEach((handle, index) => {
    if (index > 0) line.push(seg(', '))
    line.push(seg(`@${handle}`, 'accent'))
    const presence = view.presence.find(
      (person) => person.handle === handle && person.cardNo === card.number,
    )
    if (presence !== undefined && presence.state !== 'online') {
      line.push(
        seg(` ${theme.glyphs.dot} `, presence.state === 'working' ? 'green' : 'accent'),
        seg(presence.state, 'dim'),
      )
    }
  })
  return line
}

function facts(card: Card, view: BoardView, width: number, theme: Theme): Line[] {
  const column = view.columns.find((candidate) => candidate.key === card.column)
  const pairs: Array<[string, Line, string, Line]> = [
    [
      'STATUS',
      [seg(column?.name ?? card.column, 'title')],
      'ASSIGNEE',
      assigneeValue(card, view, theme),
    ],
    [
      'PRIORITY',
      card.priority === null
        ? [seg(theme.glyphs.none, 'dim')]
        : [seg(`p${card.priority}`, card.priority <= 1 ? 'yellow' : undefined)],
      'WATCHERS',
      orNone(
        card.watchers.map((handle) => `@${handle}`),
        theme,
      ),
    ],
    [
      'LABELS',
      card.labels.length === 0
        ? [seg(theme.glyphs.none, 'dim')]
        : [seg(card.labels.join(' · '), 'chip')],
      'DUE',
      card.dueAt === null
        ? [seg(theme.glyphs.none, 'dim')]
        : [seg(shortDate(card.dueAt, new Date(view.now)))],
    ],
  ]

  if (width < TWO_COLUMN_MIN) {
    return pairs.flatMap(([left, leftValue, right, rightValue]) => [
      [...label(left, LEFT_LABEL), ...leftValue],
      [...label(right, LEFT_LABEL), ...rightValue],
    ])
  }
  const half = Math.floor(width / 2)
  return pairs.map(([left, leftValue, right, rightValue]) => [
    ...label(left, LEFT_LABEL),
    ...fitLine(leftValue, half - LEFT_LABEL, theme.glyphs.ellipsis),
    ...label(right, RIGHT_LABEL),
    ...rightValue,
  ])
}

/** `left` and, if it fits, `hint` flush with the middle of the panel. */
function withHint(left: Line, hint: string, width: number, theme: Theme): Line {
  const at = Math.max(Math.floor(width / 2), lineWidth(left) + 2)
  if (at + hint.length > width) return left
  return [...fitLine(left, at, theme.glyphs.ellipsis), seg(hint, 'dim')]
}

function codeAndGit(card: Card, width: number, theme: Theme): Line[] {
  const lines: Line[] = []
  if (card.anchor !== null) {
    const { path, line, endLine } = card.anchor
    const range =
      line === null ? '' : endLine === null || endLine === line ? `:${line}` : `:${line}-${endLine}`
    lines.push(
      withHint(
        [...label('CODE', LEFT_LABEL), seg(`${path}${range}`)],
        '[o] open in editor',
        width,
        theme,
      ),
    )
  }
  const git = card.git
  if (git?.branch) {
    lines.push(
      withHint(
        [...label('BRANCH', LEFT_LABEL), seg(git.branch, 'accent')],
        git.prUrl === null ? '[g] open branch' : '[g] open PR',
        width,
        theme,
      ),
    )
    const stats = [
      plural(git.commits, 'commit'),
      plural(git.filesChanged, 'file'),
      ...(git.pushed ? ['pushed'] : ['not pushed']),
      ...(git.prUrl === null
        ? []
        : [`PR ${prName(git.prUrl)}${git.prState === null ? '' : ` ${git.prState}`}`]),
    ]
    lines.push([...label('GIT', LEFT_LABEL), seg(stats.join(' · '))])
  } else {
    lines.push([
      ...label('BRANCH', LEFT_LABEL),
      seg('not linked — c to claim and start a branch', 'dim'),
    ])
  }
  return lines
}

function prName(url: string): string {
  const number = /\/pull\/(\d+)/.exec(url)?.[1]
  return number === undefined ? url : `#${number}`
}

function checklist(card: Card, theme: Theme): Line[] {
  const items = [...card.checklist].sort((a, b) => a.position - b.position)
  const done = items.filter((item) => item.doneAt !== null).length
  const lines: Line[] = [
    [
      seg('CHECKLIST', 'title'),
      ...(items.length === 0 ? [] : [seg(`  ${done}/${items.length}`, 'dim')]),
    ],
  ]
  if (items.length === 0) {
    lines.push([seg('  none — + to add one', 'dim')])
    return lines
  }
  for (const item of items) {
    lines.push([
      seg('  '),
      item.doneAt === null ? seg(theme.glyphs.open, 'dim') : seg(theme.glyphs.check, 'green'),
      seg(` ${String(item.position).padStart(2)}  `, 'dim'),
      seg(item.text, item.doneAt === null ? undefined : 'dim'),
    ])
  }
  return lines
}

/** Events for this card if they have been loaded; else what the card itself remembers. */
function activityEntries(card: Card, view: BoardView): readonly ActivityEntry[] | null {
  const loaded = view.activity.get(card.number)
  if (loaded !== undefined) return loaded
  return card.comments.map((comment) => ({
    at: Date.parse(comment.createdAt),
    who: `@${comment.author}`,
    text: `commented: "${comment.body.replace(/\s+/g, ' ')}"`,
  }))
}

function activity(card: Card, view: BoardView, width: number, theme: Theme): Line[] {
  const lines: Line[] = [[seg('ACTIVITY', 'title')]]
  const entries = activityEntries(card, view)
  if (entries === null) {
    lines.push([seg(`  loading${theme.glyphs.ellipsis}`, 'dim')])
    return lines
  }
  if (entries.length === 0) {
    lines.push([seg('  nothing yet', 'dim')])
    return lines
  }
  const shown = entries.slice(-ACTIVITY_LIMIT)
  if (entries.length > shown.length)
    lines.push([seg(`  ${entries.length - shown.length} older not shown`, 'dim')])
  for (const entry of shown) {
    const age = shortAge(view.now - entry.at).padStart(4)
    const prefix = `  ${age}  `
    const text = wrap(`${entry.who} ${entry.text}`, Math.max(10, width - prefix.length))
    text.forEach((part, index) => {
      if (index === 0) {
        const space = part.indexOf(' ')
        const who = space === -1 ? part : part.slice(0, space)
        lines.push([seg(prefix, 'dim'), seg(who, 'accent'), seg(part.slice(who.length))])
      } else lines.push([seg(' '.repeat(prefix.length)), seg(part)])
    })
  }
  return lines
}

/** Every line of the card view's body, for an inner width of `width - 4`. */
export function cardBody(card: Card, view: BoardView, width: number, theme: Theme): Line[] {
  const inner = Math.max(10, width - 4)
  const description =
    card.description === null || card.description.trim().length === 0
      ? [[seg('No description — e to write one.', 'dim')] as Line]
      : wrap(card.description, inner).map((text): Line => [seg(text)])
  return [
    [],
    ...facts(card, view, inner, theme),
    [],
    [seg('DESCRIPTION', 'title')],
    ...description,
    [],
    ...codeAndGit(card, inner, theme),
    [],
    ...checklist(card, theme),
    [],
    ...activity(card, view, inner, theme),
  ]
}

const COUNTING = makeTheme('plain', 'unicode')

/** How many lines the body has at this width: the reducer's scroll limit. */
export function cardBodyHeight(card: Card, view: BoardView, width: number): number {
  return cardBody(card, view, width, COUNTING).length
}
