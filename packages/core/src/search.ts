/**
 * Card search (SPEC.md §18 Session 14): one meaning everywhere — the server
 * (which narrows with SQL first), the CLI offline, and the TUI's `/`.
 *
 * Every word of the query must appear, case-insensitively, somewhere in the
 * card: its `#number`, title, description, a comment, a label, or an
 * `@assignee`. Words may land in different fields.
 */
import type { Card } from './types.js'

/** The query as lowercase words. */
export function searchWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
}

/** Everything a search looks at, lowercased. */
export function searchFields(card: Card): string[] {
  return [
    `#${card.number}`,
    card.title,
    card.description ?? '',
    ...card.comments.map((comment) => comment.body),
    ...card.labels,
    ...card.assignees.map((handle) => `@${handle}`),
  ].map((field) => field.toLowerCase())
}

export function matchesSearch(card: Card, query: string): boolean {
  const words = searchWords(query)
  if (words.length === 0) return true
  const fields = searchFields(card)
  return words.every((word) => fields.some((field) => field.includes(word)))
}
