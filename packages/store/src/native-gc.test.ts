import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * Node 24.19 shipped a regression (nodejs/node#65446): a native object wrapped
 * with `node::ObjectWrap` could abort the process with
 * `Assertion failed: (env) != nullptr` when V8 collected it during ordinary,
 * allocation-driven GC. That killed the CLI on the LTS when the cache used a
 * native SQLite addon.
 *
 * The cache now uses Node's own `node:sqlite`, whose statements are native
 * objects too. This runs the same pattern in a child process, so a Node that
 * regresses the same way fails here rather than in a user's terminal. An
 * explicit `gc()` does not trigger the bug; the collection has to come from
 * allocation pressure, which is why the loop allocates junk.
 */
const SCRIPT = `
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(':memory:')
let junk = []
for (let i = 0; i < 20000; i++) {
  db.prepare('select 1')
  junk.push({ a: i })
  if (junk.length > 1000) junk = []
}
db.close()
process.stdout.write('survived')
`

describe('node:sqlite under allocation-driven GC', () => {
  it('lets unreachable statements be collected without aborting the process', () => {
    const result = spawnSync(process.execPath, ['--no-warnings', '-e', SCRIPT], {
      encoding: 'utf8',
    })

    expect(result.stderr).not.toContain('(env) != nullptr')
    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('survived')
  })
})
