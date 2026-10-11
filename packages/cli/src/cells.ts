/**
 * Text measured in terminal cells, the way a terminal (and Ink) draws it: an
 * emoji or a CJK character takes two cells, a combining accent none. Counting
 * code points instead pushes any line holding one past the edge of its column.
 */
import stringWidth from 'string-width'

/** Printable ASCII: one cell per character, so nothing needs measuring. */
const PLAIN = /^[\x20-\x7e]*$/
const segmenter = new Intl.Segmenter()

/** How many terminal cells `text` takes. */
export function cells(text: string): number {
  return PLAIN.test(text) ? text.length : stringWidth(text)
}

export interface Glyph {
  readonly text: string
  readonly cells: number
}

/** What the terminal draws as one character (a grapheme cluster), with its width. */
export function glyphs(text: string): Glyph[] {
  if (PLAIN.test(text)) return [...text].map((character) => ({ text: character, cells: 1 }))
  return Array.from(segmenter.segment(text), ({ segment }) => ({
    text: segment,
    cells: stringWidth(segment),
  }))
}

/** The longest start of `text` that fits in `max` cells. */
export function head(text: string, max: number): string {
  let out = ''
  let used = 0
  for (const glyph of glyphs(text)) {
    if (used + glyph.cells > max) break
    out += glyph.text
    used += glyph.cells
  }
  return out
}

/**
 * Cells `start` up to `end` of `text`. A wide character the cut goes through is
 * drawn as spaces, so the result is exactly as wide as the range it covers.
 */
export function sliceCells(text: string, start: number, end: number): string {
  let out = ''
  let position = 0
  for (const glyph of glyphs(text)) {
    const from = position
    position += glyph.cells
    if (glyph.cells === 0) {
      // Takes no cell of its own: it stays with whatever was drawn before it.
      if (from > start && from <= end) out += glyph.text
      continue
    }
    if (position <= start) continue
    if (from >= end) break
    if (from >= start && position <= end) out += glyph.text
    else out += ' '.repeat(Math.min(position, end) - Math.max(from, start))
  }
  return out
}
