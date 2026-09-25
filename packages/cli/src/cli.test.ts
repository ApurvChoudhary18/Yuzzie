import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { AuthenticationError, NotFoundError } from '@yuzie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getPath, loadConfig, parseValue, setPath } from './config.js'
import { exitCodeFor, UsageError } from './exit.js'
import { colorEnabled, Output, type Stream } from './output.js'
import { run } from './program.js'
import { Prompter } from './prompt.js'
import { VERSION } from './version.js'

function capture(isTTY = false): Stream & { text: string } {
  const stream = {
    text: '',
    isTTY,
    write(chunk: string) {
      stream.text += chunk
      return true
    },
  }
  return stream
}

function output(options: Partial<{ json: boolean; quiet: boolean; color: boolean }> = {}) {
  const stdout = capture()
  const stderr = capture()
  const out = new Output({
    json: options.json ?? false,
    color: options.color ?? false,
    quiet: options.quiet ?? false,
    verbose: false,
    stdout,
    stderr,
    interactive: false,
  })
  return { out, stdout, stderr }
}

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-cli-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('exit codes (§7.4)', () => {
  it('come from the error class, in one place', () => {
    expect(exitCodeFor(new AuthenticationError('unauthenticated', 'x'))).toBe(3)
    expect(exitCodeFor(new NotFoundError('card_not_found', 'x'))).toBe(4)
    expect(exitCodeFor(new UsageError('x'))).toBe(2)
    expect(exitCodeFor(new Error('a bug'))).toBe(1)
  })
})

describe('colour (§7.1)', () => {
  const tty = capture(true)
  it('is on for a terminal, off for pipes, NO_COLOR, and --no-color', () => {
    expect(colorEnabled(undefined, {}, tty)).toBe(true)
    expect(colorEnabled(undefined, {}, capture(false))).toBe(false)
    expect(colorEnabled(undefined, { NO_COLOR: '1' }, tty)).toBe(false)
    expect(colorEnabled(false, {}, tty)).toBe(false)
    expect(colorEnabled(undefined, { FORCE_COLOR: '1' }, capture(false))).toBe(true)
  })
})

describe('Output', () => {
  it('prints human lines with symbols, and nothing under --quiet except errors', () => {
    const human = output()
    human.out.success('done')
    human.out.warn('careful')
    human.out.step('going')
    expect(human.stdout.text).toBe('✓ done\n⚠ careful\n→ going\n')

    const quiet = output({ quiet: true })
    quiet.out.success('hidden')
    quiet.out.error(new UsageError('shown'))
    expect(quiet.stdout.text).toBe('')
    expect(quiet.stderr.text).toContain('shown')
  })

  it('under --json prints one document and nothing else', () => {
    const { out, stdout, stderr } = output({ json: true })
    out.success('not printed')
    out.line('nor this')
    out.prompt('? nor this ')
    out.notice('a login code')
    out.result('Whoami', { handle: 'rahul' }, { board: 'b' })
    expect(JSON.parse(stdout.text)).toEqual({
      apiVersion: 'yuzie/v1',
      kind: 'Whoami',
      data: { handle: 'rahul' },
      meta: { board: 'b' },
    })
    expect(stderr.text).toBe('a login code\n')
  })

  it('reports errors as one line with the fix, or as an Error document', () => {
    const human = output()
    human.out.error(new NotFoundError('card_not_found', 'Card #9 does not exist'))
    expect(human.stderr.text).toBe('✗ Card #9 does not exist Run `yuzie list` to see card ids.\n')

    const json = output({ json: true })
    json.out.error(new NotFoundError('card_not_found', 'Card #9 does not exist'))
    expect(JSON.parse(json.stdout.text)).toMatchObject({
      kind: 'Error',
      error: { code: 'card_not_found', exitCode: 4, fix: 'Run `yuzie list` to see card ids.' },
    })
  })

  it('colours only when asked', () => {
    const coloured = output({ color: true })
    coloured.out.success('x')
    expect(coloured.stdout.text).toBe('\u001b[32m✓\u001b[39m x\n')
  })
})

describe('Prompter', () => {
  function piped(text: string) {
    const input = new PassThrough()
    input.end(text)
    return Object.assign(input, { isTTY: false })
  }

  it('reads piped answers in order, echoes them, and takes defaults on empty lines', async () => {
    const { out, stdout } = output()
    const prompter = new Prompter(out, piped('n\n\nLedger\n'), false)
    expect(await prompter.confirm('Sign in?')).toBe(false)
    expect(await prompter.ask('Board name:', 'payments-api')).toBe('payments-api')
    expect(await prompter.ask('Columns:', 'Todo')).toBe('Ledger')
    // End of input: the default.
    expect(await prompter.ask('More?', 'none')).toBe('none')
    prompter.close()
    expect(stdout.text).toBe(
      '? Sign in? (Y/n) n\n? Board name: (payments-api) \n? Columns: (Todo) Ledger\n? More? (none) \n',
    )
  })

  it('asks nothing under --yes/--json', async () => {
    const { out, stdout } = output()
    const prompter = new Prompter(out, piped('no\n'), true)
    expect(await prompter.confirm('Sure?')).toBe(true)
    expect(await prompter.ask('Name:', 'x')).toBe('x')
    expect(stdout.text).toBe('')
  })
})

