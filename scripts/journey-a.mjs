#!/usr/bin/env node
/**
 * Journey A (SPEC.md §6.1) on a machine that has only Node and git — the
 * release acceptance of §18 Session 17. No workspace, no test runner: this
 * file is copied into a clean container and run there.
 *
 *   node journey-a.mjs --server http://localhost:8787 [--yuzie "npx --yes yuzie@latest"]
 *
 * It signs in through `yuzie init` (approving the device code the way the
 * server's page would), then adds a card, lists it and claims it, and checks
 * each step for real: on disk, in git, and on the server.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    server: { type: 'string', default: 'http://localhost:8787' },
    yuzie: { type: 'string', default: 'yuzie' },
  },
})
const origin = values.server.replace(/\/+$/, '').replace(/\/v1$/, '')
const api = `${origin}/v1`
const [command, ...prefix] = values.yuzie.split(/\s+/).filter(Boolean)
// Board names are unique per server, so a second run gets a repository of its own.
const run = Date.now().toString(36)
const name = `payments-api-${run}`

const home = realpathSync(mkdtempSync(join(tmpdir(), 'journey-home-')))
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'journey-repo-')))
const env = {
  PATH: process.env.PATH,
  HOME: home,
  // npx needs somewhere to cache what it fetches, and the registry to fetch from.
  npm_config_cache: join(home, '.npm'),
  ...(process.env.npm_config_registry
    ? { npm_config_registry: process.env.npm_config_registry }
    : {}),
  YUZIE_SERVER: api,
  YUZIE_KEYCHAIN: 'off',
  YUZIE_NO_BROWSER: '1',
  NO_COLOR: '1',
  LANG: 'en_US.UTF-8',
}

function step(name) {
  process.stdout.write(`• ${name}\n`)
}

function fail(message, detail = '') {
  process.stderr.write(`✗ ${message}\n${detail}\n`)
  process.exit(1)
}

function check(condition, message, detail) {
  if (!condition) fail(message, detail)
}

/** Run `yuzie …args`, feeding `input`; `onOutput` sees stdout+stderr as it grows. */
function yuzie(args, { input = '', onOutput } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, [...prefix, ...args], { cwd: repo, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      onOutput?.(stdout + stderr)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      onOutput?.(stdout + stderr)
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
git('init', '-b', 'main')
git('config', 'user.email', 'rahul@acme.dev')
git('config', 'user.name', 'Rahul')
git('remote', 'add', 'origin', `git@github.com:acme/${name}.git`)
git('commit', '--allow-empty', '-m', 'Initial commit')

step(`server ${origin}`)
const health = await fetch(`${origin}/healthz`).catch((error) => fail('server unreachable', error))
check(health.ok, `GET /healthz answered ${health.status}`)

step(`${values.yuzie} init`)
let approved = false
const init = await yuzie(['init'], {
  // Sign in? yes. Board name and columns: the defaults.
  input: 'y\n\n\n',
  onOutput: (text) => {
    const code = /Code: (\S+)/.exec(text)?.[1]
    if (code === undefined || approved) return
    approved = true
    // What the person does in their browser: approve the code as @rahul.
    fetch(`${api}/auth/device/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userCode: code, handle: `rahul-${run}` }),
    }).then((response) => check(response.ok, `approving the code answered ${response.status}`))
  },
})
check(init.code === 0, `init exited ${init.code}`, init.stdout + init.stderr)
for (const line of [
  `✓ Git repository detected: ${name} (github.com/acme/${name})`,
  '✓ Default branch: main',
  `✓ Board "${name}" created`,
  '✓ Wrote .yuzie/config.json',
  '✓ Added .yuzie/cache/ to .gitignore',
  '✓ Installed git hooks (post-commit, post-checkout)',
  'Next: yuzie add "Fix GitHub OAuth"',
]) {
  check(init.stdout.includes(line), `init did not print: ${line}`, init.stdout)
}
check(/✓ Signed in as @rahul-/.test(init.stdout), 'init did not sign in', init.stdout)
const config = JSON.parse(readFileSync(join(repo, '.yuzie', 'config.json'), 'utf8'))
check(config.board === name && config.server === api, 'config.json is wrong', config)
check(
  (statSync(join(home, '.yuzie', 'credentials')).mode & 0o777) === 0o600,
  'credentials are not 0600',
)

// The team shares the board through the repository: commit what init wrote.
git('add', '.gitignore', '.yuzie/config.json')
git('commit', '-m', 'Track work on Yuzie')

step(`${values.yuzie} add "Fix GitHub OAuth"`)
const add = await yuzie(['add', 'Fix GitHub OAuth', '--json'])
check(add.code === 0, `add exited ${add.code}`, add.stdout + add.stderr)
const number = JSON.parse(add.stdout).data.number
check(Number.isInteger(number) && number > 0, 'add returned no card number', add.stdout)

step(`${values.yuzie} list --json`)
const list = await yuzie(['list', '--json'])
check(list.code === 0, `list exited ${list.code}`, list.stdout + list.stderr)
check(
  JSON.stringify(JSON.parse(list.stdout).data).includes('Fix GitHub OAuth'),
  'list does not show the card',
  list.stdout,
)

step(`${values.yuzie} claim ${number}`)
const claim = await yuzie(['claim', String(number)])
check(claim.code === 0, `claim exited ${claim.code}`, claim.stdout + claim.stderr)
const branch = git('branch', '--show-current')
check(branch === `task/${number}-fix-github-oauth`, `claim left git on ${branch}`)

process.stdout.write(`✓ Journey A passed against ${origin}\n`)
