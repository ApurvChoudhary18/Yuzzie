/**
 * §18 Session 8: "First paint from warm cache under 400 ms (timed test)."
 *
 * The real binary, as a separate process: a signed-in HOME, a cache holding a
 * 200-card board, and a server that accepts connections and never answers — so
 * anything that waited on the network would blow the budget. Runs in the
 * `bench` task, alone, so nothing else competes for the CPU.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveToken } from '@yuzie/sdk/node'
import { openCache } from '@yuzie/store'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { card, column } from './__tests__/fixtures.js'

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
const BUDGET_MS = 400
const SLUG = 'bench'

let silent: Server
const sockets = new Set<Socket>()
let server = ''

beforeAll(async () => {
  silent = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const address = silent.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  server = `http://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => silent.close(resolve))
})

async function signedInHome(): Promise<{ home: string; cwd: string }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-bench-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-bench-cwd-')))
  await saveToken(server, 'yz_bench_token', { home, keychain: false })

  const cache = openCache({ boardSlug: SLUG, cwd, home, env: {} })
  const columns = [
    column('todo', 'Todo', 0, 'backlog'),
    column('doing', 'Doing', 1, 'in_progress'),
    column('done', 'Done', 2, 'terminal'),
  ]
  const cards = Array.from({ length: 200 }, (_, index) =>
    card(index + 1, {
      column: columns[index % 3]?.key ?? 'todo',
      title: `Cached card ${index + 1}`,
    }),
  )
  cache.transaction(() => {
    cache.columns.putMany(SLUG, columns)
    cache.cards.putMany(SLUG, cards)
    cache.sync.set({ boardSlug: SLUG, lastSeq: 200, syncedAt: Date.now() })
  })
  cache.close()
  return { home, cwd }
}

/** Milliseconds from spawn until the first cached card is on screen. */
async function firstPaint(home: string, cwd: string): Promise<{ ms: number; exit: string }> {
  const started = performance.now()
  const child = spawn(process.execPath, [CLI], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      LANG: 'en_US.UTF-8',
      YUZIE_SERVER: server,
      YUZIE_BOARD: SLUG,
      YUZIE_KEYCHAIN: 'off',
      YUZIE_FORCE_TUI: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const ms = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no paint after 5 s\nstdout: ${stdout}\nstderr: ${stderr}`)),
      5_000,
    )
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.includes('Cached card 1')) {
        clearTimeout(timer)
        resolve(performance.now() - started)
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`exited ${code} before painting\nstdout: ${stdout}\nstderr: ${stderr}`))
    })
  })
  child.removeAllListeners('exit')
  // `close`, not `exit`: the last of stdout can still be in flight at `exit`.
  const exited = new Promise<void>((resolve) => child.on('close', () => resolve()))
  child.kill('SIGTERM')
  await exited
  return { ms, exit: stdout }
}

describe('first paint', () => {
  it(`shows the cached board within ${BUDGET_MS} ms, without waiting on the server`, async () => {
    expect(existsSync(CLI), 'build the CLI first: pnpm --filter @yuzie/cli build').toBe(true)
    const { home, cwd } = await signedInHome()

    // One unmeasured run warms the OS file cache for node and the bundle.
    await firstPaint(home, cwd)
    const runs: number[] = []
    for (let run = 0; run < 5; run += 1) runs.push((await firstPaint(home, cwd)).ms)
    runs.sort((a, b) => a - b)
    const median = runs[2] ?? Number.POSITIVE_INFINITY
    console.log(
      `first paint: median ${median.toFixed(0)} ms (${runs.map((ms) => ms.toFixed(0)).join(', ')})`,
    )
    expect(median).toBeLessThan(BUDGET_MS)
  })

  it('leaves the alternate screen on SIGTERM', async () => {
    const { home, cwd } = await signedInHome()
    const { exit } = await firstPaint(home, cwd)
    expect(exit.slice(0, 8)).toBe('\u001b[?1049h')
    expect(exit.slice(-14)).toBe('\u001b[?25h\u001b[?1049l')
  })
})
