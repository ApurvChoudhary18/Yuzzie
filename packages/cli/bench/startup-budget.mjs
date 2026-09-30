/**
 * SPEC.md §10.4 / §18 Session 16: `yuzie list --json` starts, reads a warm
 * cache, asks the server and prints — p50 under 150 ms, measured by hyperfine.
 *
 *   node bench/startup-budget.mjs            # fails without hyperfine
 *   node bench/startup-budget.mjs --timer    # no hyperfine: time it here
 *
 * The server is a stub in its own process that answers instantly, so this
 * measures the CLI, not a network.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { benchDirectories, benchEnv } from './stub-server.mjs'

// §10.4's budget, for the machine a person uses. CI runners run our code ~1.7×
// slower than a current laptop, so the CI workflow sets its own guard with
// YUZIE_STARTUP_BUDGET_MS (see .github/workflows/ci.yml).
const BUDGET_MS = Number(process.env.YUZIE_STARTUP_BUDGET_MS ?? 150)
const RUNS = 30
const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'dist', 'index.js')

const server = spawn(process.execPath, [join(here, 'serve-stub.mjs'), '200'], {
  stdio: ['ignore', 'pipe', 'inherit'],
})
const baseUrl = await new Promise((resolve, reject) => {
  server.stdout.once('data', (chunk) => resolve(chunk.toString().trim()))
  server.once('exit', (code) => reject(new Error(`stub exited ${code}`)))
})

try {
  const { home, cwd } = benchDirectories()
  const env = { ...benchEnv(baseUrl, home) }
  // Warm the cache, and prove the command works before timing it.
  const warm = spawnSync(process.execPath, [cli, 'list', '--json'], { cwd, env, encoding: 'utf8' })
  const count = JSON.parse(warm.stdout).meta.count
  if (warm.status !== 0 || count !== 200)
    throw new Error(`warm-up failed (exit ${warm.status}, ${count} cards): ${warm.stderr}`)

  let p50
  const useTimer = process.argv.includes('--timer')
  if (useTimer) {
    const times = []
    for (let run = 0; run < RUNS; run += 1) {
      const started = performance.now()
      spawnSync(process.execPath, [cli, 'list', '--json'], { cwd, env, stdio: 'ignore' })
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    p50 = times[Math.floor(RUNS / 2)]
  } else {
    const out = join(realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-hyperfine-'))), 'result.json')
    execFileSync(
      'hyperfine',
      [
        '--warmup',
        '3',
        '--runs',
        String(RUNS),
        '--export-json',
        out,
        '--style',
        'basic',
        `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} list --json`,
      ],
      { cwd, env: { ...env, PATH: process.env.PATH }, stdio: ['ignore', 'inherit', 'inherit'] },
    )
    p50 = JSON.parse(readFileSync(out, 'utf8')).results[0].median * 1000
  }
  // Where the time goes, so a failure on a machine we cannot profile says why.
  const median = (args) => {
    const times = []
    for (let run = 0; run < 11; run += 1) {
      const started = performance.now()
      spawnSync(process.execPath, args, { cwd, env, stdio: 'ignore' })
      times.push(performance.now() - started)
    }
    return times.sort((a, b) => a - b)[5].toFixed(1)
  }
  const cache = spawnSync(
    process.execPath,
    [
      '-e',
      "const m = require('node:module'); const r = m.enableCompileCache?.(); console.log(JSON.stringify({ status: r?.status, directory: r?.directory ?? m.getCompileCacheDir?.() }))",
    ],
    { encoding: 'utf8' },
  ).stdout.trim()
  console.log(
    [
      `breakdown (median of 11, spawned from node): node -e 0 ${median(['-e', '0'])} ms`,
      `--version ${median([cli, '--version'])} ms`,
      `list --json --offline ${median([cli, 'list', '--json', '--offline'])} ms`,
      `list --json ${median([cli, 'list', '--json'])} ms`,
      `compile cache ${cache}`,
    ].join(' · '),
  )
  console.log(`yuzie list --json: p50 ${p50.toFixed(1)} ms (budget ${BUDGET_MS} ms)`)
  if (p50 >= BUDGET_MS) {
    console.error(`over budget by ${(p50 - BUDGET_MS).toFixed(1)} ms`)
    process.exitCode = 1
  }
} finally {
  server.kill('SIGTERM')
}
