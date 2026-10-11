/**
 * Styled text for the frame: a line is a list of segments, each with an
 * optional style. Widths are measured before any escape codes are added, so
 * every line is exactly as wide as the terminal no matter which theme paints it.
 */
import { printable } from '@yuzie/core'
import { cells, glyphs, head, sliceCells } from '../cells.js'
import type { Style, Theme } from './theme.js'

export interface Segment {
  readonly text: string
  readonly style?: Style
  /** Inverse video around whatever colour the segment has: the selected card (§8.2). */
  readonly inverse?: boolean
}

export type Line = Segment[]

/**
 * A run of text in one style. Everything the board shows passes through here,
 * so a control character in a title or comment is drawn as `�`, never obeyed
 * by the terminal (§18 Session 16).
 */
export function seg(text: string, style?: Style): Segment {
  const safe = printable(text)
  return style === undefined ? { text: safe } : { text: safe, style }
}

/** Width in terminal cells: a wide character (emoji, CJK) takes two. */
export function textWidth(text: string): number {
  return cells(text)
}

export function lineWidth(line: Line): number {
  return line.reduce((sum, part) => sum + textWidth(part.text), 0)
}

/**
 * Cut to at most `max` cells, ending in the theme's ellipsis when anything was
 * cut. A wide character that would straddle the edge is left out, so the result
 * can be a cell short; {@link fitLine} pads it.
 */
export function clip(text: string, max: number, ellipsis: string): string {
  if (textWidth(text) <= max) return text
  if (max <= 0) return ''
  const mark = textWidth(ellipsis)
  if (mark >= max) return head(text, max)
  return head(text, max - mark) + ellipsis
}

/** Pad or clip a whole line to exactly `width` cells. */
export function fitLine(line: Line, width: number, ellipsis: string): Line {
  const out: Line = []
  let used = 0
  for (const part of line) {
    const room = width - used
    if (room <= 0) break
    const size = textWidth(part.text)
    if (size <= room) {
      out.push(part)
      used += size
    } else {
      const text = clip(part.text, room, ellipsis)
      out.push({ ...part, text })
      used += textWidth(text)
      break
    }
  }
  if (used < width) out.push(seg(' '.repeat(width - used)))
  return out
}

/** Mark every segment of a line as selected. */
export function invert(line: Line): Line {
  return line.map((part) => ({ ...part, inverse: true }))
}

export function paintLine(line: Line, theme: Theme): string {
  return line
    .map((part) => {
      const coloured = theme.paint(part.style, part.text)
      return part.inverse === true ? theme.paint('selected', coloured) : coloured
    })
    .join('')
}

export function plainLine(line: Line): string {
  return line.map((part) => part.text).join('')
}

/** Cells `start` up to `end` of a line, keeping each segment's style. */
export function sliceLine(line: Line, start: number, end: number): Line {
  const out: Line = []
  let position = 0
  for (const part of line) {
    const size = textWidth(part.text)
    const from = Math.max(start, position)
    const to = Math.min(end, position + size)
    if (from < to)
      out.push({ ...part, text: sliceCells(part.text, from - position, to - position) })
    position += size
    if (position >= end) break
  }
  return out
}

/** `base` with `insert` drawn over it from column `x`; the line keeps its width. */
export function overlayLine(base: Line, x: number, insert: Line): Line {
  const size = lineWidth(insert)
  return [...sliceLine(base, 0, x), ...insert, ...sliceLine(base, x + size, lineWidth(base))]
}

/** Word-wrap prose to `width` columns, keeping blank lines; long words are broken. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return []
  const out: string[] = []
  for (const paragraph of text.replace(/\r\n/g, '\n').split('\n')) {
    let current = ''
    for (const word of paragraph.split(/\s+/).filter((part) => part.length > 0)) {
      let rest = word
      while (textWidth(rest) > width) {
        if (current.length > 0) {
          out.push(current)
          current = ''
        }
        // At least one character a line, even one wider than the line.
        const piece = head(rest, width) || (glyphs(rest)[0]?.text ?? rest)
        out.push(piece)
        rest = rest.slice(piece.length)
      }
      if (rest.length === 0) continue
      if (current.length === 0) current = rest
      else if (textWidth(current) + 1 + textWidth(rest) <= width) current += ` ${rest}`
      else {
        out.push(current)
        current = rest
      }
    }
    out.push(current)
  }
  // No trailing blank lines from a trailing newline.
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}
