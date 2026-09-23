import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUNDLE_DIR, buildRunnableBundle, removeRunnableBundle } from './__tests__/bundle.js'
import { openJsonCache } from './json-driver.js'
import { openSqliteCache } from './sqlite-driver.js'
import type { CacheDriverKind, YuzieCache } from './types.js'

const BOARD = 'payments-api'
const BASELINE = 200

/**
 * Commits a baseline, then starts a much larger write and kills itself before it
 * can commit. Written as plain JS because it runs under bare `node`.
 */
const CRASH_SCRIPT = `
import { openCache } from './index.js'

const [, , driver, file] = process.argv
const BOARD = ${JSON.stringify(BOARD)}
const BASELINE = ${BASELINE}

function card(n) {
  return {
    id: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'),
    boardId: '11111111-1111-4111-8111-111111111111',
    number: n,
    column: 'doing',
    rank: 'V',
    title: 'Card ' + n,
    description: null,
    priority: null,
    dueAt: null,
    assignees: [],
    labels: [],
    watchers: [],
    checklist: [],
    comments: [],
    commits: [],
    git: null,
    anchor: null,
    createdBy: 'rahul',
    archivedAt: null,
    createdAt: '2026-08-19T09:00:00Z',
    updatedAt: '2026-08-19T09:00:00Z',
    version: 1,
  }
}

const cache = openCache({ boardSlug: BOARD, location: file, driver })

cache.transaction(() => {
  for (let i = 1; i <= BASELINE; i += 1) cache.cards.put(BOARD, card(i))
})

// This one never commits.
cache.transaction(() => {
  for (let i = BASELINE + 1; i <= BASELINE + 5000; i += 1) {
    cache.cards.put(BOARD, card(i))
    if (i === BASELINE + 1500) process.kill(process.pid, 'SIGKILL')
  }
})
`

const OPENERS: Record<CacheDriverKind, (location: string) => YuzieCache> = {
  sqlite: (location) => openSqliteCache({ location }),
  json: (location) => openJsonCache({ location }),
}

describe('a process killed mid-write', () => {
  let workspace: string
  let scriptPath: string

  beforeAll(() => {
    buildRunnableBundle()
    scriptPath = join(BUNDLE_DIR, 'crash.mjs')
    writeFileSync(scriptPath, CRASH_SCRIPT, 'utf8')
    workspace = mkdtempSync(join(tmpdir(), 'yuzie-crash-'))
  })

  afterAll(() => {
    removeRunnableBundle()
    rmSync(workspace, { recursive: true, force: true })
  })

  for (const kind of ['sqlite', 'json'] as const) {
    it(`leaves the ${kind} cache readable and at its last committed state`, () => {
      const file = join(workspace, `${kind}.db`)

      const result = spawnSync(process.execPath, [scriptPath, kind, file], { encoding: 'utf8' })

      // The child must actually have been killed, not have exited cleanly —
      // otherwise the test proves nothing.
      expect(result.signal).toBe('SIGKILL')

      const reopened = OPENERS[kind](file)
      try {
        // Readable at all is the first half of the requirement.
        expect(reopened.cards.count(BOARD)).toBe(BASELINE)
        // And the committed data is intact, not truncated.
        expect(reopened.cards.get(BOARD, 1)?.title).toBe('Card 1')
        expect(reopened.cards.get(BOARD, BASELINE)?.title).toBe(`Card ${BASELINE}`)
        // Nothing from the uncommitted transaction survived.
        expect(reopened.cards.get(BOARD, BASELINE + 1)).toBeUndefined()
      } finally {
        reopened.close()
      }
    })
  }
})
