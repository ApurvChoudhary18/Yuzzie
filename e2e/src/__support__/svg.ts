/**
 * Terminal frames to one animated SVG (the README demo, SPEC.md §18 Session 17).
 * Each frame is read cell by cell — character, colours, bold, dim, inverse —
 * from the headless xterm the real TUI drew into, so the demo is the product,
 * not a mock-up of it. Frames cycle with CSS keyframes, which GitHub renders.
 */
import type xterm from '@xterm/headless'

type Terminal = InstanceType<typeof xterm.Terminal>

export interface Cell {
  readonly text: string
  readonly fg: string
  readonly bg: string | null
  readonly bold: boolean
}

export interface Frame {
  readonly rows: readonly (readonly Cell[])[]
  /** How long the frame stays on screen. */
  readonly ms: number
}

const FG = '#c9d1d9'
const BG = '#0d1117'
const ANSI = [
  '#484f58',
  '#ff7b72',
  '#3fb950',
  '#d29922',
  '#58a6ff',
  '#bc8cff',
  '#39c5cf',
  '#b1bac4',
  '#6e7681',
  '#ffa198',
  '#56d364',
  '#e3b341',
  '#79c0ff',
  '#d2a8ff',
  '#56d4dd',
  '#f0f6fc',
]

function palette(index: number): string {
  if (index < 16) return ANSI[index] as string
  if (index < 232) {
    const n = index - 16
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40)
    return rgb(level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6))
  }
  const grey = 8 + (index - 232) * 10
  return rgb(grey, grey, grey)
}

function rgb(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function colour(mode: 'fg' | 'bg', cell: xterm.IBufferCell): string | null {
  const isDefault = mode === 'fg' ? cell.isFgDefault() : cell.isBgDefault()
  if (isDefault) return null
  const value = mode === 'fg' ? cell.getFgColor() : cell.getBgColor()
  const isRgb = mode === 'fg' ? cell.isFgRGB() : cell.isBgRGB()
  if (isRgb) return rgb((value >> 16) & 255, (value >> 8) & 255, value & 255)
  return palette(value)
}

/** The screen as it is now. */
export function capture(terminal: Terminal, ms: number): Frame {
  const buffer = terminal.buffer.active
  const rows: Cell[][] = []
  const cell = buffer.getNullCell()
  for (let y = 0; y < terminal.rows; y += 1) {
    const line = buffer.getLine(buffer.viewportY + y)
    const row: Cell[] = []
    for (let x = 0; x < terminal.cols; x += 1) {
      line?.getCell(x, cell)
      let fg = colour('fg', cell) ?? FG
      let bg = colour('bg', cell)
      if (cell.isInverse()) [fg, bg] = [bg ?? BG, fg]
      if (cell.isDim()) fg = `${fg}99`
      row.push({ text: cell.getChars() || ' ', fg, bg, bold: cell.isBold() !== 0 })
    }
    rows.push(row)
  }
  return { rows, ms }
}

const CW = 8.4
const LH = 18
const PAD = 14
const BAR = 30

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderFrame(frame: Frame): string {
  const parts: string[] = []
  frame.rows.forEach((row, y) => {
    const top = BAR + PAD + y * LH
    // Backgrounds: runs of one colour.
    for (let x = 0; x < row.length; ) {
      const bg = row[x]?.bg ?? null
      let end = x + 1
      while (end < row.length && (row[end]?.bg ?? null) === bg) end += 1
      if (bg !== null)
        parts.push(
          `<rect x="${(PAD + x * CW).toFixed(1)}" y="${top}" width="${((end - x) * CW).toFixed(1)}" height="${LH}" fill="${bg}"/>`,
        )
      x = end
    }
    // Text: runs of one style, each placed at its own column.
    const spans: string[] = []
    for (let x = 0; x < row.length; ) {
      const first = row[x] as Cell
      let end = x + 1
      while (end < row.length && row[end]?.fg === first.fg && row[end]?.bold === first.bold)
        end += 1
      const text = row
        .slice(x, end)
        .map((c) => c.text)
        .join('')
      if (text.trim().length > 0)
        spans.push(
          `<tspan x="${(PAD + x * CW).toFixed(1)}" fill="${first.fg}"${first.bold ? ' font-weight="bold"' : ''}>${xml(text)}</tspan>`,
        )
      x = end
    }
    if (spans.length > 0) parts.push(`<text y="${top + LH - 5}">${spans.join('')}</text>`)
  })
  return parts.join('')
}

/** All frames, looping. */
export function animatedSvg(frames: readonly Frame[], title: string): string {
  const cols = frames[0]?.rows[0]?.length ?? 80
  const rows = frames[0]?.rows.length ?? 24
  const width = Math.ceil(PAD * 2 + cols * CW)
  const height = BAR + PAD * 2 + rows * LH
  const total = frames.reduce((sum, frame) => sum + frame.ms, 0)
  let at = 0
  const styles: string[] = []
  const groups: string[] = []
  frames.forEach((frame, index) => {
    const start = (at / total) * 100
    const end = ((at + frame.ms) / total) * 100
    at += frame.ms
    const keys =
      index === 0
        ? `0%{opacity:1}${end.toFixed(3)}%{opacity:0}100%{opacity:0}`
        : `0%{opacity:0}${start.toFixed(3)}%{opacity:1}${end.toFixed(3)}%{opacity:0}100%{opacity:0}`
    styles.push(`@keyframes f${index}{${keys}}#f${index}{animation-name:f${index}}`)
    groups.push(`<g id="f${index}" class="f">${renderFrame(frame)}</g>`)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(title)}">
<title>${xml(title)}</title>
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:14px;white-space:pre}
.f{opacity:0;animation-duration:${total}ms;animation-iteration-count:infinite;animation-timing-function:steps(1,end)}
${styles.join('\n')}
</style>
<rect width="${width}" height="${height}" rx="8" fill="${BG}"/>
<circle cx="20" cy="15" r="6" fill="#ff5f57"/><circle cx="40" cy="15" r="6" fill="#febc2e"/><circle cx="60" cy="15" r="6" fill="#28c840"/>
<text x="${width / 2}" y="20" fill="#8b949e" text-anchor="middle" style="font-size:12px">${xml(title)}</text>
${groups.join('\n')}
</svg>
`
}
