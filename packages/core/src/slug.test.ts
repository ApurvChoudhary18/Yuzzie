import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors.js'
import {
  branchFor,
  DEFAULT_BRANCH_TEMPLATE,
  DEFAULT_SLUG_MAX_LENGTH,
  FALLBACK_SLUG,
  isValidBranchName,
  slugify,
} from './slug.js'

const DEL = String.fromCharCode(0x7f)

describe('slugify', () => {
  it('lowercases and collapses non-alphanumerics to a single dash', () => {
    expect(slugify('Fix GitHub OAuth')).toBe('fix-github-oauth')
    expect(slugify('Fix   GitHub -- OAuth!!')).toBe('fix-github-oauth')
  })

  it('strips leading and trailing dashes', () => {
    expect(slugify('  ...Fix OAuth...  ')).toBe('fix-oauth')
  })

  it('truncates to 40 characters and never leaves a trailing dash', () => {
    const slug = slugify(`${'a'.repeat(30)} ${'b'.repeat(30)}`)
    expect(slug.length).toBeLessThanOrEqual(DEFAULT_SLUG_MAX_LENGTH)
    expect(slug.endsWith('-')).toBe(false)
  })

  it('handles a 200-character title', () => {
    const title = 'Refactor the authentication middleware so that '.repeat(5)
    const slug = slugify(title)
    expect(title.length).toBeGreaterThan(200)
    expect(slug.length).toBeLessThanOrEqual(DEFAULT_SLUG_MAX_LENGTH)
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('folds accents rather than discarding the word', () => {
    expect(slugify('Café résumé')).toBe('cafe-resume')
    expect(slugify('Añadir señal')).toBe('anadir-senal')
  })

  it('falls back for titles with no representable characters', () => {
    expect(slugify('🚀🔥✨')).toBe(FALLBACK_SLUG)
    expect(slugify('修复登录问题')).toBe(FALLBACK_SLUG)
    expect(slugify('लॉगिन ठीक करें')).toBe(FALLBACK_SLUG)
    expect(slugify('Привет мир')).toBe(FALLBACK_SLUG)
    expect(slugify('   ')).toBe(FALLBACK_SLUG)
  })

  it('keeps the representable part of a mixed-script title', () => {
    expect(slugify('修复 OAuth 登录')).toBe('oauth')
    expect(slugify('Fix 🚀 OAuth')).toBe('fix-oauth')
  })

  it('rejects a nonsensical maxLength', () => {
    expect(() => slugify('Fix OAuth', 0)).toThrow(ValidationError)
    expect(() => slugify('Fix OAuth', 2.5)).toThrow(ValidationError)
  })
})

describe('branchFor', () => {
  const card = { number: 18, title: 'Fix GitHub OAuth' }

  it('produces the canonical branch from SPEC.md §9.2', () => {
    expect(branchFor(card)).toBe('task/18-fix-github-oauth')
    expect(DEFAULT_BRANCH_TEMPLATE).toBe('task/{id}-{slug}')
  })

  it('supports the alternative templates in §9.2', () => {
    expect(branchFor(card, '{user}/{id}-{slug}', { user: 'rahul' })).toBe(
      'rahul/18-fix-github-oauth',
    )
    expect(branchFor(card, 'feat/{id}-{slug}')).toBe('feat/18-fix-github-oauth')
    expect(branchFor({ ...card, column: 'In Progress' }, '{column}/{id}-{slug}')).toBe(
      'in-progress/18-fix-github-oauth',
    )
  })

  it('renders {column} as empty when the card has no column', () => {
    expect(branchFor(card, 'x{column}/{id}')).toBe('x/18')
  })

  it('accepts a literal template with no placeholders', () => {
    expect(branchFor(card, 'spike')).toBe('spike')
  })

  it('produces a typeable branch for an emoji or non-Latin title', () => {
    expect(branchFor({ number: 7, title: '🚀🚀' })).toBe('task/7-card')
    expect(branchFor({ number: 7, title: '修复登录' })).toBe('task/7-card')
  })

  it('keeps a 200-character title inside a sane branch name', () => {
    const branch = branchFor({ number: 18, title: 'Fix the OAuth callback state '.repeat(10) })
    expect(branch.startsWith('task/18-')).toBe(true)
    expect(branch.length).toBeLessThanOrEqual('task/18-'.length + DEFAULT_SLUG_MAX_LENGTH)
    expect(isValidBranchName(branch)).toBe(true)
  })

  it('refuses a card number that is not a positive integer', () => {
    // `task/NaN-...` and `task/undefined-...` are valid Git refs, so nothing
    // downstream would reject them.
    const bad = [Number.NaN, 0, -1, 1.5, undefined] as unknown as number[]
    for (const number of bad) {
      expect(() => branchFor({ number, title: 'Fix OAuth' })).toThrow(ValidationError)
    }
    expect(branchFor({ number: 1, title: 'Fix OAuth' })).toBe('task/1-fix-oauth')
  })

  it('fails loudly on a mistyped placeholder', () => {
    expect(() => branchFor(card, 'task/{brnach}-{slug}')).toThrow(ValidationError)
    expect(() => branchFor(card, 'task/{brnach}-{slug}')).toThrow(/Supported: \{id\}/)
  })

  it('fails when {user} is requested but not supplied', () => {
    expect(() => branchFor(card, '{user}/{id}')).toThrow(/no user was supplied/)
  })

  it('refuses a template that would build an illegal ref', () => {
    expect(() => branchFor(card, 'task/../{slug}')).toThrow(ValidationError)
    expect(() => branchFor(card, '{slug}.lock')).toThrow(ValidationError)
  })
})

describe('isValidBranchName', () => {
  it('accepts ordinary branch names', () => {
    expect(isValidBranchName('task/18-fix-github-oauth')).toBe(true)
    expect(isValidBranchName('main')).toBe(true)
    expect(isValidBranchName('release/v1.0.0')).toBe(true)
  })

  it('rejects names Git would refuse', () => {
    expect(isValidBranchName('')).toBe(false)
    expect(isValidBranchName('a..b')).toBe(false)
    expect(isValidBranchName('a//b')).toBe(false)
    expect(isValidBranchName('a@{b')).toBe(false)
    expect(isValidBranchName('trailing/')).toBe(false)
    expect(isValidBranchName('trailing.')).toBe(false)
    expect(isValidBranchName('branch.lock')).toBe(false)
    expect(isValidBranchName('has space')).toBe(false)
    expect(isValidBranchName('has~tilde')).toBe(false)
    expect(isValidBranchName('has:colon')).toBe(false)
    expect(isValidBranchName('has?question')).toBe(false)
    expect(isValidBranchName('has*star')).toBe(false)
    expect(isValidBranchName('has[bracket')).toBe(false)
    expect(isValidBranchName('has\\backslash')).toBe(false)
    expect(isValidBranchName(`has${DEL}del`)).toBe(false)
    expect(isValidBranchName('/leading')).toBe(false)
    expect(isValidBranchName('.hidden/branch')).toBe(false)
  })
})
