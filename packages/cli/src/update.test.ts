import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from './program.js'
import {
  afterCommand,
  checksAllowed,
  DAY_MS,
  installer,
  isNewer,
  latestVersion,
  readState,
  statePath,
  updateCheck,
  upgradeCommand,
} from './update.js'
import { VERSION } from './version.js'

let registry: Server
let url = ''
let latest = '99.0.0'

beforeAll(async () => {
  registry = createServer((request, response) => {
    if (request.url === '/@yuzie%2Fcli/latest') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ name: '@yuzie/cli', version: latest }))
    } else {
      response.statusCode = 404
      response.end('{}')
    }
  })
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => registry.close(() => resolve())))

const freshHome = () => realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-update-')))

describe('versions (§18 Session 17)', () => {
  it('compares semver, prereleases before their release', () => {
    expect(isNewer('1.2.10', '1.2.9')).toBe(true)
    expect(isNewer('1.2.9', '1.2.10')).toBe(false)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('1.0.0', '1.0.0-rc.1')).toBe(true)
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(false)
    expect(isNewer('garbage', '1.0.0')).toBe(false)
  })

  it('asks the configured registry, and says null when it cannot', async () => {
    expect(await latestVersion({ YUZIE_REGISTRY_URL: url })).toBe(latest)
    expect(await latestVersion({ YUZIE_REGISTRY_URL: `${url}/nowhere` })).toBe(null)
    expect(await latestVersion({ YUZIE_REGISTRY_URL: 'http://127.0.0.1:1' }, 500)).toBe(null)
  })

  it('knows how it was installed', () => {
    expect(installer('/home/a/.npm/_npx/abc/node_modules/yuzie/bin.js')).toBe('npx')
    expect(installer('/home/a/.local/share/pnpm/global/5/node_modules/.pnpm/x/index.js')).toBe(
      'pnpm',
    )
    expect(installer('/home/a/.bun/install/global/node_modules/yuzie/bin.js')).toBe('bun')
    expect(installer('/usr/local/lib/node_modules/@yuzie/cli/dist/index.js')).toBe('npm')
    expect(upgradeCommand('npx')).toBe(null)
    expect(upgradeCommand('npm')).toEqual(['npm', 'install', '--global', '@yuzie/cli@latest'])
  })
})

describe('the daily check and nudge', () => {
  it('stays quiet under CI, --json, --quiet, the env switch and the config switch', () => {
    expect(checksAllowed({}, {})).toBe(true)
    expect(checksAllowed({ CI: 'true' }, {})).toBe(false)
    expect(checksAllowed({ YUZIE_NO_UPDATE_CHECK: '1' }, {})).toBe(false)
    expect(checksAllowed({ NO_UPDATE_NOTIFIER: '1' }, {})).toBe(false)
    expect(checksAllowed({}, { json: true })).toBe(false)
    expect(checksAllowed({}, { quiet: true })).toBe(false)
    expect(checksAllowed({}, { configured: false })).toBe(false)
  })

  it('remembers what the registry said, and nudges at most once a day', async () => {
    const home = freshHome()
    const now = Date.now()
    await updateCheck(home, { YUZIE_REGISTRY_URL: url }, now)
    expect(readState(home)).toMatchObject({ checkedAt: now, latest })

    const launch = { execPath: process.execPath, script: undefined }
    const line = afterCommand(home, {}, launch, now + 1)
    expect(line).toContain(`yuzie ${latest} is available (you have ${VERSION})`)
    expect(afterCommand(home, {}, launch, now + 2)).toBe(null)
    expect(afterCommand(home, {}, launch, now + DAY_MS + 2)).toContain(latest)
  })

  it('says nothing when this is the latest', async () => {
    const home = freshHome()
    latest = VERSION
    try {
      await updateCheck(home, { YUZIE_REGISTRY_URL: url })
      expect(afterCommand(home, {}, { execPath: process.execPath, script: undefined })).toBe(null)
    } finally {
      latest = '99.0.0'
    }
  })

  it('`yuzie __update-check` writes the state and prints nothing', async () => {
    const home = freshHome()
    const stdout = new PassThrough()
    let text = ''
    stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString()
    })
    const code = await run(['__update-check'], {
      stdout,
      stderr: stdout,
      stdin: new PassThrough(),
      env: { HOME: home, YUZIE_REGISTRY_URL: url },
      cwd: home,
    })
    expect(code).toBe(0)
    expect(text).toBe('')
    expect(JSON.parse(readFileSync(statePath(home), 'utf8')).latest).toBe(latest)
  })
})

describe('yuzie upgrade', () => {
  it('--dry-run says what it would run, and runs nothing', async () => {
    const home = freshHome()
    const stdout = new PassThrough()
    let text = ''
    stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString()
    })
    const code = await run(['upgrade', '--dry-run', '--json'], {
      stdout,
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env: { HOME: home, YUZIE_REGISTRY_URL: url, NO_COLOR: '1' },
      cwd: home,
    })
    expect(code).toBe(0)
    const result = JSON.parse(text).data
    expect(result).toMatchObject({ current: VERSION, latest, upToDate: false, upgraded: false })
  })
})
