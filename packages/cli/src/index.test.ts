import { describe, expect, it, vi } from 'vitest'
import { run, VERSION } from './index.js'

describe('@yuzie/cli', () => {
  it('exposes a semver-shaped version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('prints the version and exits 0 for --version', () => {
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })

    const code = run(['--version'])
    spy.mockRestore()

    expect(code).toBe(0)
    expect(written.join('')).toBe(`${VERSION}\n`)
  })
})
