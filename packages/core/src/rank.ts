/**
 * Fractional indexing (SPEC.md §11.4).
 *
 * A rank is a base-62 fraction written so that plain lexicographic string order
 * is the card order. Inserting between two neighbours computes a string strictly
 * between them, so no sibling row is ever rewritten and concurrent moves in
 * different parts of a column cannot conflict.
 *
 * The digit alphabet is ASCII-ordered (digits < uppercase < lowercase), which is
 * what makes byte comparison, SQL `ORDER BY`, and JavaScript `<` all agree.
 *
 * Invariant: a rank is non-empty and never ends in the smallest digit, because
 * "a" and "a0" denote the same fraction and nothing could be placed between them.
 */
import { ValidationError } from './errors.js'
import type { Rank } from './types.js'

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length
const MIN_DIGIT = '0'
/** 62**9 exceeds Number.MAX_SAFE_INTEGER, so integer maths stays exact below this. */
const MAX_REBALANCE_WIDTH = 8

export const RANK_DIGITS = DIGITS

function digitAt(index: number): string {
  const digit = DIGITS[index]
  if (digit === undefined) {
    throw new ValidationError('validation_failed', `Rank digit index ${index} is out of range`)
  }
  return digit
}

function indexOfDigit(char: string): number {
  const index = DIGITS.indexOf(char)
  if (index === -1) {
    throw new ValidationError(
      'validation_failed',
      `Rank contains ${JSON.stringify(char)}, which is not one of ${DIGITS}`,
    )
  }
  return index
}

/** True when `rank` is a well-formed fractional index. */
export function isValidRank(rank: string): boolean {
  if (rank.length === 0 || rank.endsWith(MIN_DIGIT)) return false
  for (const char of rank) {
    if (DIGITS.indexOf(char) === -1) return false
  }
  return true
}

function assertValidRank(rank: string, label: string): void {
  if (!isValidRank(rank)) {
    throw new ValidationError(
      'validation_failed',
      `The ${label} rank ${JSON.stringify(rank)} is not a valid fractional index`,
      { details: { rank, label } },
    )
  }
}

/**
 * The shortest string strictly between `a` and `b`, where `a` may be the empty
 * fraction and `b` may be absent (meaning "the end").
 */
function midpoint(a: string, b: string | undefined): string {
  if (b !== undefined && a >= b) {
    throw new ValidationError(
      'validation_failed',
      `Cannot rank between ${JSON.stringify(a)} and ${JSON.stringify(b)}: they are out of order`,
      { details: { before: a, after: b } },
    )
  }

  if (b !== undefined) {
    // Recurse past the longest common prefix so the maths only sees the part
    // that actually differs.
    let shared = 0
    while ((a[shared] ?? MIN_DIGIT) === b[shared]) {
      shared += 1
    }
    if (shared > 0) {
      return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared))
    }
  }

  const firstOfA = a[0]
  const digitA = firstOfA === undefined ? 0 : indexOfDigit(firstOfA)
  const firstOfB = b?.[0]
  const digitB = firstOfB === undefined ? BASE : indexOfDigit(firstOfB)

  if (digitB - digitA > 1) {
    return digitAt(Math.round(0.5 * (digitA + digitB)))
  }
  if (b !== undefined && b.length > 1) {
    // The digits are adjacent but `b` has more to give, so `b`'s first digit
    // alone already sorts below `b` and above `a`.
    return b.slice(0, 1)
  }
  // Adjacent digits with nowhere left to split: borrow a place.
  return digitAt(digitA) + midpoint(a.slice(1), undefined)
}

/**
 * A rank strictly between `before` and `after`.
 *
 * Omit `before` to insert at the head, `after` to insert at the tail, or both to
 * seed an empty column.
 */
export function rankBetween(before?: string, after?: string): Rank {
  if (before !== undefined) assertValidRank(before, 'before')
  if (after !== undefined) assertValidRank(after, 'after')
  return midpoint(before ?? '', after)
}

/** A rank that sorts before `firstExisting`, or the seed rank for an empty column. */
export function rankFirst(firstExisting?: string): Rank {
  return rankBetween(undefined, firstExisting)
}

/** A rank that sorts after `lastExisting`, or the seed rank for an empty column. */
export function rankLast(lastExisting?: string): Rank {
  return rankBetween(lastExisting, undefined)
}

export function compareRanks(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function encodeFixedWidth(value: number, width: number): string {
  let remaining = value
  let out = ''
  for (let place = 0; place < width; place += 1) {
    out = digitAt(remaining % BASE) + out
    remaining = Math.floor(remaining / BASE)
  }
  return out
}

function trimTrailingMinDigit(rank: string): string {
  let end = rank.length
  while (end > 1 && rank[end - 1] === MIN_DIGIT) {
    end -= 1
  }
  return rank.slice(0, end)
}

/**
 * `count` evenly spaced ranks, for the lazy rebalance a rank collision triggers
 * (SPEC.md §11.4). Spreading the column across the whole key space gives every
 * future insert the maximum room before it needs to grow a digit.
 */
export function rebalance(count: number): Rank[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new ValidationError(
      'validation_failed',
      `Cannot rebalance ${count} cards: expected a non-negative integer`,
    )
  }
  if (count === 0) return []

  let width = 1
  while (BASE ** width < count + 1) {
    width += 1
    if (width > MAX_REBALANCE_WIDTH) {
      throw new ValidationError(
        'validation_failed',
        `Cannot rebalance ${count} cards in one column`,
      )
    }
  }

  const slot = BASE ** width / (count + 1)
  const ranks: Rank[] = []
  for (let index = 1; index <= count; index += 1) {
    ranks.push(trimTrailingMinDigit(encodeFixedWidth(Math.floor(index * slot), width)))
  }
  return ranks
}
