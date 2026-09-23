import { describe, expect, it } from 'vitest'
import { BASE_DELAY_MS, backoffDelayMs, MAX_DELAY_MS } from './backoff.js'

describe('backoffDelayMs', () => {
  it('does not delay before the first attempt', () => {
    expect(backoffDelayMs(0)).toBe(0)
    expect(backoffDelayMs(-1)).toBe(0)
  })

  it('follows the 0.5s doubling curve from §12.2', () => {
    // Jitter at its maximum gives the nominal delay.
    expect(backoffDelayMs(1, 1)).toBe(BASE_DELAY_MS)
    expect(backoffDelayMs(2, 1)).toBe(BASE_DELAY_MS * 2)
    expect(backoffDelayMs(3, 1)).toBe(BASE_DELAY_MS * 4)
    expect(backoffDelayMs(4, 1)).toBe(BASE_DELAY_MS * 8)
  })

  it('caps the delay so a long outage does not park a write for hours', () => {
    expect(backoffDelayMs(20, 1)).toBe(MAX_DELAY_MS)
    expect(backoffDelayMs(100, 1)).toBe(MAX_DELAY_MS)
  })

  it('jitters within the bottom half of the window', () => {
    for (const attempts of [1, 2, 5, 12]) {
      const nominal = backoffDelayMs(attempts, 1)
      expect(backoffDelayMs(attempts, 0)).toBe(Math.round(nominal / 2))
      for (const jitter of [0, 0.25, 0.5, 0.75, 1]) {
        const delay = backoffDelayMs(attempts, jitter)
        expect(delay).toBeGreaterThanOrEqual(Math.round(nominal / 2))
        expect(delay).toBeLessThanOrEqual(nominal)
      }
    }
  })

  it('never shrinks as attempts grow', () => {
    let previous = 0
    for (let attempts = 1; attempts <= 12; attempts += 1) {
      const delay = backoffDelayMs(attempts, 1)
      expect(delay).toBeGreaterThanOrEqual(previous)
      previous = delay
    }
  })
})
