/**
 * Card ID resolution (SPEC.md §7.5).
 *
 * `18` and `#18` are card numbers. Anything else is matched against titles:
 * titles that start with it first, then titles that contain it, ignoring case.
 * One match is used; several prompt for a choice — or, under `--json`/`--yes`
 * where nobody can answer, exit 4 listing the candidates.
 */
import { type BoardState, type Card, NotFoundError } from '@yuzie/core'
import type { Prompter } from './prompt.js'

export interface Resolver {
  readonly state: BoardState
  readonly slug: string
  /** Null when no one can be asked (`--json`, `--yes`). */
  readonly prompter: Prompter | null
}

export function candidates(state: BoardState, query: string): Card[] {
  const needle = query.trim().toLowerCase()
  const cards = Object.values(state.cards).sort((a, b) => a.number - b.number)
  const prefixed = cards.filter((card) => card.title.toLowerCase().startsWith(needle))
  if (prefixed.length > 0) return prefixed
  return cards.filter((card) => card.title.toLowerCase().includes(needle))
}

export async function resolveCard(resolver: Resolver, reference: string): Promise<Card> {
  const { state, slug } = resolver
  const numeric = /^#?(\d+)$/.exec(reference.trim())
  if (numeric !== null) {
    const number = Number(numeric[1])
    const card = state.cards[number]
    if (card === undefined) {
      throw new NotFoundError('card_not_found', `Card #${number} does not exist on board ${slug}`, {
        details: { boardSlug: slug, number },
      })
    }
    return card
  }

  const found = candidates(state, reference)
  if (found.length === 1) return found[0] as Card
  if (found.length === 0) {
    throw new NotFoundError('card_not_found', `No card on ${slug} matches "${reference}"`, {
      details: { boardSlug: slug, query: reference },
    })
  }

  const list = found.map((card) => `#${card.number} ${card.title}`)
  if (resolver.prompter === null) {
    throw new NotFoundError(
      'card_not_found',
      `"${reference}" matches ${found.length} cards: ${list.join(', ')}. Use the number.`,
      { details: { boardSlug: slug, query: reference, candidates: found.map((c) => c.number) } },
    )
  }

  const choice = await resolver.prompter.choose(
    `"${reference}" matches ${found.length} cards. Which one?`,
    list,
  )
  return found[choice] as Card
}
