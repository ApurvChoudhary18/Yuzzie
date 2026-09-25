import { type Card, initialState, NotFoundError } from '@yuzie/core'
import { describe, expect, it } from 'vitest'
import { parseAnchor } from './commands/cards.js'
import { parseDue, parseDuration, parsePriority } from './dates.js'
import { diffCard, parseDocument, toDocument } from './edit.js'
import { UsageError } from './exit.js'
import type { Prompter } from './prompt.js'
import { candidates, resolveCard } from './resolve.js'

/** Thursday 1 October 2026, 10:30 local time. */
const NOW = new Date(2026, 9, 1, 10, 30)
const endOf = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day, 23, 59, 59, 999).toISOString()

describe('parseDue (§7.2 natural-language dates)', () => {
  it.each([
    ['today', endOf(2026, 10, 1)],
    ['tomorrow', endOf(2026, 10, 2)],
    ['friday', endOf(2026, 10, 2)],
    ['Fri', endOf(2026, 10, 2)],
    ['wednesday', endOf(2026, 10, 7)],
    ['thursday', endOf(2026, 10, 8)],
    ['next monday', endOf(2026, 10, 5)],
    ['+3d', endOf(2026, 10, 4)],
    ['in 2 weeks', endOf(2026, 10, 15)],
    ['2026-12-24', endOf(2026, 12, 24)],
    ['2026-10-03T09:00:00Z', '2026-10-03T09:00:00.000Z'],
  ])('%s', (input, expected) => {
    expect(parseDue(input, NOW)).toBe(expected)
  })

  it('clears with none, and explains what it cannot read', () => {
    expect(parseDue('none', NOW)).toBeNull()
    expect(() => parseDue('someday', NOW)).toThrow(UsageError)
    const error = (() => {
      try {
        parseDue('2026-02-30', NOW)
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(UsageError)
    expect((error as UsageError).fix).toContain('friday')
  })

  it('reads durations and priorities', () => {
    expect(parseDuration('2d')).toBe(2 * 86_400_000)
    expect(parseDuration('90m')).toBe(90 * 60_000)
    expect(() => parseDuration('soon')).toThrow(UsageError)
    expect(parsePriority('p1')).toBe(1)
    expect(parsePriority('3')).toBe(3)
    expect(parsePriority('none')).toBeNull()
    expect(() => parsePriority('p7')).toThrow(UsageError)
  })

  it('reads code locations', () => {
    expect(parseAnchor('src/auth/oauth.ts:42')).toEqual({ path: 'src/auth/oauth.ts', line: 42 })
    expect(parseAnchor('src/a.ts:10-20')).toEqual({ path: 'src/a.ts', line: 10, endLine: 20 })
    expect(parseAnchor('README.md')).toEqual({ path: 'README.md' })
  })
})

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    boardId: '11111111-1111-4111-8111-111111111111',
    number: 18,
    column: 'doing',
    rank: 'a',
    title: 'Fix GitHub OAuth',
    description: 'The callback 500s.',
    priority: 1,
    dueAt: endOf(2026, 10, 2),
    assignees: ['rahul'],
    labels: ['bug', 'auth'],
    watchers: [],
    checklist: [],
    comments: [],
    commits: [],
    git: null,
    anchor: null,
    createdBy: 'rahul',
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 4,
    ...overrides,
  }
}

describe('yuzie edit round-trip', () => {
  it('an untouched document produces no PATCH at all', () => {
    const original = card()
    expect(diffCard(original, parseDocument(toDocument(original)), NOW)).toEqual({})
    const bare = card({ description: null, priority: null, dueAt: null, labels: [] })
    expect(diffCard(bare, parseDocument(toDocument(bare)), NOW)).toEqual({})
  })

  it('produces only the fields that changed', () => {
    const original = card()
    const edited = toDocument(original)
      .replace('title: Fix GitHub OAuth', 'title: Fix GitHub OAuth callback')
      .replace('labels: [bug, auth]', 'labels: [auth, bug, p0-incident]')
      .replace('The callback 500s.', 'The callback 500s when state is missing.')
    expect(diffCard(original, parseDocument(edited), NOW)).toEqual({
      title: 'Fix GitHub OAuth callback',
      labels: ['auth', 'bug', 'p0-incident'],
      description: 'The callback 500s when state is missing.',
    })
  })

  it('reordering labels is not a change; clearing priority and due is', () => {
    const original = card()
    const edited = toDocument(original)
      .replace('labels: [bug, auth]', 'labels: [auth, bug]')
      .replace('priority: p1', 'priority:')
      .replace(/^due: .*$/m, 'due: friday')
    expect(diffCard(original, parseDocument(edited), NOW)).toEqual({ priority: null })
    const cleared = toDocument(original).replace(/^due: .*$/m, 'due:')
    expect(diffCard(original, parseDocument(cleared), NOW)).toEqual({ dueAt: null })
  })

  it('refuses a document it cannot trust', () => {
    expect(() => parseDocument('title: x')).toThrow(/front matter/)
    expect(() => parseDocument('---\ntitle: ""\n---\n')).toThrow(/title/)
    expect(() => parseDocument('---\ntitle: x\nlabels: bug\n---\n')).toThrow(/labels/)
    expect(() => parseDocument('---\ntitle: x\npriority: urgent\n---\n')).toThrow(UsageError)
  })
})

describe('card resolution (§7.5)', () => {
  const cards = {
    18: card({ number: 18, title: 'Fix GitHub OAuth' }),
    22: card({ number: 22, title: 'OAuth scopes for agents' }),
    30: card({ number: 30, title: 'Write docs' }),
  }
  const state = initialState({ cards })

  it('accepts 18 and #18', async () => {
    expect((await resolveCard({ state, slug: 'b', prompter: null }, '18')).number).toBe(18)
    expect((await resolveCard({ state, slug: 'b', prompter: null }, '#30')).number).toBe(30)
  })

  it('prefers a title prefix, then a substring', () => {
    expect(candidates(state, 'oauth').map((c) => c.number)).toEqual([22])
    expect(candidates(state, 'github').map((c) => c.number)).toEqual([18])
    expect(candidates(state, 'o').map((c) => c.number)).toEqual([22])
  })

  it('exits 4 for an unknown number or an ambiguous title when nobody can be asked', async () => {
    await expect(resolveCard({ state, slug: 'b', prompter: null }, '99')).rejects.toBeInstanceOf(
      NotFoundError,
    )
    const ambiguous = initialState({
      cards: { ...cards, 31: card({ number: 31, title: 'Write tests' }) },
    })
    const error = await resolveCard({ state: ambiguous, slug: 'b', prompter: null }, 'write').catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(NotFoundError)
    expect((error as NotFoundError).exitCode).toBe(4)
    expect((error as NotFoundError).message).toContain('#30 Write docs, #31 Write tests')
  })

  it('asks which one when someone can answer', async () => {
    const ambiguous = initialState({
      cards: { ...cards, 31: card({ number: 31, title: 'Write tests' }) },
    })
    const asked: string[][] = []
    const prompter = {
      choose: async (_question: string, options: readonly string[]) => {
        asked.push([...options])
        return 1
      },
    } as unknown as Prompter
    const chosen = await resolveCard({ state: ambiguous, slug: 'b', prompter }, 'write')
    expect(asked).toEqual([['#30 Write docs', '#31 Write tests']])
    expect(chosen.number).toBe(31)
  })
})
