/**
 * §18 Session 14: search over a 2,000-card board from the local cache (what
 * `yuzie list --search` and the TUI's `/` do offline) in under 200 ms — opening
 * the cache, reading every card and matching them all. Runs in the `bench` task.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchesSearch, rebalance } from '@yuzie/core'
import { openCache } from '@yuzie/store'
import { beforeAll, describe, expect, it } from 'vitest'
import { card, column } from './tui/__tests__/fixtures.js'

const CARDS = 2_000
const BUDGET_MS = 200
const SLUG = 'bench'
const WORDS = ['oauth', 'webhook', 'billing', 'invoice', 'cache', 'retry', 'export', 'search']

let home = ''
let cwd = ''

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-search-home-')))
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-search-cwd-')))
  const cache = openCache({ boardSlug: SLUG, cwd, home, env: {} })
  const ranks = rebalance(CARDS)
  cache.columns.putMany(SLUG, [
    column('todo', 'Todo', 0, 'backlog'),
    column('doing', 'Doing', 1, 'in_progress'),
    column('done', 'Done', 2, 'terminal'),
  ])
  cache.cards.putMany(
    SLUG,
    Array.from({ length: CARDS }, (_, index) =>
      card(index + 1, {
        rank: ranks[index] as string,
        column: ['todo', 'doing', 'done'][index % 3] as string,
        title: `${WORDS[index % WORDS.length]} task ${index + 1}`,
        description: `Details for ${WORDS[(index * 3) % WORDS.length]} work, item ${index}.`,
        labels: index % 10 === 0 ? ['backend'] : [],
        comments: [
          {
            id: `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
            cardNumber: index + 1,
            author: 'priya',
            body: index % 97 === 0 ? 'Reproduced on Safari only' : 'Looks fine here',
            createdAt: '2026-08-19T09:00:00Z',
            editedAt: null,
          },
        ],
      }),
    ),
  )
  cache.close()
})

/** What an offline search costs, end to end: open, read, match. */
function searchFromCache(query: string): number {
  const cache = openCache({ boardSlug: SLUG, cwd, home, env: {} })
  try {
    return cache.cards.list(SLUG).filter((subject) => matchesSearch(subject, query)).length
  } finally {
    cache.close()
  }
}

describe(`search over ${CARDS} cached cards (§18 Session 14)`, () => {
  it.each([
    ['safari', 21],
    ['oauth task 1', undefined],
    ['backend', CARDS / 10],
  ])(`"%s" answers in under ${BUDGET_MS} ms`, (query, expected) => {
    searchFromCache(query) // warm the file cache
    const times: number[] = []
    let found = 0
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now()
      found = searchFromCache(query)
      times.push(performance.now() - started)
    }
    const median = [...times].sort((a, b) => a - b)[2] ?? 0
    console.log(`cache search "${query}": ${found} cards, median ${median.toFixed(1)} ms`)
    if (expected !== undefined) expect(found).toBe(expected)
    expect(found).toBeGreaterThan(0)
    expect(median).toBeLessThan(BUDGET_MS)
  })
})
