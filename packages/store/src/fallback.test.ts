import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUNDLE_ENTRY } from './__tests__/bundle.js'

/**
 * SPEC.md §20 lists "better-sqlite3 native build failures break npx" as a
 * high-impact risk, mitigated by "optional dependency + JSON fallback driver".
 *
 * The conformance suite proves the JSON driver *works*; it does not prove the
 * fallback ever *engages*. Deciding that requires a process where the native
 * module genuinely cannot be resolved, so this test builds one: the package is
 * copied somewhere `require('better-sqlite3')` must fail, and a child process
 * is asked which driver it chose.
 */
describe('when better-sqlite3 cannot be resolved', () => {
  let workspace: string

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'yuzie-nosqlite-'))

    // @yuzie/core must still resolve; better-sqlite3 must not.
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    mkdirSync(join(workspace, 'node_modules', '@yuzie'), { recursive: true })
    symlinkSync(
      join(packageRoot, '..', 'core'),
      join(workspace, 'node_modules', '@yuzie', 'core'),
      'dir',
    )
    cpSync(BUNDLE_ENTRY, join(workspace, 'store.js'))
    writeFileSync(join(workspace, 'package.json'), '{"type":"module"}', 'utf8')
  })

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('reports SQLite as unavailable and falls back to JSON, still working', () => {
    const script = `
      import { openCache, isSqliteAvailable, defaultDriverKind, openSqliteCache, SqliteUnavailableError } from './store.js'

      const card = {
        id: '11111111-1111-4111-8111-111111111111',
        boardId: '22222222-2222-4222-8222-222222222222',
        number: 18, column: 'doing', rank: 'V', title: 'Fix GitHub OAuth',
        description: null, priority: null, dueAt: null,
        assignees: [], labels: [], watchers: [], checklist: [], comments: [], commits: [],
        git: null, anchor: null, createdBy: null, archivedAt: null,
        createdAt: '2026-08-19T09:00:00Z', updatedAt: '2026-08-19T09:00:00Z', version: 1,
      }

      const cache = openCache({ boardSlug: 'payments-api', location: ':memory:', driver: 'auto' })
      cache.cards.put('payments-api', card)
      cache.outbox.enqueue('payments-api', { method: 'POST', path: '/x', idempotencyKey: 'k1' })

      let explicitError = null
      try {
        openSqliteCache({ location: ':memory:' })
      } catch (error) {
        explicitError = { name: error.name, isTyped: error instanceof SqliteUnavailableError, message: error.message }
      }

      const { createRequire } = await import('node:module')
      const req = createRequire(import.meta.url)
      let resolvedFrom = null
      try { resolvedFrom = req.resolve('better-sqlite3') } catch (e) { resolvedFrom = 'UNRESOLVABLE:' + e.code }

      console.log(JSON.stringify({
        resolvedFrom,
        scriptUrl: import.meta.url,
        available: isSqliteAvailable(),
        defaultKind: defaultDriverKind(),
        chosen: cache.kind,
        readBack: cache.cards.get('payments-api', 18)?.title,
        outboxSize: cache.outbox.size(),
        explicitError,
      }))
      cache.close()
    `
    writeFileSync(join(workspace, 'probe.mjs'), script, 'utf8')

    // pnpm exports NODE_PATH when it runs a script, which would let the child
    // resolve the repo's own store and defeat the whole point of this test. A
    // real `npx yuzie` has no such variable, so neither does the child.
    const { NODE_PATH: _ignored, NODE_OPTIONS: _alsoIgnored, ...env } = process.env

    const output = execFileSync(process.execPath, [join(workspace, 'probe.mjs')], {
      cwd: workspace,
      encoding: 'utf8',
      env,
    })
    const result = JSON.parse(output.trim()) as {
      resolvedFrom: string
      scriptUrl: string
      available: boolean
      defaultKind: string
      chosen: string
      readBack: string
      outboxSize: number
      explicitError: { name: string; isTyped: boolean; message: string } | null
    }

    // Guard the guard: if this ever resolves, the test is no longer testing
    // anything and would pass for the wrong reason.
    expect(result.resolvedFrom).toMatch(/^UNRESOLVABLE:/)
    expect(result.available).toBe(false)
    expect(result.defaultKind).toBe('json')
    // The point of the whole exercise: `npx yuzie` still gets a working cache.
    expect(result.chosen).toBe('json')
    expect(result.readBack).toBe('Fix GitHub OAuth')
    expect(result.outboxSize).toBe(1)

    // Asking for SQLite explicitly still fails, and fails with a typed error
    // that names the fallback rather than a bare MODULE_NOT_FOUND.
    expect(result.explicitError?.isTyped).toBe(true)
    expect(result.explicitError?.name).toBe('SqliteUnavailableError')
    expect(result.explicitError?.message).toContain('JSON cache driver')
  })
})
