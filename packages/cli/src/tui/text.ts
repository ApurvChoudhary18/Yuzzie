/**
 * Styled text for the frame: a line is a list of segments, each with an
 * optional style. Widths are measured before any escape codes are added, so
 * every line is exactly as wide as the terminal no matter which theme paints it.
 */
import type { Style, Theme } from './theme.js'

export interface Segment {
  readonly text: string
  readonly style?: Style
  /** Inverse video around whatever colour the segment has: the selected card (§8.2). */
  readonly inverse?: boolean
}

export type Line = Segment[]

export function seg(text: string, style?: Style): Segment {
  return style === undefined ? { text } : { text, style }
}

export function chars(text: string): string[] {
  return [...text]
}

export function textWidth(text: string): number {
  return chars(text).length
}

export function lineWidth(line: Line): number {
  return line.reduce((sum, part) => sum + textWidth(part.text), 0)
}

/** Cut to `max` characters, ending in the theme's ellipsis when anything was cut. */
export function clip(text: string, max: number, ellipsis: string): string {
  const all = chars(text)
  if (all.length <= max) return text
  if (max <= 0) return ''
  const mark = chars(ellipsis)
  if (mark.length >= max) return all.slice(0, max).join('')
  return all.slice(0, max - mark.length).join('') + ellipsis
}

/** Pad or clip a whole line to exactly `width` characters. */
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
      out.push({ ...part, text: clip(part.text, room, ellipsis) })
      used = width
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
