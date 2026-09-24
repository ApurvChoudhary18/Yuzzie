import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * Node 24.19 shipped a regression (nodejs/node#65446): any addon built on
 * `node::ObjectWrap` aborts the process with `Assertion failed: (env) != nullptr`
 * when V8 collects one of its objects during ordinary, allocation-driven GC.
 * better-sqlite3 11 and 12 are such addons — a `Statement` going out of scope was
 * enough to kill the CLI on the current LTS. 13 moved to N-API and is immune.
 *
 * This runs exactly that pattern in a child process, so pinning better-sqlite3
 * back to an affected version fails here rather than in a user's terminal. An
 * explicit `gc()` does not trigger the bug; the collection has to come from
 * allocation pressure, which is why the loop allocates junk.
 */
const SCRIPT = `
const Database = require(process.argv[1])
const db = new Database(':memory:')
let junk = []
for (let i = 0; i < 20000; i++) {
  db.prepare('select 1')
  junk.push({ a: i })
  if (junk.length > 1000) junk = []
}
db.close()
process.stdout.write('survived')
`

describe('better-sqlite3 under allocation-driven GC', () => {
  it('lets unreachable statements be collected without aborting the process', () => {
    const modulePath = createRequire(import.meta.url).resolve('better-sqlite3')
    const result = spawnSync(process.execPath, ['-e', SCRIPT, modulePath], { encoding: 'utf8' })

    expect(result.stderr).not.toContain('(env) != nullptr')
    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('survived')
  })
})
