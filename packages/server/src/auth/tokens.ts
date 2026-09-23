/**
 * Bearer tokens (SPEC.md §14.1, §13.3).
 *
 * Only the sha256 of a token is ever stored, so a database dump does not hand
 * anyone a working credential. The plaintext is returned exactly once, at
 * creation, and never again.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const TOKEN_PREFIX = 'yz_'
const TOKEN_BYTES = 32

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time comparison, so a hash cannot be discovered a byte at a time. */
export function tokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** A short, unambiguous code a human reads aloud or types (§6.1: `WXYZ-4821`). */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateUserCode(): string {
  const pick = () => {
    const bytes = randomBytes(4)
    return Array.from(bytes, (byte) => {
      const index = byte % USER_CODE_ALPHABET.length
      return USER_CODE_ALPHABET[index] ?? 'A'
    }).join('')
  }
  return `${pick()}-${pick()}`
}

export function generateDeviceCode(): string {
  return randomBytes(24).toString('base64url')
}
