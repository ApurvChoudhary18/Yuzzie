import { describe, expect, it } from 'vitest'
import { COMMENT_ID, makeCard, T1 } from './__fixtures__/board.js'
import { matchesSearch, searchWords } from './search.js'

const card = makeCard({
  comments: [
    {
      id: COMMENT_ID,
      cardNumber: 18,
      author: 'priya',
      body: 'Reproduced on Safari only',
      createdAt: T1,
      editedAt: null,
    },
  ],
})

describe('matchesSearch', () => {
  it('matches the title, description, comments, labels, assignees and number', () => {
    expect(matchesSearch(card, 'oauth')).toBe(true)
    expect(matchesSearch(card, 'redirect')).toBe(true)
    expect(matchesSearch(card, 'safari')).toBe(true)
    expect(matchesSearch(card, 'auth')).toBe(true)
    expect(matchesSearch(card, '@rahul')).toBe(true)
    expect(matchesSearch(card, 'rahul')).toBe(true)
    expect(matchesSearch(card, '#18')).toBe(true)
  })

  it('is case-insensitive and needs every word, in any field', () => {
    expect(matchesSearch(card, 'GITHUB safari')).toBe(true)
    expect(matchesSearch(card, 'github firefox')).toBe(false)
  })

  it('matches everything for an empty query', () => {
    expect(matchesSearch(card, '   ')).toBe(true)
    expect(searchWords('  a  B ')).toEqual(['a', 'b'])
  })
})
