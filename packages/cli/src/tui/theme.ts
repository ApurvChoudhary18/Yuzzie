/**
 * Capability tiers (SPEC.md §8.1: "Degrade gracefully: 80×24 terminals, no
 * truecolor, no Nerd Fonts").
 *
 * Colour: truecolor → 256 → 16 → none. "None" still uses bold and inverse
 * video, which are not colour: the selected card is marked by `▸` and inverse
 * video, never by colour alone (§8.2, accessibility). `plain` strips every
 * escape, for snapshots and pipes.
 *
 * Glyphs: box drawing and symbols, or an ASCII set for terminals and fonts that
 * cannot draw them.
 */

export type ColorTier = 'truecolor' | '256' | '16' | 'none' | 'plain'
export type GlyphTier = 'unicode' | 'ascii'

export type Style =
  | 'border'
  | 'title'
  | 'selected'
  | 'dim'
  | 'green'
  | 'yellow'
  | 'red'
  | 'accent'
  | 'chip'
  | 'agent'

export interface Glyphs {
  readonly tl: string
  readonly tr: string
  readonly bl: string
  readonly br: string
  readonly h: string
  readonly v: string
  readonly teeDown: string
  readonly teeUp: string
  readonly marker: string
  readonly dot: string
  readonly warn: string
  readonly left: string
  readonly right: string
  readonly up: string
  readonly down: string
  readonly check: string
  readonly enter: string
  readonly ellipsis: string
  readonly none: string
  /** A write painted before the server confirmed it. */
  readonly pending: string
  /** An unchecked checklist item. */
  readonly open: string
  /** A card someone else changed under you (§18 Session 10: `⟳ updated by @x`). */
  readonly updated: string
}

const UNICODE: Glyphs = {
  tl: '┌',
  tr: '┐',
  bl: '└',
  br: '┘',
  h: '─',
  v: '│',
  teeDown: '┬',
  teeUp: '┴',
  marker: '▸',
  dot: '●',
  warn: '⚠',
  left: '‹',
  right: '›',
  up: '↑',
  down: '↓',
  check: '✓',
  enter: '↵',
  ellipsis: '…',
  none: '—',
  pending: '◌',
  open: '○',
  updated: '⟳',
}

const ASCII: Glyphs = {
  tl: '+',
  tr: '+',
  bl: '+',
  br: '+',
  h: '-',
  v: '|',
  teeDown: '+',
  teeUp: '+',
  marker: '>',
  dot: '*',
  warn: '!',
  left: '<',
  right: '>',
  up: '^',
  down: 'v',
  check: 'v',
  enter: 'RET',
  ellipsis: '~',
  none: '-',
  pending: '~',
  open: 'o',
  updated: '%',
}

type Codes = readonly [open: string, close: string]

const SGR = (open: number | string, close: number): Codes => [`\u001b[${open}m`, `\u001b[${close}m`]

/** One palette per tier. Truecolor picks softer tones; 16 colours use the basics. */
const PALETTES: Record<Exclude<ColorTier, 'plain'>, Record<Style, Codes>> = {
  truecolor: {
    border: SGR('38;2;110;110;130', 39),
    title: SGR(1, 22),
    selected: SGR(7, 27),
    dim: SGR('38;2;130;130;145', 39),
    green: SGR('38;2;80;200;120', 39),
    yellow: SGR('38;2;230;180;60', 39),
    red: SGR('38;2;235;90;90', 39),
    accent: SGR('38;2;120;160;255', 39),
    chip: SGR('38;2;200;140;230', 39),
    agent: SGR('38;2;220;110;220', 39),
  },
  '256': {
    border: SGR('38;5;244', 39),
    title: SGR(1, 22),
    selected: SGR(7, 27),
    dim: SGR('38;5;245', 39),
    green: SGR('38;5;78', 39),
    yellow: SGR('38;5;179', 39),
    red: SGR('38;5;203', 39),
    accent: SGR('38;5;111', 39),
    chip: SGR('38;5;176', 39),
    agent: SGR('38;5;170', 39),
  },
  '16': {
    border: SGR(90, 39),
    title: SGR(1, 22),
    selected: SGR(7, 27),
    dim: SGR(90, 39),
    green: SGR(32, 39),
    yellow: SGR(33, 39),
    red: SGR(31, 39),
    accent: SGR(36, 39),
    chip: SGR(35, 39),
    agent: SGR(95, 39),
  },
  // No colour: bold and inverse only, so selection is still visible.
  none: {
    border: ['', ''],
    title: SGR(1, 22),
    selected: SGR(7, 27),
    dim: ['', ''],
    green: ['', ''],
    yellow: ['', ''],
    red: ['', ''],
    accent: ['', ''],
    chip: ['', ''],
    agent: ['', ''],
  },
}

export interface Theme {
  readonly color: ColorTier
  readonly glyphs: Glyphs
  paint(style: Style | undefined, text: string): string
}

export function makeTheme(color: ColorTier, glyphs: GlyphTier): Theme {
  const palette = color === 'plain' ? undefined : PALETTES[color]
  return {
    color,
    glyphs: glyphs === 'unicode' ? UNICODE : ASCII,
    paint(style, text) {
      if (style === undefined || palette === undefined || text.length === 0) return text
      const [open, close] = palette[style]
      return `${open}${text}${close}`
    },
  }
}

/** Pick tiers from the environment, the way terminals advertise themselves. */
export function detectTheme(
  env: Readonly<Record<string, string | undefined>>,
  options: { color?: boolean } = {},
): Theme {
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? ''
  const glyphs: GlyphTier = env.YUZIE_ASCII === '1' || !/utf-?8/i.test(locale) ? 'ascii' : 'unicode'

  let color: ColorTier
  if (options.color === false || (env.NO_COLOR !== undefined && env.NO_COLOR !== '')) color = 'none'
  else if (/truecolor|24bit/i.test(env.COLORTERM ?? '')) color = 'truecolor'
  else if (/256/.test(env.TERM ?? '')) color = '256'
  else color = '16'

  return makeTheme(color, glyphs)
}
