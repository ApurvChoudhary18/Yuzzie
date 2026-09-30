/**
 * Against a server someone else started (SPEC.md §18 Session 17): CI follows
 * docs/self-hosting.md verbatim, then runs this with
 * `YUZIE_E2E_SERVER=http://localhost:8787`. Skipped otherwise — every other
 * suite starts its own server.
 */
import { rmSync } from 'node:fs'
import { createClient } from '@yuzie/sdk'
import { afterAll, describe, expect, it } from 'vitest'
import { machine, repository, yuzie } from './__support__/cli.js'
import { createBoard, signIn, unique } from './__support__/world.js'

const origin = process.env.YUZIE_E2E_SERVER?.replace(/\/+$/, '').replace(/\/v1$/, '')
const baseUrl = `${origin}/v1`
const cleanup: string[] = []

afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(origin === undefined)('a self-hosted server, as the guide leaves it', () => {
  it('is healthy and says which API it speaks', async () => {
    const health = await createClient({ baseUrl }).health()
    expect(health.version).toBe('yuzie/v1')
    const metrics = await fetch(`${origin}/metrics`)
    expect(metrics.status).toBe(200)
  })

  it('two people on one board see each other’s changes live, through the SDK and the CLI', async () => {
    const owner = await signIn(baseUrl, unique('owner'))
    const teammate = await signIn(baseUrl, unique('teammate'))
    const slug = await createBoard(baseUrl, owner, [teammate])

    const theirs = await createClient({ baseUrl, token: teammate.token }).connect(slug)
    const mine = await createClient({ baseUrl, token: owner.token }).connect(slug)
    try {
      const card = await mine.cards.create({ title: 'Fix GitHub OAuth' })
      await expect
        .poll(() => theirs.state.cards[card.number]?.title, { timeout: 5_000 })
        .toBe('Fix GitHub OAuth')

      // The teammate's terminal: the same board, through the built binary.
      const computer = machine(baseUrl)
      const repo = repository()
      cleanup.push(computer.home, repo)
      const env = { ...computer.env, YUZIE_TOKEN: teammate.token, YUZIE_BOARD: slug }
      const listed = await yuzie(['list', '--json'], { cwd: repo, env })
      expect(listed.code).toBe(0)
      expect(listed.stdout).toContain('Fix GitHub OAuth')
      const moved = await yuzie(['move', String(card.number), 'doing'], { cwd: repo, env })
      expect(moved.code).toBe(0)

      await expect
        .poll(() => mine.state.cards[card.number]?.column, { timeout: 5_000 })
        .toBe('doing')
    } finally {
      await theirs.close()
      await mine.close()
    }
  })
})
