import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { commandPaths, commandReference, helpText } from './reference.js'

const DOC = new URL('../../../docs/commands.md', import.meta.url)

describe('the command reference (§18 Session 17)', () => {
  it('docs/commands.md is exactly what --help prints', async () => {
    const generated = await commandReference()
    // `pnpm --filter @yuzie/cli docs` regenerates it.
    if (process.env.YUZIE_UPDATE_DOCS === '1') writeFileSync(DOC, generated)
    expect(readFileSync(DOC, 'utf8')).toBe(generated)
  })

  it('covers every visible command, and no hidden ones', async () => {
    const names = commandPaths().map((path) => path.join(' '))
    expect(names).toEqual(
      expect.arrayContaining(['', 'list', 'move', 'token create', 'completion', 'upgrade']),
    )
    expect(names.some((name) => name.startsWith('__'))).toBe(false)
    expect(await helpText(['upgrade'])).toContain('--dry-run')
  })
})
