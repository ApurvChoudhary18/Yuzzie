/**
 * §10.4 / §18 Session 16: the board on a 500-card board stays under 120 MB of
 * resident memory — the real binary, synced from a server, sampled with `ps`
 * for a few seconds after it has drawn. Runs in the `bench` task, alone.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openCache } from '@yuzie/store'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  benchDirectories,
  benchEnv,
  COLUMNS,
  makeCards,
  SLUG,
  startStub,
} from '../../bench/stub-server.mjs'

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
const BUDGET_MB = 120
const CARDS = 500

let stub: { baseUrl: string; close(): Promise<void> }

beforeAll(async () => {
  stub = await startStub({ cards: CARDS })
})

afterAll(async () => {
  await stub?.close()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resident set size of `pid`, in MB. */
function rssMb(pid: number): number {
  const kb = Number(
    execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
  )
  return kb / 1024
}

describe(`memory on a ${CARDS}-card board`, () => {
  it(`stays under ${BUDGET_MB} MB resident`, async () => {
    expect(existsSync(CLI), 'build the CLI first: pnpm --filter @yuzie/cli build').toBe(true)
    const { home, cwd } = benchDirectories()
    // The board in the local cache, as after any sync: all 500 cards in memory.
    const cache = openCache({ boardSlug: SLUG, cwd, home, env: {} })
    cache.transaction(() => {
      cache.columns.putMany(SLUG, COLUMNS)
      cache.cards.putMany(SLUG, makeCards(CARDS))
      cache.sync.set({ boardSlug: SLUG, lastSeq: CARDS, syncedAt: Date.now() })
    })
    cache.close()
    const child = spawn(process.execPath, [CLI], {
      cwd,
      env: {
        ...benchEnv(stub.baseUrl, home),
        LANG: 'en_US.UTF-8',
        YUZIE_FORCE_TUI: '1',
        COLUMNS: '160',
        LINES: '50',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    try {
      // The board is drawn, then Ink has taken over (it repaints the same card).
      const deadline = Date.now() + 15_000
      while (stdout.split('Card 1:').length < 3) {
        if (Date.now() > deadline || child.exitCode !== null)
          throw new Error(`the board never drew\nstderr: ${stderr}`)
        await sleep(50)
      }
      const samples: number[] = []
      for (let index = 0; index < 20; index += 1) {
        await sleep(150)
        samples.push(rssMb(child.pid as number))
      }
      const peak = Math.max(...samples)
      console.log(
        `TUI on ${CARDS} cards: peak ${peak.toFixed(1)} MB resident (budget ${BUDGET_MB} MB)`,
      )
      expect(peak).toBeLessThan(BUDGET_MB)
    } finally {
      const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
      child.kill('SIGTERM')
      await closed
    }
  }, 60_000)
})