describe('config (§13.2)', () => {
  const home = () => join(dir, 'home')
  const repo = () => join(dir, 'repo')

  function write(path: string, value: unknown) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(value))
  }

  it('layers defaults < user < repo < env < flag', async () => {
    write(join(home(), '.yuzie', 'config.json'), { ui: { theme: 'light' }, board: 'from-user' })
    write(join(repo(), '.yuzie', 'config.json'), {
      board: 'from-repo',
      git: { baseBranch: 'trunk' },
    })

    const base = { root: repo(), home: home(), env: {} }
    let { config } = await loadConfig(base)
    expect(config.ui.theme).toBe('light')
    expect(config.board).toBe('from-repo')
    expect(config.git).toMatchObject({ baseBranch: 'trunk', branchTemplate: 'task/{id}-{slug}' })
    expect(config.server).toBe('https://api.yuzie.dev/v1')

    ;({ config } = await loadConfig({
      ...base,
      env: { YUZIE_BOARD: 'from-env', YUZIE_SERVER: 'http://localhost:8787/v1' },
    }))
    expect(config.board).toBe('from-env')
    expect(config.server).toBe('http://localhost:8787/v1')

    ;({ config } = await loadConfig({
      ...base,
      env: { YUZIE_BOARD: 'from-env' },
      board: 'from-flag',
    }))
    expect(config.board).toBe('from-flag')
  })

  it('names the file and the key when a layer is wrong', async () => {
    const path = join(repo(), '.yuzie', 'config.json')
    write(path, { git: { hooks: ['pre-rebase'] } })
    await expect(loadConfig({ root: repo(), home: home(), env: {} })).rejects.toThrow(
      new RegExp(`${path.replace(/[.]/g, '\\.')}: git\\.hooks\\.0`),
    )
    write(path, { tyop: true })
    await expect(loadConfig({ root: repo(), home: home(), env: {} })).rejects.toBeInstanceOf(
      UsageError,
    )
  })

  it('reads and writes dotted keys, validating every value', () => {
    const layer = setPath({}, 'git.baseBranch', 'develop')
    expect(layer).toEqual({ version: 1, git: { baseBranch: 'develop' } })
    expect(setPath(layer, 'ui.compact', parseValue('true'))).toMatchObject({
      ui: { compact: true },
    })
    expect(() => setPath(layer, 'ui.theme', 'purple')).toThrow(/ui\.theme/)
    expect(() => setPath(layer, 'no.such', 1)).toThrow(/Unknown config key: no\.such/)
    expect(() => getPath({ ...layer, board: undefined } as never, 'nope')).toThrow(UsageError)
    expect(parseValue('42')).toBe(42)
    expect(parseValue('main')).toBe('main')
  })
})

describe('run', () => {
  function io(cwd = dir) {
    const stdout = capture()
    const stderr = capture()
    const stdin = new PassThrough()
    stdin.end()
    return { stdout, stderr, io: { stdout, stderr, stdin, env: { HOME: dir }, cwd } }
  }

  it('prints the version and help, exiting 0', async () => {
    const version = io()
    expect(await run(['--version'], version.io)).toBe(0)
    expect(version.stdout.text).toBe(`${VERSION}\n`)

    const help = io()
    expect(await run(['--help'], help.io)).toBe(0)
    expect(help.stdout.text).toContain('Usage: yuzie')
    expect(help.stdout.text).toContain('--json')
  })

  it('exits 2 for an unknown command or flag', async () => {
    expect(await run(['teleport'], io().io)).toBe(2)
    expect(await run(['whoami', '--frobnicate'], io().io)).toBe(2)
  })

  it('never fails a git hook, whatever it is given', async () => {
    expect(await run(['__hook', 'post-commit', 'extra', '--weird'], io().io)).toBe(0)
  })

  it('config set then get round-trips through the repo file', async () => {
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, '.yuzie'))
    writeFileSync(join(dir, '.yuzie', 'config.json'), '{"version":1,"board":"b"}\n')
    // No git on this path: point --config at the file explicitly.
    const path = join(dir, '.yuzie', 'config.json')
    expect(
      await run(['config', 'set', 'flow.doneColumn', 'shipped', '--config', path], io().io),
    ).toBe(0)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      board: 'b',
      flow: { doneColumn: 'shipped' },
    })
    const got = io()
    expect(await run(['config', 'get', 'flow.doneColumn', '--config', path], got.io)).toBe(0)
    expect(got.stdout.text).toBe('shipped\n')
  })
})
