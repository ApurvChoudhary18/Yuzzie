/**
 * Title -> branch name (SPEC.md §9.2).
 *
 * The slug is deliberately ASCII-only. Git accepts UTF-8 refs, but a branch name
 * is typed, tab-completed, pasted into PR URLs, and read aloud in standups, so a
 * title in a non-Latin script or made of emoji falls back to {@link FALLBACK_SLUG}
 * rather than producing a ref nobody can type.
 */
import { ValidationError } from './errors.js'

export const DEFAULT_BRANCH_TEMPLATE = 'task/{id}-{slug}'
export const DEFAULT_SLUG_MAX_LENGTH = 40
export const FALLBACK_SLUG = 'card'

const COMBINING_MARKS = /\p{M}+/gu
const NON_SLUG_CHARS = /[^a-z0-9]+/g
const EDGE_DASHES = /^-+|-+$/g
const FORBIDDEN_BRANCH_CHARS = '~^:?*[\\'

/**
 * Lowercase, non-alphanumerics collapsed to `-`, truncated, trailing `-` stripped.
 *
 * Accents are folded first (`Café` -> `cafe`) so a Latin title keeps its meaning.
 */
export function slugify(title: string, maxLength: number = DEFAULT_SLUG_MAX_LENGTH): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new ValidationError(
      'validation_failed',
      `Slug maxLength must be a positive integer, got ${maxLength}`,
    )
  }

  const folded = title.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase()
  const dashed = folded.replace(NON_SLUG_CHARS, '-').replace(EDGE_DASHES, '')
  const truncated = dashed.slice(0, maxLength).replace(EDGE_DASHES, '')

  return truncated.length > 0 ? truncated : FALLBACK_SLUG
}

/** The minimum a card must expose to name its branch. */
export interface BranchCard {
  readonly number: number
  readonly title: string
  readonly column?: string
}

export interface BranchContext {
  /** Fills `{user}` in templates like `{user}/{id}-{slug}`. */
  readonly user?: string
  readonly slugMaxLength?: number
}

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g
const SUPPORTED_PLACEHOLDERS = ['id', 'slug', 'user', 'column'] as const

/**
 * True for a name Git will accept as a branch ref. Deliberately stricter than
 * `git check-ref-format` in places where being strict costs nothing.
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0) return false
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) return false

  for (const char of name) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) return false
    if (FORBIDDEN_BRANCH_CHARS.includes(char)) return false
  }

  return name
    .split('/')
    .every(
      (segment) => segment.length > 0 && !segment.startsWith('.') && !segment.endsWith('.lock'),
    )
}

/**
 * Render a card's branch name from a template.
 *
 * Supported placeholders: `{id}`, `{slug}`, `{user}`, `{column}`. An unknown one
 * is a typo in `.yuzie/config.json` and fails loudly rather than leaking a literal
 * `{brnach}` into a ref name.
 */
export function branchFor(
  card: BranchCard,
  template: string = DEFAULT_BRANCH_TEMPLATE,
  context: BranchContext = {},
): string {
  const slug = slugify(card.title, context.slugMaxLength ?? DEFAULT_SLUG_MAX_LENGTH)

  const rendered = template.replace(PLACEHOLDER, (match, rawName: string) => {
    switch (rawName) {
      case 'id':
        return String(card.number)
      case 'slug':
        return slug
      case 'column':
        return card.column === undefined ? '' : slugify(card.column)
      case 'user': {
        if (context.user === undefined) {
          throw new ValidationError(
            'validation_failed',
            `Branch template ${JSON.stringify(template)} uses {user} but no user was supplied`,
            { details: { template } },
          )
        }
        return slugify(context.user)
      }
      default:
        throw new ValidationError(
          'validation_failed',
          `Branch template ${JSON.stringify(template)} uses unknown placeholder ${match}. Supported: ${SUPPORTED_PLACEHOLDERS.map((name) => `{${name}}`).join(', ')}`,
          { details: { template, placeholder: rawName } },
        )
    }
  })

  if (!isValidBranchName(rendered)) {
    throw new ValidationError(
      'validation_failed',
      `Branch template ${JSON.stringify(template)} produced ${JSON.stringify(rendered)}, which is not a valid Git branch name`,
      { details: { template, branch: rendered } },
    )
  }

  return rendered
}
