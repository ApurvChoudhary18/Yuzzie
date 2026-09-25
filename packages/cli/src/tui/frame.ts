/**
 * The board view, drawn (SPEC.md §8.2, §8.5, §8.6).
 *
 * A pure function of the view, the navigation state and the theme. It returns
 * exactly `height` lines, each exactly `width` characters wide before escapes,
 * so the terminal never wraps or shears whatever size it is.
 */
import type { Card, Presence } from '@yuzie/core'
import {
  BOARD_CHROME,
  type BoardView,
  boardGeometry,
  isNarrow,
  isTooSmall,
  type ListEntry,
  listEntries,
  listRows,
  type ViewColumn,
} from './layout.js'
import type { NavState } from './state.js'
import {
  fitLine,
  invert,
  type Line,
  lineWidth,
  paintLine,
  plainLine,
  seg,
  textWidth,
} from './text.js'
import type { Theme } from './theme.js'

const DAY = 86_400_000
const TOAST_MS = 3_000

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

function lastActivity(card: Card): number {
  const git = card.git?.lastActivityAt
  return Math.max(Date.parse(card.updatedAt), git ? Date.parse(git) : 0)
}

/** `@rahul ● 3c/7f ⚠3d  p1 bug` — everything under the title (§8.2, §8.5). */
function metaLine(card: Card, column: ViewColumn, view: BoardView, theme: Theme): Line {
  const g = theme.glyphs
  const parts: Line = []
  const [first, ...rest] = card.assignees
  parts.push(
    first === undefined
      ? seg(g.none, 'dim')
      : seg(`@${first}${rest.length > 0 ? `+${rest.length}` : ''}`, 'accent'),
  )

  // Presence on this card: someone working on it, or looking at it right now.
  const here = view.presence.filter(
    (person: Presence) => person.cardNo === card.number && person.state !== 'online',
  )
  if (here.some((person) => person.state === 'working')) parts.push(seg(' '), seg(g.dot, 'green'))
  else if (here.length > 0) parts.push(seg(' '), seg(g.dot, 'accent'))

  if (card.git?.branch)
    parts.push(seg(' '), seg(`${card.git.commits}c/${card.git.filesChanged}f`, 'dim'))

  const idleDays = Math.floor((view.now - lastActivity(card)) / DAY)
  const active = column.semantics !== 'terminal' && column.semantics !== 'backlog'
  if (idleDays >= 3 && active) parts.push(seg(' '), seg(`${g.warn}${idleDays}d`, 'yellow'))
  else if (idleDays >= 1) parts.push(seg(' '), seg(`${idleDays}d`, 'dim'))

  const chips = [
    ...(card.priority === null ? [] : [`p${card.priority}`]),
    ...card.labels.slice(0, 2),
  ]
  if (chips.length > 0) parts.push(seg('  '), seg(chips.join(' '), 'chip'))
  return parts
}

