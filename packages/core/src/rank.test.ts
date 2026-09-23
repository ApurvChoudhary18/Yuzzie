import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors.js'
import {
  compareRanks,
  isValidRank,
  RANK_DIGITS,
  rankBetween,
  rankFirst,
  rankLast,
  rebalance,
} from './rank.js'

/** Fixed so a failure is reproducible rather than a Tuesday-only mystery. */
const SEED = 20260923

describe('isValidRank', () => {
  it('accepts ranks made of the digit alphabet', () => {
    expect(isValidRank('V')).toBe(true)
    expect(isValidRank('a0V')).toBe(true)
    expect(isValidRank('zzzz1')).toBe(true)
  })

  it('rejects the empty rank', () => {
    expect(isValidRank('')).toBe(false)
  })

  it('rejects a trailing minimum digit, which would have no room beneath it', () => {
    expect(isValidRank('a0')).toBe(false)
    expect(isValidRank('0')).toBe(false)
  })

  it('rejects characters outside the alphabet', () => {
    expect(isValidRank('a-b')).toBe(false)
    expect(isValidRank('héllo')).toBe(false)
  })
})

describe('the digit alphabet', () => {
  it('is already in lexicographic order, so string < is numeric <', () => {
    const sorted = [...RANK_DIGITS].sort()
    expect(sorted.join('')).toBe(RANK_DIGITS)
  })
})

describe('rankBetween', () => {
  it('seeds an empty column when both bounds are absent', () => {
    const rank = rankBetween()
    expect(isValidRank(rank)).toBe(true)
  })

  it('produces a rank strictly between two neighbours', () => {
    const a = rankBetween()
    const c = rankLast(a)
    const b = rankBetween(a, c)
    expect(compareRanks(a, b)).toBe(-1)
    expect(compareRanks(b, c)).toBe(-1)
  })

  it('leaves room between adjacent digits by borrowing a place', () => {
    const between = rankBetween('1', '2')
    expect(compareRanks('1', between)).toBe(-1)
    expect(compareRanks(between, '2')).toBe(-1)
    expect(isValidRank(between)).toBe(true)
  })

  it('splits using the upper bound when the digits are adjacent but b is longer', () => {
    const between = rankBetween('1', '21')
    expect(compareRanks('1', between)).toBe(-1)
    expect(compareRanks(between, '21')).toBe(-1)
    expect(between).toBe('2')
  })

  it('handles bounds that share a long prefix', () => {
    const between = rankBetween('aaaa1', 'aaaa2')
    expect(compareRanks('aaaa1', between)).toBe(-1)
    expect(compareRanks(between, 'aaaa2')).toBe(-1)
  })

  it('rejects bounds that are out of order', () => {
    expect(() => rankBetween('b', 'a')).toThrow(ValidationError)
    expect(() => rankBetween('a', 'a')).toThrow(ValidationError)
  })

  it('rejects malformed bounds with an actionable message', () => {
    expect(() => rankBetween('a0')).toThrow(/not a valid fractional index/)
    expect(() => rankBetween(undefined, '')).toThrow(ValidationError)
    expect(() => rankBetween('a b')).toThrow(ValidationError)
  })
})

describe('rankFirst and rankLast', () => {
  it('sort before and after an existing rank', () => {
    const middle = rankBetween()
    expect(compareRanks(rankFirst(middle), middle)).toBe(-1)
    expect(compareRanks(middle, rankLast(middle))).toBe(-1)
  })

  it('stay valid when prepending repeatedly', () => {
    let head = rankBetween()
    for (let i = 0; i < 200; i += 1) {
      const next = rankFirst(head)
      expect(isValidRank(next)).toBe(true)
      expect(compareRanks(next, head)).toBe(-1)
      head = next
    }
  })

  it('stay valid when appending repeatedly', () => {
    let tail = rankBetween()
    for (let i = 0; i < 200; i += 1) {
      const next = rankLast(tail)
      expect(isValidRank(next)).toBe(true)
      expect(compareRanks(tail, next)).toBe(-1)
      tail = next
    }
  })
})

describe('compareRanks', () => {
  it('orders lexicographically and reports equality', () => {
    expect(compareRanks('a', 'b')).toBe(-1)
    expect(compareRanks('b', 'a')).toBe(1)
    expect(compareRanks('a', 'a')).toBe(0)
  })
})

describe('rebalance', () => {
  it('returns nothing for an empty column', () => {
    expect(rebalance(0)).toEqual([])
  })

  it('returns strictly increasing valid ranks', () => {
    for (const count of [1, 2, 61, 62, 63, 500, 2000]) {
      const ranks = rebalance(count)
      expect(ranks).toHaveLength(count)
      for (const rank of ranks) {
        expect(isValidRank(rank)).toBe(true)
      }
      const sorted = [...ranks].sort(compareRanks)
      expect(sorted).toEqual(ranks)
      expect(new Set(ranks).size).toBe(count)
    }
  })

  it('leaves room to insert between every rebalanced pair', () => {
    const ranks = rebalance(50)
    for (let i = 1; i < ranks.length; i += 1) {
      const before = ranks[i - 1]
      const after = ranks[i]
      if (before === undefined || after === undefined) throw new Error('unreachable')
      const inserted = rankBetween(before, after)
      expect(compareRanks(before, inserted)).toBe(-1)
      expect(compareRanks(inserted, after)).toBe(-1)
    }
  })

  it('rejects counts that are not non-negative integers', () => {
    expect(() => rebalance(-1)).toThrow(ValidationError)
    expect(() => rebalance(1.5)).toThrow(ValidationError)
  })

  it('refuses a column larger than the addressable key space', () => {
    expect(() => rebalance(62 ** 8 + 1)).toThrow(ValidationError)
  })
})

describe('property: 1,000 random insertions', () => {
  it('preserve ordering and never produce a duplicate', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
          minLength: 1000,
          maxLength: 1000,
        }),
        (picks) => {
          const ranks: string[] = []

          for (const pick of picks) {
            const index = Math.min(ranks.length, Math.floor(pick * (ranks.length + 1)))
            const before = index > 0 ? ranks[index - 1] : undefined
            const after = index < ranks.length ? ranks[index] : undefined

            const rank = rankBetween(before, after)

            expect(isValidRank(rank)).toBe(true)
            if (before !== undefined) expect(compareRanks(before, rank)).toBe(-1)
            if (after !== undefined) expect(compareRanks(rank, after)).toBe(-1)

            ranks.splice(index, 0, rank)
          }

          // The list was maintained in insertion position order; it must also be
          // in lexicographic order, and every rank must be distinct.
          expect(new Set(ranks).size).toBe(ranks.length)
          expect([...ranks].sort(compareRanks)).toEqual(ranks)
        },
      ),
      { numRuns: 5, seed: SEED },
    )
  })
})
