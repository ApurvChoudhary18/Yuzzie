import { describe, expect, it } from 'vitest'
import { newId } from './ids.js'

describe('newId', () => {
  it('returns a v4 UUID', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 1000 }, newId))
    expect(ids.size).toBe(1000)
  })
})
