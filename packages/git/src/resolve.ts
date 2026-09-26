/**
 * Which card a commit belongs to (SPEC.md §9.6), in order:
 *
 *   1. an explicit `Board-Card: 18` trailer;
 *   2. `#18` anywhere in the subject or body;
 *   3. the branch name, matched against the configured template;
 *   4. the one card this user has claimed that is in progress, if exactly one.
 *
 * Otherwise the commit is unattributed (the caller buffers it for `yuzie sync`).
 */

export type ResolutionRule = 'trailer' | 'mention' | 'branch' | 'claimed'

export interface Resolution {
  readonly cardNo: number
  readonly rule: ResolutionRule
}

const TRAILER = /^Board-Card:\s*#?(\d+)\s*$/im
/** `#18`, but not `&#18;`, a URL fragment, or part of a word. */
const MENTION = /(?:^|[\s([{,;:'"])#(\d+)\b/

function positive(text: string | undefined): number | null {
  const number = Number(text)
  return Number.isInteger(number) && number > 0 ? number : null
}

/** Build a matcher for branch names from the template, e.g. `task/{id}-{slug}`. */
export function cardFromBranch(branch: string, template: string): number | null {
  if (!template.includes('{id}')) return null
  const pattern = template
    .split(/(\{id\}|\{slug\}|\{user\}|\{column\})/)
    .map((part) => {
      switch (part) {
        case '{id}':
          return '(\\d+)'
        case '{slug}':
          return '.*?'
        case '{user}':
        case '{column}':
          return '[^/]+?'
        default:
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }
    })
    .join('')
  return positive(new RegExp(`^${pattern}$`).exec(branch)?.[1])
}

export function cardForCommit(input: {
  readonly message: string
  readonly branch: string | null
  readonly template: string
  /** Cards claimed by this user and in an in-progress column. */
  readonly claimed: readonly number[]
}): Resolution | null {
  const trailer = positive(TRAILER.exec(input.message)?.[1])
  if (trailer !== null) return { cardNo: trailer, rule: 'trailer' }
  const mention = positive(MENTION.exec(input.message)?.[1])
  if (mention !== null) return { cardNo: mention, rule: 'mention' }
  if (input.branch !== null) {
    const fromBranch = cardFromBranch(input.branch, input.template)
    if (fromBranch !== null) return { cardNo: fromBranch, rule: 'branch' }
  }
  const [only, ...others] = input.claimed
  if (only !== undefined && others.length === 0) return { cardNo: only, rule: 'claimed' }
  return null
}
