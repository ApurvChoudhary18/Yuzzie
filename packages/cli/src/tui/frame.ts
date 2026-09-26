/**
 * The TUI, drawn: board view, list view, card view and overlays (SPEC.md §8.2,
 * §8.3, §8.5, §8.6).
 *
 * A pure function of the view, the navigation state and the theme. It returns
 * exactly `height` lines, each exactly `width` characters wide before escapes,
 * so the terminal never wraps or shears whatever size it is.
 */
import type { Card, Presence } from '@yuzie/core'
import { cardBody } from './card.js'
import {
  BOARD_CHROME,
  type BoardView,
  boardGeometry,
  CONFLICT_MS,
  describeFilter,
  FLASH_MS,
  findCard,
  isNarrow,
  isTooSmall,
  type ListEntry,
  listEntries,
  listRows,
  PUSH_MS,
  TOUCH_MS,
  type Touch,
  type ViewColumn,
  visibleView,
} from './layout.js'
import { CARD_CHROME, type NavState, type Overlay } from './state.js'
import {
  fitLine,
  invert,
  type Line,
  lineWidth,
  overlayLine,
  paintLine,
  plainLine,
  seg,
  textWidth,
  wrap,
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
  const pushed = view.pushes.get(card.number)
  if (pushed !== undefined && view.now - pushed.at < PUSH_MS)
    parts.push(seg(' '), seg(`${g.up}${pushed.count}`, 'green'))

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

function recent(touch: Touch | undefined, now: number, window: number): touch is Touch {
  return touch !== undefined && now - touch.at < window
}

/** Someone else's name for a conflict or an update: `@priya`, or `someone`. */
function byWhom(touch: Touch): string {
  return touch.by ?? 'someone'
}

/** A card that just moved flashes once (§18 Session 10). */
function flashing(card: Card, view: BoardView): boolean {
  const at = view.flashes.get(card.number)
  return at !== undefined && view.now - at < FLASH_MS
}

/** `◌` while a write is unconfirmed; `⟳` for a while after the server refused one. */
function markers(card: Card, view: BoardView, theme: Theme): Line {
  const g = theme.glyphs
  if (recent(view.conflicts.get(card.number), view.now, CONFLICT_MS)) return [seg(g.updated, 'red')]
  if (view.pending.has(card.number) || card.number < 0) return [seg(g.pending, 'dim')]
  return []
}

function titleLine(card: Card, selected: boolean, view: BoardView, theme: Theme): Line {
  const number = card.number < 0 ? '#new' : `#${card.number}`
  return [
    seg(selected ? theme.glyphs.marker : ' ', selected ? 'accent' : undefined),
    seg(number, 'dim'),
    ...markers(card, view, theme),
    seg(' '),
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
    case 'live': {
      const working = view.presence.filter((person) => person.state === 'working').length
      return [
        seg(`${g.dot} `, 'green'),
        seg(
          [
            `${online} online`,
            ...(working > 0 ? [`${working} working`] : []),
            view.queued > 0 ? `${view.queued} queued` : 'synced',
          ].join(' · '),
        ),
      ]
    }
  }
}

/** What the board is narrowed to, shown in the header while it is. */
function narrowing(nav: NavState, theme: Theme): Line {
  const parts = [
    ...(nav.query.trim() === '' ? [] : [`/${nav.query.trim()}`]),
    ...(nav.filter === null ? [] : [describeFilter(nav.filter)]),
  ]
  if (parts.length === 0) return []
  return [seg(parts.join(' · '), 'yellow'), seg(`  esc clears  ${theme.glyphs.h} `, 'dim')]
}

function header(
  view: BoardView,
  width: number,
  theme: Theme,
  title: Line = [seg('yuzie', 'title'), seg(` · ${view.slug} `)],
  extra: Line = [],
): Line {
  const g = theme.glyphs
  const head: Line = [seg(`${g.tl} `, 'border'), ...title]
  const status = [...extra, ...statusText(view, theme)]
  return rule(head, status, width, theme)
}

function rule(title: Line, status: Line, width: number, theme: Theme): Line {
  const g = theme.glyphs
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

type Hints = ReadonlyArray<readonly [string, string]>

const BOARD_HINTS: Hints = [
  ['?', 'help'],
  ['/', 'search'],
  ['n', 'new'],
  ['c', 'claim'],
  ['m', 'move'],
  ['a', 'assign'],
  ['ENTER', 'open'],
  ['q', 'quit'],
]

const CARD_HINTS: Hints = [
  ['C', 'comment'],
  ['m', 'move'],
  ['a', 'assign'],
  ['e', 'edit'],
  ['x', 'check'],
  ['w', 'watch'],
  ['ESC', 'back'],
]

function overlayHints(overlay: Overlay): Hints {
  switch (overlay.kind) {
    case 'pick':
      return [
        ['j k', 'choose'],
        ['ENTER', overlay.purpose === 'assign' ? 'assign / unassign' : 'pick'],
        ['ESC', 'cancel'],
      ]
    case 'input':
      if (overlay.purpose === 'search')
        return [
          ['ENTER', 'keep'],
          ['ESC', 'clear'],
        ]
      return overlay.multiline
        ? [
            ['Ctrl-D', 'send'],
            ['ENTER', 'new line'],
            ['ESC', 'cancel'],
          ]
        : [
            ['ENTER', 'save'],
            ['ESC', 'cancel'],
          ]
    case 'confirm':
      return [
        ['y', 'delete'],
        ['n', 'keep'],
      ]
    case 'checklist':
      return [
        ['j k', 'choose'],
        ['x', 'toggle'],
        ['+', 'add'],
        ['ESC', 'close'],
      ]
  }
}

function hints(nav: NavState, theme: Theme): Line {
  const list =
    nav.overlay !== null
      ? overlayHints(nav.overlay)
      : nav.screen === 'card'
        ? CARD_HINTS
        : BOARD_HINTS
  const line: Line = []
  list.forEach(([key, what], index) => {
    if (index > 0) line.push(seg('  '))
    const name = key === 'ENTER' ? theme.glyphs.enter : key === 'ESC' ? 'esc' : key
    line.push(seg(name, 'accent'), seg(` ${what}`, 'dim'))
  })
  return line
}

function toastLine(view: BoardView, nav: NavState, theme: Theme): Line {
  const overlay = nav.overlay
  if (overlay?.kind === 'input' && overlay.purpose === 'search') {
    return [seg('/', 'accent'), seg(overlay.text), seg('▏', 'accent')]
  }
  const toast = view.toast
  if (toast === null || view.now - toast.at > TOAST_MS) return []
  const more: Line =
    toast.waiting !== undefined && toast.waiting > 0 ? [seg(`  +${toast.waiting}`, 'dim')] : []
  if (toast.kind === 'info') return [seg('→ ', 'accent'), seg(toast.text, 'dim'), ...more]
  if (toast.kind === 'warn')
    return [seg(`${theme.glyphs.warn} `, 'red'), seg(toast.text, 'yellow'), ...more]
  if (toast.kind === 'conflict')
    return [seg(`${theme.glyphs.updated} `, 'red'), seg(toast.text, 'yellow'), ...more]
  return [seg(`${theme.glyphs.check} `, 'green'), seg(toast.text), ...more]
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

function helpLines(nav: NavState, theme: Theme): Line[] {
  const g = theme.glyphs
  const rows: Array<[string, string]> =
    nav.screen === 'card'
      ? [
          [`${g.up}${g.down}  j k`, 'scroll'],
          ['esc  q', 'back to the board'],
          ['m  a', 'move, assign'],
          ['C', 'comment (Ctrl-D sends)'],
          ['x  +', 'check off an item, add one'],
          ['e', 'edit in $EDITOR'],
          ['c  w  d  D', 'claim, watch, done, delete'],
          ['o  g', 'open code, open branch'],
          ['r', 'refresh'],
        ]
      : [
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
    const lit = selected || flashing(card, view)
    const title = fitLine(titleLine(card, selected, view, theme), width, g.ellipsis)
    const meta = fitLine([seg('     '), ...metaLine(card, column, view, theme)], width, g.ellipsis)
    lines.push(lit ? invert(title) : title, lit ? invert(meta) : meta, [])
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

  const out: Line[] = [
    header(view, width, theme, undefined, narrowing(nav, theme)),
    framed([], width, theme),
  ]

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
  const title = fitLine(titleLine(card, selected, view, theme), width - metaWidth - 1, g.ellipsis)
  const line = fitLine(
    [...title, seg(' '), ...fitLine(meta, metaWidth, g.ellipsis)],
    width,
    g.ellipsis,
  )
  return selected || flashing(card, view) ? invert(line) : line
}

function listLines(view: BoardView, nav: NavState, theme: Theme): Line[] {
  const { width, height } = nav
  const entries = listEntries(view.columns.map((column) => column.cards.length))
  const rows = listRows(height)
  const inner = width - 4
  const out: Line[] = [
    header(view, width, theme, undefined, narrowing(nav, theme)),
    framed([], width, theme),
  ]
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

// ---------------------------------------------------------------------------
// Card view (§8.3)
// ---------------------------------------------------------------------------

function cardLines(card: Card, view: BoardView, nav: NavState, theme: Theme): Line[] {
  const { width, height } = nav
  const g = theme.glyphs
  const pending = view.pending.has(card.number) || card.number < 0
  const conflict = view.conflicts.get(card.number)
  const touched = view.touched.get(card.number)
  const rule = seg(`  ${g.h} `, 'border')
  const marker: Line = recent(conflict, view.now, CONFLICT_MS)
    ? [seg(`${g.updated} updated by ${byWhom(conflict)} · your edit was undone`, 'red'), rule]
    : pending
      ? [seg(`${g.pending} saving${g.ellipsis}`, 'dim'), rule]
      : recent(touched, view.now, TOUCH_MS)
        ? [seg(`${g.updated} updated by ${byWhom(touched)}`, 'yellow'), rule]
        : []
  const title: Line = [
    seg(card.number < 0 ? '#new' : `#${card.number}`, 'dim'),
    seg(' '),
    seg(card.title, 'title'),
    seg(' '),
  ]
  const out: Line[] = [header(view, width, theme, title, marker)]

  const body = cardBody(card, view, width, theme)
  const rows = Math.max(1, height - CARD_CHROME)
  const first = Math.min(nav.cardScroll, Math.max(0, body.length - rows))
  for (let row = 0; row < rows; row += 1) {
    const above = row === 0 && first > 0
    const below = row === rows - 1 && first + rows < body.length
    out.push(
      framed(body[first + row] ?? [], width, theme, ' ', above ? g.up : below ? g.down : ' '),
    )
  }
  return out
}

function presenceLine(card: Card, view: BoardView, theme: Theme): Line {
  const here = view.presence.filter(
    (person) =>
      person.cardNo === card.number && person.state !== 'online' && person.handle !== view.me,
  )
  if (here.length === 0) return []
  const working = here.some((person) => person.state === 'working')
  const line: Line = [seg(`${theme.glyphs.dot} `, working ? 'green' : 'accent')]
  here.forEach((person, index) => {
    if (index > 0) line.push(seg(', '))
    // Agents are always marked, so people know who is who (§8.5, §14).
    if (person.kind === 'agent') line.push(seg(`@${person.handle} (agent)`, 'agent'))
    else line.push(seg(`@${person.handle}`))
  })
  line.push(
    seg(` ${here.length === 1 ? 'is' : 'are'} ${working ? 'working on' : 'viewing'} this card`),
  )
  return line
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

function boxed(title: string, content: Line[], width: number, theme: Theme): Line[] {
  const g = theme.glyphs
  const inner = width - 4
  const label = ` ${title} `
  const top = `${g.tl}${g.h}${label}`
  return [
    fitLine(
      [
        seg(top, 'border'),
        seg(g.h.repeat(Math.max(0, width - textWidth(top) - 1)), 'border'),
        seg(g.tr, 'border'),
      ],
      width,
      g.ellipsis,
    ),
    ...content.map(
      (line): Line => [
        seg(`${g.v} `, 'border'),
        ...fitLine(line, inner, g.ellipsis),
        seg(` ${g.v}`, 'border'),
      ],
    ),
    [seg(`${g.bl}${g.h.repeat(width - 2)}${g.br}`, 'border')],
  ]
}

/** Options with the chosen one inverted, scrolled so it stays in view. */
function choices(
  options: ReadonlyArray<{ label: string; current?: boolean; done?: boolean }>,
  index: number,
  rows: number,
  inner: number,
  theme: Theme,
  mark: (option: { current?: boolean; done?: boolean }) => Line,
): Line[] {
  const g = theme.glyphs
  const first = Math.max(0, Math.min(index - Math.floor(rows / 2), options.length - rows))
  return options.slice(first, first + rows).map((option, offset) => {
    const chosen = first + offset === index
    const line = fitLine(
      [seg(chosen ? `${g.marker} ` : '  ', 'accent'), ...mark(option), seg(option.label)],
      inner,
      g.ellipsis,
    )
    return chosen ? invert(line) : line
  })
}

function overlayBox(
  overlay: Overlay,
  view: BoardView,
  nav: NavState,
  rows: number,
  theme: Theme,
): Line[] | null {
  const g = theme.glyphs
  const room = nav.width - 8
  switch (overlay.kind) {
    case 'pick': {
      const width = Math.min(
        room,
        Math.max(36, ...overlay.options.map((o) => textWidth(o.label) + 10)),
      )
      const visible = Math.max(1, Math.min(overlay.options.length, rows - 2))
      const content =
        overlay.options.length === 0
          ? [[seg('Nothing to choose from.', 'dim')] as Line]
          : choices(overlay.options, overlay.index, visible, width - 4, theme, (option) =>
              option.current === true ? [seg(`${g.check} `, 'green')] : [seg('  ')],
            )
      return boxed(overlay.title, content, width, theme)
    }
    case 'input': {
      if (overlay.purpose === 'search') return null
      const width = Math.min(room, 72)
      const inner = width - 4
      const text = overlay.text
        .split('\n')
        .flatMap((line) => (line === '' ? [''] : wrap(line, inner - 1)))
      const lines = text.length === 0 ? [''] : text
      const shown = lines.slice(-Math.max(1, Math.min(8, rows - 2)))
      const content = shown.map(
        (line, index): Line =>
          index === shown.length - 1 ? [seg(line), seg('▏', 'accent')] : [seg(line)],
      )
      while (overlay.multiline && content.length < 3) content.push([])
      return boxed(overlay.title, content, width, theme)
    }
    case 'confirm': {
      const width = Math.min(room, Math.max(40, textWidth(overlay.title) + 16))
      return boxed(
        'Delete',
        [
          [seg(`Delete #${overlay.cardNo} `), seg(overlay.title, 'title'), seg('?')],
          [],
          [seg('y', 'accent'), seg(' delete   ', 'dim'), seg('n', 'accent'), seg(' keep', 'dim')],
        ],
        width,
        theme,
      )
    }
    case 'checklist': {
      const card = findCard(view, overlay.cardNo)
      const items =
        card === undefined ? [] : [...card.checklist].sort((a, b) => a.position - b.position)
      const width = Math.min(room, Math.max(40, ...items.map((item) => textWidth(item.text) + 12)))
      const options = items.map((item) => ({
        label: `${String(item.position).padStart(2)}  ${item.text}`,
        done: item.doneAt !== null,
      }))
      const visible = Math.max(1, Math.min(options.length, rows - 2))
      return boxed(
        `Checklist #${overlay.cardNo}`,
        choices(options, overlay.index, visible, width - 4, theme, (option) =>
          option.done === true ? [seg(`${g.check} `, 'green')] : [seg(`${g.open} `, 'dim')],
        ),
        width,
        theme,
      )
    }
  }
}

/** Draw `box` centred over rows `top`..`top + rows` of `lines`. */
function compose(lines: Line[], box: Line[], top: number, rows: number, width: number): Line[] {
  const boxWidth = lineWidth(box[0] ?? [])
  const x = Math.max(0, Math.floor((width - boxWidth) / 2))
  const y = top + Math.max(0, Math.floor((rows - box.length) / 2))
  return lines.map((line, row) => {
    const part = box[row - y]
    return part === undefined ? line : overlayLine(fitLine(line, width, ''), x, part)
  })
}

// ---------------------------------------------------------------------------

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

  const card = nav.screen === 'card' && nav.cardNo !== null ? findCard(view, nav.cardNo) : undefined
  const shown = visibleView(view, nav.query, nav.filter)
  const everything = view.columns.every((column) => column.cards.length === 0)
  const nothingShown = shown.columns.every((column) => column.cards.length === 0)
  const bodyRows = height - 5
  let body: Line[]
  if (nav.help) {
    body = [header(view, width, theme), ...centred(helpLines(nav, theme), bodyRows, width, theme)]
  } else if (card !== undefined) {
    body = cardLines(card, view, nav, theme)
  } else if (everything) {
    body = [
      header(view, width, theme),
      ...centred(
        [
          [seg('No cards yet.', 'title')],
          [],
          [seg('Create the first one: '), seg('yuzie add "Your first card"', 'accent')],
          [seg('or press ', 'dim'), seg('n', 'accent'), seg(' here.', 'dim')],
        ],
        bodyRows,
        width,
        theme,
      ),
    ]
  } else if (nothingShown) {
    body = [
      header(view, width, theme, undefined, narrowing(nav, theme)),
      ...centred(
        [
          [seg('No cards match.', 'title')],
          [],
          [seg('esc', 'accent'), seg(' shows everything again.', 'dim')],
        ],
        bodyRows,
        width,
        theme,
      ),
    ]
  } else {
    body = isNarrow(width) ? listLines(shown, nav, theme) : boardLines(shown, nav, theme)
  }

  const footer = [
    card !== undefined && !nav.help
      ? framed(presenceLine(card, view, theme), width, theme)
      : framed([], width, theme),
    framed(toastLine(view, nav, theme), width, theme),
    framed(hints(nav, theme), width, theme),
    bottom(width, theme),
  ]
  // Exactly `height` lines, whatever happened above.
  while (body.length < height - footer.length) body.push(framed([], width, theme))
  let lines = [...body.slice(0, height - footer.length), ...footer]

  if (nav.overlay !== null && !nav.help) {
    const box = overlayBox(nav.overlay, view, nav, bodyRows, theme)
    if (box !== null) lines = compose(lines, box, 1, bodyRows, width)
  }
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