function titleLine(card: Card, selected: boolean, theme: Theme): Line {
  return [
    seg(selected ? theme.glyphs.marker : ' ', selected ? 'accent' : undefined),
    seg(`#${card.number} `, 'dim'),
    seg(card.title, selected ? 'title' : undefined),
  ]
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function statusText(view: BoardView, theme: Theme): Line {
  const g = theme.glyphs
  const online = view.presence.length
  switch (view.connection) {
    case 'offline':
      return [seg(`${g.warn} offline · ${view.queued} queued`, 'yellow')]
    case 'reconnecting':
      return [seg(`${g.warn} reconnecting${g.ellipsis}`, 'yellow')]
    case 'connecting':
      return [seg(`${g.dot} `, 'dim'), seg(`connecting${g.ellipsis}`, 'dim')]
    case 'live':
      return [
        seg(`${g.dot} `, 'green'),
        seg(`${online} online · ${view.queued > 0 ? `${view.queued} queued` : 'synced'}`),
      ]
  }
}

function header(view: BoardView, width: number, theme: Theme): Line {
  const g = theme.glyphs
  const title: Line = [seg(`${g.tl} `, 'border'), seg('yuzie', 'title'), seg(` · ${view.slug} `)]
  const status = statusText(view, theme)
  const room = width - lineWidth(title) - lineWidth(status) - 4
  if (room < 1)
    return fitLine(
      [
        ...title,
        seg(g.h.repeat(Math.max(0, width - lineWidth(title) - 1)), 'border'),
        seg(g.tr, 'border'),
      ],
      width,
      g.ellipsis,
    )
  return [
    ...title,
    seg(g.h.repeat(room), 'border'),
    seg(' '),
    ...status,
    seg(` ${g.h}`, 'border'),
    seg(g.tr, 'border'),
  ]
}

const HINTS = [
  ['?', 'help'],
  ['/', 'search'],
  ['n', 'new'],
  ['c', 'claim'],
  ['m', 'move'],
  ['a', 'assign'],
  ['ENTER', 'open'],
  ['q', 'quit'],
] as const

function hints(theme: Theme): Line {
  const line: Line = []
  HINTS.forEach(([key, what], index) => {
    if (index > 0) line.push(seg('  '))
    line.push(seg(key === 'ENTER' ? theme.glyphs.enter : key, 'accent'), seg(` ${what}`, 'dim'))
  })
  return line
}

function toastLine(view: BoardView, theme: Theme): Line {
  if (view.toast === null || view.now - view.toast.at > TOAST_MS) return []
  if (view.toast.kind === 'info') return [seg('→ ', 'accent'), seg(view.toast.text, 'dim')]
  return [seg(`${theme.glyphs.check} `, 'green'), seg(view.toast.text)]
}

/** `│ content │` — a row of the outer frame. */
function framed(content: Line, width: number, theme: Theme, left = ' ', right = ' '): Line {
  const g = theme.glyphs
  return [
    seg(g.v, 'border'),
    seg(left, 'dim'),
    ...fitLine(content, width - 4, g.ellipsis),
    seg(right, 'dim'),
    seg(g.v, 'border'),
  ]
}

function bottom(width: number, theme: Theme): Line {
  const g = theme.glyphs
  return [seg(`${g.bl}${g.h.repeat(Math.max(0, width - 2))}${g.br}`, 'border')]
}

function helpLines(theme: Theme): Line[] {
  const g = theme.glyphs
  const rows: Array<[string, string]> = [
    [`${g.left}${g.right}  h l`, 'columns'],
    [`${g.up}${g.down}  j k`, 'cards'],
    ['gg  G', 'first / last card'],
    ['1-9', 'jump to column'],
    [g.enter, 'open card'],
    ['n', 'new card'],
    ['m  a  c', 'move, assign, claim'],
    ['C  e', 'comment, edit in $EDITOR'],
    ['w  d  D', 'watch, done, delete'],
    ['o  g', 'open code, open branch'],
    ['/  f', 'search, filter'],
    ['r', 'refresh'],
    ['q', 'quit'],
  ]
  return [
    [seg('Keys', 'title'), seg('  (any key to close)', 'dim')],
    [],
    ...rows.map(([keys, what]): Line => [seg(`  ${keys.padEnd(10)}`, 'accent'), seg(what)]),
  ]
}

// ---------------------------------------------------------------------------
// Board mode
// ---------------------------------------------------------------------------

function columnTitle(column: ViewColumn, width: number, theme: Theme): Line {
  const g = theme.glyphs
  const count = column.cards.length
  const over = column.wipLimit !== null && count > column.wipLimit
  const label = ` ${column.name.toUpperCase()} (${column.wipLimit === null ? count : `${count}/${column.wipLimit}`}) `
  const text =
    textWidth(label) > width ? (fitLine([seg(label)], width, g.ellipsis)[0]?.text ?? '') : label
  const free = width - textWidth(text)
  const leftRule = Math.floor(free / 2)
  return [
    seg(g.h.repeat(leftRule), 'border'),
    seg(text, over ? 'yellow' : 'title'),
    seg(g.h.repeat(free - leftRule), 'border'),
  ]
}

/** Every row of one column's card area, top indicator first. */
function columnRows(
  column: ViewColumn,
  index: number,
  width: number,
  rows: number,
  slots: number,
  view: BoardView,
  nav: NavState,
  theme: Theme,
): Line[] {
  const g = theme.glyphs
  const first = nav.scroll[index] ?? 0
  const lines: Line[] = []
  lines.push(first > 0 ? [seg(` ${g.up} ${first} more`, 'dim')] : [])

  const visible = column.cards.slice(first, first + slots)
  visible.forEach((card, offset) => {
    const selected = nav.column === index && nav.selected[index] === first + offset
    const title = fitLine(titleLine(card, selected, theme), width, g.ellipsis)
    const meta = fitLine([seg('     '), ...metaLine(card, column, view, theme)], width, g.ellipsis)
    lines.push(selected ? invert(title) : title, selected ? invert(meta) : meta, [])
  })

  const hidden = column.cards.length - first - visible.length
  while (lines.length < rows) lines.push([])
  if (hidden > 0) lines[rows - 1] = [seg(` ${g.down} ${hidden} more`, 'dim')]
  return lines.slice(0, rows).map((line) => fitLine(line, width, g.ellipsis))
}

function boardLines(view: BoardView, nav: NavState, theme: Theme): Line[] {
  const { width, height } = nav
  const g = theme.glyphs
  const geometry = boardGeometry(width, height, view.columns.length)
  const shown = view.columns.slice(nav.firstColumn, nav.firstColumn + geometry.visible)
  const moreLeft = nav.firstColumn > 0
  const moreRight = nav.firstColumn + shown.length < view.columns.length
  const cardRows = height - BOARD_CHROME
  const area = cardRows + 1 // the ↑ row above the first card

  const out: Line[] = [header(view, width, theme), framed([], width, theme)]

  // Column titles, with ‹ › in the gutter when there is more to either side.
  const top: Line = [seg(g.tl, 'border')]
  shown.forEach((column, index) => {
    if (index > 0) top.push(seg(g.teeDown, 'border'))
    top.push(...columnTitle(column, geometry.widths[index] ?? 0, theme))
  })
  top.push(seg(g.tr, 'border'))
  out.push(framed(top, width, theme, moreLeft ? g.left : ' ', moreRight ? g.right : ' '))

  const perColumn = shown.map((column, offset) =>
    columnRows(
      column,
      nav.firstColumn + offset,
      geometry.widths[offset] ?? 0,
      area,
      geometry.slots,
      view,
      nav,
      theme,
    ),
  )
  for (let row = 0; row < area; row += 1) {
    const line: Line = [seg(g.v, 'border')]
    perColumn.forEach((rows) => {
      line.push(...(rows[row] ?? []), seg(g.v, 'border'))
    })
    out.push(framed(line, width, theme, moreLeft ? g.left : ' ', moreRight ? g.right : ' '))
  }

  const bottomRule: Line = [seg(g.bl, 'border')]
  shown.forEach((_column, index) => {
    if (index > 0) bottomRule.push(seg(g.teeUp, 'border'))
    bottomRule.push(seg(g.h.repeat(geometry.widths[index] ?? 0), 'border'))
  })
  bottomRule.push(seg(g.br, 'border'))
  out.push(framed(bottomRule, width, theme))
  return out
}

// ---------------------------------------------------------------------------
// List mode (< 100 columns, §8.6)
// ---------------------------------------------------------------------------

function listLine(
  entry: ListEntry,
  view: BoardView,
  nav: NavState,
  width: number,
  theme: Theme,
): Line {
  const g = theme.glyphs
  const column = view.columns[entry.column] as ViewColumn
  if (entry.kind === 'column') {
    const count = column.cards.length
    return [
      seg(
        `${column.name.toUpperCase()} (${column.wipLimit === null ? count : `${count}/${column.wipLimit}`})`,
        'title',
      ),
    ]
  }
  if (entry.kind === 'empty') {
    const selected = nav.column === entry.column
    const line: Line = [seg(selected ? g.marker : ' ', 'accent'), seg(' empty', 'dim')]
    return selected ? invert(fitLine(line, width, g.ellipsis)) : line
  }
  const card = column.cards[entry.index] as Card
  const selected = nav.column === entry.column && nav.selected[entry.column] === entry.index
  const meta = metaLine(card, column, view, theme)
  const metaWidth = Math.min(lineWidth(meta), Math.floor(width / 2))
  const title = fitLine(titleLine(card, selected, theme), width - metaWidth - 1, g.ellipsis)
  const line = fitLine(
    [...title, seg(' '), ...fitLine(meta, metaWidth, g.ellipsis)],
    width,
    g.ellipsis,
  )
  return selected ? invert(line) : line
}

function listLines(view: BoardView, nav: NavState, theme: Theme): Line[] {
  const { width, height } = nav
  const entries = listEntries(view.columns.map((column) => column.cards.length))
  const rows = listRows(height)
  const inner = width - 4
  const out: Line[] = [header(view, width, theme), framed([], width, theme)]
  const visible = entries.slice(nav.listScroll, nav.listScroll + rows)
  for (let row = 0; row < rows; row += 1) {
    const entry = visible[row]
    const g = theme.glyphs
    let content: Line = entry === undefined ? [] : listLine(entry, view, nav, inner, theme)
    if (row === 0 && nav.listScroll > 0) content = [seg(`${g.up} ${nav.listScroll} more`, 'dim')]
    const below = entries.length - nav.listScroll - rows
    if (row === rows - 1 && below > 0) content = [seg(`${g.down} ${below} more`, 'dim')]
    out.push(framed(content, width, theme))
  }
  return out
}

// ---------------------------------------------------------------------------

function centred(lines: Line[], rows: number, width: number, theme: Theme): Line[] {
  const top = Math.max(0, Math.floor((rows - lines.length) / 2))
  const out: Line[] = []
  for (let row = 0; row < rows; row += 1) {
    const line = lines[row - top]
    if (line === undefined) {
      out.push(framed([], width, theme))
      continue
    }
    const pad = Math.max(0, Math.floor((width - 4 - lineWidth(line)) / 2))
    out.push(framed([seg(' '.repeat(pad)), ...line], width, theme))
  }
  return out
}

/** The whole screen, as lines of styled segments. */
export function frameLines(view: BoardView, nav: NavState, theme: Theme): Line[] {
  const { width, height } = nav
  const g = theme.glyphs

  if (isTooSmall(width, height)) {
    const notice = fitLine(
      [seg(`yuzie needs at least 30×12 (this is ${width}×${height})`)],
      width,
      g.ellipsis,
    )
    return [
      notice,
      ...Array.from({ length: Math.max(0, height - 1) }, () => fitLine([], width, g.ellipsis)),
    ]
  }

  const empty = view.columns.every((column) => column.cards.length === 0)
  let body: Line[]
  if (nav.help) {
    body = [header(view, width, theme), ...centred(helpLines(theme), height - 5, width, theme)]
  } else if (empty) {
    body = [
      header(view, width, theme),
      ...centred(
        [
          [seg('No cards yet.', 'title')],
          [],
          [seg('Create the first one: '), seg('yuzie add "Your first card"', 'accent')],
          [seg('or press ', 'dim'), seg('n', 'accent'), seg(' here.', 'dim')],
        ],
        height - 5,
        width,
        theme,
      ),
    ]
  } else {
    body = isNarrow(width) ? listLines(view, nav, theme) : boardLines(view, nav, theme)
  }

  const footer = [
    framed([], width, theme),
    framed(toastLine(view, theme), width, theme),
    framed(hints(theme), width, theme),
    bottom(width, theme),
  ]
  const lines = [...body, ...footer]
  // Exactly `height` lines, whatever happened above.
  while (lines.length < height)
    lines.splice(lines.length - footer.length, 0, framed([], width, theme))
  return lines.slice(0, height).map((line) => fitLine(line, width, g.ellipsis))
}

export function renderFrame(view: BoardView, nav: NavState, theme: Theme): string {
  return frameLines(view, nav, theme)
    .map((line) => paintLine(line, theme))
    .join('\n')
}

export function renderPlain(view: BoardView, nav: NavState, theme: Theme): string {
  return frameLines(view, nav, theme).map(plainLine).join('\n')
}
