import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from './index.js'

describe('@yuzie/core', () => {
  it('identifies itself so the build pipeline is genuinely exercised', () => {
    expect(PACKAGE_NAME).toBe('@yuzie/core')
  })
})
