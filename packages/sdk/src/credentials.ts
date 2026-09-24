/**
 * Credential resolution (SPEC.md §13.3). Node only.
 *
 * Precedence: `YUZIE_TOKEN` → OS keychain entry `yuzie:<server>` → the file
 * `~/.yuzie/credentials` (mode 0600). Tokens are keyed by server so one machine
 * can be logged in to the hosted service and a self-hosted one at once.
 *
 * The keychain is reached through the platform's own CLI (`security` on macOS,
 * `secret-tool` on Linux) rather than a native module, so installing the SDK
 * never needs a compiler. Tokens are written on stdin, never as an argument,
 * because arguments are visible to every user on the machine through `ps`.
 */
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const TOKEN_ENV = 'YUZIE_TOKEN'
export const KEYCHAIN_ACCOUNT = 'yuzie'

export type CredentialSource = 'env' | 'keychain' | 'file'

export interface ResolvedCredential {
  readonly token: string
  readonly source: CredentialSource
}

/** A secret store. `get` returns undefined when there is no entry or no keychain. */
export interface Keychain {
  get(service: string): Promise<string | undefined>
  set(service: string, token: string): Promise<boolean>
  delete(service: string): Promise<void>
}

export interface CredentialOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Defaults to the user's home directory. */
  readonly home?: string
  /** Defaults to {@link systemKeychain}; `false` skips the keychain entirely. */
  readonly keychain?: Keychain | false
}

/** Raised rather than reading a token file other users can read, as `ssh` does. */
export class InsecureCredentialsError extends Error {
  constructor(readonly path: string) {
    super(`${path} is readable by other users. Run \`chmod 600 ${path}\` and retry.`)
    this.name = 'InsecureCredentialsError'
  }
}

interface CredentialsFile {
  readonly version: 1
  readonly servers: Record<string, { readonly token: string }>
}

/** `https://api.yuzie.dev/v1/` and `https://api.yuzie.dev/v1` are one server. */
export function serverKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

export function keychainService(baseUrl: string): string {
  return `yuzie:${serverKey(baseUrl)}`
}

export function credentialsPath(home: string = homedir()): string {
  return join(home, '.yuzie', 'credentials')
}

// ---------------------------------------------------------------------------
// The system keychain
// ---------------------------------------------------------------------------

export type CommandRunner = (
  command: string,
  args: readonly string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string }>

const runCommand: CommandRunner = (command, args, stdin) =>
  new Promise((resolve) => {
    let stdout = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      resolve({ code: 127, stdout: '' })
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    // A missing binary surfaces as an error event, not an exception.
    child.on('error', () => resolve({ code: 127, stdout: '' }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
    child.stdin?.end(stdin ?? '')
  })

/** Quote for `security -i`, which splits its input like a shell. */
function quote(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`
}

/**
 * The OS keychain for this platform, or one that holds nothing where there is
 * no supported keychain (Windows, or Linux without libsecret).
 */
export function systemKeychain(
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = runCommand,
): Keychain {
  if (platform === 'darwin') {
    return {
      async get(service) {
        const result = await run('security', [
          'find-generic-password',
          '-s',
          service,
          '-a',
          KEYCHAIN_ACCOUNT,
          '-w',
        ])
        const token = result.stdout.trim()
        return result.code === 0 && token.length > 0 ? token : undefined
      },
      async set(service, token) {
        const command = `add-generic-password -U -s ${quote(service)} -a ${KEYCHAIN_ACCOUNT} -w ${quote(token)}\n`
        const result = await run('security', ['-i'], command)
        return result.code === 0
      },
      async delete(service) {
        await run('security', ['delete-generic-password', '-s', service, '-a', KEYCHAIN_ACCOUNT])
      },
    }
  }

  if (platform === 'linux') {
    return {
      async get(service) {
        const result = await run('secret-tool', ['lookup', 'service', service])
        const token = result.stdout.trim()
        return result.code === 0 && token.length > 0 ? token : undefined
      },
      async set(service, token) {
        const result = await run(
          'secret-tool',
          ['store', `--label=Yuzie (${service})`, 'service', service],
          token,
        )
        return result.code === 0
      },
      async delete(service) {
        await run('secret-tool', ['clear', 'service', service])
      },
    }
  }

  return {
    get: async () => undefined,
    set: async () => false,
    delete: async () => {},
  }
}

// ---------------------------------------------------------------------------
// The credentials file
// ---------------------------------------------------------------------------

async function readCredentialsFile(path: string): Promise<CredentialsFile | undefined> {
  let mode: number
  try {
    mode = (await stat(path)).mode
  } catch {
    return undefined
  }
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new InsecureCredentialsError(path)
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<CredentialsFile>
    return { version: 1, servers: parsed.servers ?? {} }
  } catch {
    return undefined
  }
}

async function writeCredentialsFile(path: string, file: CredentialsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // Written to a sibling and renamed so a crash never leaves half a file, and
  // created 0600 so there is no moment at which it is readable by others.
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export async function resolveToken(
  baseUrl: string,
  options: CredentialOptions = {},
): Promise<ResolvedCredential | undefined> {
  const env = options.env ?? process.env
  const fromEnv = env[TOKEN_ENV]?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return { token: fromEnv, source: 'env' }

  const keychain = options.keychain === undefined ? systemKeychain() : options.keychain
  if (keychain !== false) {
    const fromKeychain = await keychain.get(keychainService(baseUrl))
    if (fromKeychain !== undefined) return { token: fromKeychain, source: 'keychain' }
  }

  const file = await readCredentialsFile(credentialsPath(options.home))
  const fromFile = file?.servers[serverKey(baseUrl)]?.token
  if (fromFile !== undefined && fromFile.length > 0) return { token: fromFile, source: 'file' }

  return undefined
}

/** Store a token: in the keychain when there is one, else in the 0600 file. */
export async function saveToken(
  baseUrl: string,
  token: string,
  options: CredentialOptions = {},
): Promise<Exclude<CredentialSource, 'env'>> {
  const keychain = options.keychain === undefined ? systemKeychain() : options.keychain
  if (keychain !== false && (await keychain.set(keychainService(baseUrl), token))) {
    return 'keychain'
  }

  const path = credentialsPath(options.home)
  const existing = await readCredentialsFile(path)
  await writeCredentialsFile(path, {
    version: 1,
    servers: { ...existing?.servers, [serverKey(baseUrl)]: { token } },
  })
  return 'file'
}

/** Forget a server's token everywhere it could be stored. */
export async function deleteToken(baseUrl: string, options: CredentialOptions = {}): Promise<void> {
  const keychain = options.keychain === undefined ? systemKeychain() : options.keychain
  if (keychain !== false) await keychain.delete(keychainService(baseUrl))

  const path = credentialsPath(options.home)
  const existing = await readCredentialsFile(path)
  if (existing?.servers[serverKey(baseUrl)] === undefined) return
  const { [serverKey(baseUrl)]: _removed, ...servers } = existing.servers
  await writeCredentialsFile(path, { version: 1, servers })
}
