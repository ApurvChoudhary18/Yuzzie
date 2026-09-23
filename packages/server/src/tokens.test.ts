import { describe, expect, it } from 'vitest'
import {
  generateDeviceCode,
  generateToken,
  generateUserCode,
  hashToken,
  TOKEN_PREFIX,
  tokenHashEquals,
} from './auth/tokens.js'

describe('generateToken', () => {
  it('is prefixed so a leaked string is recognisable', () => {
    expect(generateToken().startsWith(TOKEN_PREFIX)).toBe(true)
  })

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, generateToken))
    expect(tokens.size).toBe(500)
  })

  it('carries at least 256 bits of entropy', () => {
    const body = generateToken().slice(TOKEN_PREFIX.length)
    expect(Buffer.from(body, 'base64url').length).toBe(32)
  })
})

describe('hashToken', () => {
  it('is a stable sha256 hex digest', () => {
    const token = generateToken()
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never contains the token itself', () => {
    const token = generateToken()
    expect(hashToken(token)).not.toContain(token.slice(TOKEN_PREFIX.length))
  })

  it('differs for tokens that differ by one character', () => {
    expect(hashToken('yz_aaaa')).not.toBe(hashToken('yz_aaab'))
  })
})

describe('tokenHashEquals', () => {
  it('compares equal hashes as equal', () => {
    const hash = hashToken(generateToken())
    expect(tokenHashEquals(hash, hash)).toBe(true)
  })

  it('rejects different hashes and different lengths', () => {
    expect(tokenHashEquals(hashToken('a'), hashToken('b'))).toBe(false)
    expect(tokenHashEquals('short', hashToken('a'))).toBe(false)
  })
})

describe('generateUserCode', () => {
  it('looks like the WXYZ-4821 in §6.1', () => {
    expect(generateUserCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  })

  it('avoids characters that are misread aloud', () => {
    const codes = Array.from({ length: 200 }, generateUserCode).join('')
    for (const confusable of ['O', 'I', '0', '1']) {
      expect(codes).not.toContain(confusable)
    }
  })

  it('does not repeat in practice', () => {
    const codes = new Set(Array.from({ length: 500 }, generateUserCode))
    expect(codes.size).toBeGreaterThan(495)
  })
})

describe('generateDeviceCode', () => {
  it('is long, url-safe and unique', () => {
    const codes = Array.from({ length: 200 }, generateDeviceCode)
    expect(new Set(codes).size).toBe(200)
    for (const code of codes) {
      expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/)
    }
  })
})
