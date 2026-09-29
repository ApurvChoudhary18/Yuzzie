/**
 * The client log, redaction, and `yuzie doctor --bundle` (SPEC.md §15,
 * §18 Session 16).
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger, logPath, tailLog } from './log.js'
import { run } from './program.js'
import { REDACTED, redact, redactValue } from './redact.js'

const TOKEN = 'yz_2f8a0c1d9e7b4a6f5c3e1d0b9a8f7e6d'

describe('redaction', () => {
  it('hides tokens, bearer headers, URL passwords and secret-named fields', () => {
    expect(redact(`token ${TOKEN} used`)).toBe(`token yz_${REDACTED} used`)
    expect(redact('Authorization: Bearer abcdefghijklmnop')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    )
    expect(redact('postgres://yuzie:hunter2@db:5432/yuzie')).toBe(
      `postgres://yuzie:${REDACTED}@db:5432/yuzie`,
    )
    expect(redact('GITHUB_TOKEN=ghp_abc123 password: "s3cret"')).toBe(
      `GITHUB_TOKEN=${REDACTED} password: "${REDACTED}"`,
    )
    expect(redact('nothing to see', '/Users/rahul')).toBe('nothing to see')
  })

  it('replaces the home directory with ~', () => {
    expect(redact('/Users/rahul/code/api/.yuzie/cache', '/Users/rahul')).toBe(
      '~/code/api/.yuzie/cache',
    )
  })

  it('walks objects: secret-named keys are hidden whatever their value', () => {
    expect(
      redactValue(
        { YUZIE_TOKEN: 'anything', nested: { apiKey: 42, note: `see ${TOKEN}` }, list: ['a'] },
        '/h',
      ),
    ).toEqual({
      YUZIE_TOKEN: REDACTED,
      nested: { apiKey: REDACTED, note: `see yz_${REDACTED}` },
      list: ['a'],
    })
  })
})

describe('the client log', () => {
  const home = () => realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-log-')))

  it('writes redacted JSON lines under ~/.yuzie/logs', () => {
    const dir = home()
    createLogger(dir, {}).log('info', 'command', { argv: ['login', TOKEN], cwd: `${dir}/repo` })
    const [line] = readFileSync(logPath(dir), 'utf8').trim().split('\n')
    const entry = JSON.parse(line ?? '{}')
    expect(entry).toMatchObject({ level: 'info', message: 'command', cwd: '~/repo' })
    expect(line).not.toContain(TOKEN)
    expect(statSync(logPath(dir)).mode & 0o777).toBe(0o600)
  })

  it('rotates at its size limit and keeps a bounded number of files', () => {
    const dir = home()
    const logger = createLogger(dir, {}, { maxBytes: 400, keep: 2 })
    for (let index = 0; index < 40; index += 1) logger.log('info', `line ${index}`)
    expect(statSync(logPath(dir)).size).toBeLessThanOrEqual(400)
    expect(existsSync(`${logPath(dir)}.1`)).toBe(true)
    expect(existsSync(`${logPath(dir)}.2`)).toBe(true)
    expect(existsSync(`${logPath(dir)}.3`)).toBe(false)
    // The tail reaches back into the rotated file.
    const tail = tailLog(dir, 5).map((line) => JSON.parse(line).message)
    expect(tail).toEqual(['line 35', 'line 36', 'line 37', 'line 38', 'line 39'])
  })

  it('is off with YUZIE_LOG=off, and never throws when it cannot write', () => {
    const dir = home()
    createLogger(dir, { YUZIE_LOG: 'off' }).log('info', 'nothing')
    expect(existsSync(logPath(dir))).toBe(false)
    expect(() => createLogger('/dev/null/not-a-dir', {}).log('info', 'x')).not.toThrow()
  })
})

describe('yuzie doctor --bundle', () => {
  it('writes versions, checks, config, env and the log tail — without secrets', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-bundle-')))
    const env = {
      HOME: dir,
      YUZIE_SERVER: 'http://127.0.0.1:9/v1',
      YUZIE_TOKEN: TOKEN,
      YUZIE_KEYCHAIN: 'off',
      NO_COLOR: '1',
      PATH: process.env.PATH,
    }
    createLogger(dir, env).log('error', 'failed', { error: `bad token ${TOKEN}` })
    const stdout = new PassThrough()
    let printed = ''
    stdout.on('data', (chunk: Buffer) => {
      printed += chunk.toString()
    })
    const code = await run(['doctor', '--offline', '--bundle', 'report.json', '--json'], {
      stdout,
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env,
      cwd: dir,
    })
    expect(code).toBe(0)
    const document = JSON.parse(printed)
    expect(document.data.bundle).toBe(join(dir, 'report.json'))
    const text = readFileSync(join(dir, 'report.json'), 'utf8')
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(dir)
    const bundle = JSON.parse(text)
    expect(bundle).toMatchObject({
      node: process.versions.node,
      environment: { YUZIE_TOKEN: REDACTED, YUZIE_SERVER: 'http://127.0.0.1:9/v1' },
      git: { repository: false },
    })
    expect(bundle.checks.map((check: { name: string }) => check.name)).toContain('node')
    expect(bundle.log.some((line: string) => line.includes('"failed"'))).toBe(true)
    expect(statSync(join(dir, 'report.json')).mode & 0o777).toBe(0o600)
  })
})
