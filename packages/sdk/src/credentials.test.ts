import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type CommandRunner,
  credentialsPath,
  deleteToken,
  InsecureCredentialsError,
  type Keychain,
  keychainService,
  resolveToken,
  saveToken,
  systemKeychain,
} from './credentials.js'

const SERVER = 'https://api.yuzie.dev/v1'

function memoryKeychain(
  initial: Record<string, string> = {},
  writable = true,
): Keychain & {
  entries: Record<string, string>
} {
  const entries = { ...initial }
  return {
    entries,
    get: async (service) => entries[service],
    set: async (service, token) => {
      if (!writable) return false
      entries[service] = token
      return true
    },
    delete: async (service) => {
      delete entries[service]
    },
  }
}

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yuzie-home-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('resolveToken (§13.3 precedence)', () => {
  it('prefers YUZIE_TOKEN over everything', async () => {
    const keychain = memoryKeychain({ [keychainService(SERVER)]: 'from-keychain' })
    await saveToken(SERVER, 'from-file', { home, keychain: false })
    const resolved = await resolveToken(SERVER, {
      env: { YUZIE_TOKEN: ' from-env ' },
      home,
      keychain,
    })
    expect(resolved).toEqual({ token: 'from-env', source: 'env' })
  })

  it('then the keychain', async () => {
    const keychain = memoryKeychain({ [keychainService(SERVER)]: 'from-keychain' })
    await saveToken(SERVER, 'from-file', { home, keychain: false })
    expect(await resolveToken(SERVER, { env: {}, home, keychain })).toEqual({
      token: 'from-keychain',
      source: 'keychain',
    })
  })

  it('then the credentials file', async () => {
    await saveToken(SERVER, 'from-file', { home, keychain: false })
    expect(await resolveToken(SERVER, { env: {}, home, keychain: memoryKeychain() })).toEqual({
      token: 'from-file',
      source: 'file',
    })
  })

  it('finds nothing when nothing is stored', async () => {
    expect(
      await resolveToken(SERVER, { env: {}, home, keychain: memoryKeychain() }),
    ).toBeUndefined()
  })

  it('keys tokens by server, ignoring a trailing slash', async () => {
    await saveToken('http://localhost:8787/v1/', 'self-hosted', { home, keychain: false })
    await saveToken(SERVER, 'hosted', { home, keychain: false })
    const options = { env: {}, home, keychain: false as const }
    expect((await resolveToken('http://localhost:8787/v1', options))?.token).toBe('self-hosted')
    expect((await resolveToken(SERVER, options))?.token).toBe('hosted')
  })
})

describe('the credentials file', () => {
  it('is created with mode 0600 inside a 0700 directory', async () => {
    expect(await saveToken(SERVER, 'secret', { home, keychain: false })).toBe('file')
    const path = credentialsPath(home)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, '.yuzie')).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      servers: { [SERVER]: { token: 'secret' } },
    })
  })

  it('is refused, not read, when other users can read it', async () => {
    mkdirSync(join(home, '.yuzie'))
    const path = credentialsPath(home)
    writeFileSync(path, JSON.stringify({ version: 1, servers: { [SERVER]: { token: 't' } } }))
    chmodSync(path, 0o644)
    await expect(resolveToken(SERVER, { env: {}, home, keychain: false })).rejects.toBeInstanceOf(
      InsecureCredentialsError,
    )
  })

  it('treats a corrupt file as empty rather than crashing', async () => {
    mkdirSync(join(home, '.yuzie'))
    writeFileSync(credentialsPath(home), '{ not json', { mode: 0o600 })
    expect(await resolveToken(SERVER, { env: {}, home, keychain: false })).toBeUndefined()
  })
})

describe('saveToken and deleteToken', () => {
  it('stores in the keychain when it accepts the token, and writes no file', async () => {
    const keychain = memoryKeychain()
    expect(await saveToken(SERVER, 'secret', { home, keychain })).toBe('keychain')
    expect(keychain.entries[keychainService(SERVER)]).toBe('secret')
    expect(() => statSync(credentialsPath(home))).toThrow()
  })

  it('falls back to the file when the keychain refuses', async () => {
    expect(await saveToken(SERVER, 'secret', { home, keychain: memoryKeychain({}, false) })).toBe(
      'file',
    )
  })

  it('forgets a server everywhere, leaving other servers alone', async () => {
    const keychain = memoryKeychain({ [keychainService(SERVER)]: 'k' })
    await saveToken(SERVER, 'f', { home, keychain: false })
    await saveToken('http://localhost:8787/v1', 'other', { home, keychain: false })
    await deleteToken(SERVER, { home, keychain })
    expect(keychain.entries).toEqual({})
    expect(await resolveToken(SERVER, { env: {}, home, keychain })).toBeUndefined()
    expect(
      (await resolveToken('http://localhost:8787/v1', { env: {}, home, keychain }))?.token,
    ).toBe('other')
  })
})

describe('systemKeychain', () => {
  function recorder(stdout = '', code = 0) {
    const calls: Array<{ command: string; args: readonly string[]; stdin?: string }> = []
    const run: CommandRunner = async (command, args, stdin) => {
      calls.push({ command, args, ...(stdin === undefined ? {} : { stdin }) })
      return { code, stdout }
    }
    return { run, calls }
  }

  it('on macOS, writes through `security -i` so the token is never an argument', async () => {
    const { run, calls } = recorder()
    const keychain = systemKeychain('darwin', run)
    expect(await keychain.set('yuzie:https://x/v1', 'yz_sec"ret')).toBe(true)
    expect(calls[0]?.command).toBe('security')
    expect(calls[0]?.args).toEqual(['-i'])
    expect(calls[0]?.args.join(' ')).not.toContain('yz_sec')
    expect(calls[0]?.stdin).toContain('-w "yz_sec\\"ret"')
  })

  it('on macOS, reads with find-generic-password', async () => {
    const { run, calls } = recorder('yz_token\n')
    expect(await systemKeychain('darwin', run).get('yuzie:s')).toBe('yz_token')
    expect(calls[0]?.args).toEqual(['find-generic-password', '-s', 'yuzie:s', '-a', 'yuzie', '-w'])
  })

  it('on Linux, uses secret-tool with the token on stdin', async () => {
    const { run, calls } = recorder()
    await systemKeychain('linux', run).set('yuzie:s', 'yz_token')
    expect(calls[0]?.command).toBe('secret-tool')
    expect(calls[0]?.args).not.toContain('yz_token')
    expect(calls[0]?.stdin).toBe('yz_token')
  })

  it('reports no entry when the tool fails or is missing', async () => {
    const { run } = recorder('', 127)
    expect(await systemKeychain('linux', run).get('yuzie:s')).toBeUndefined()
    expect(await systemKeychain('darwin', run).get('yuzie:s')).toBeUndefined()
  })

  it('holds nothing on platforms without a supported keychain', async () => {
    const keychain = systemKeychain('win32')
    expect(await keychain.get('yuzie:s')).toBeUndefined()
    expect(await keychain.set('yuzie:s', 't')).toBe(false)
  })
})
