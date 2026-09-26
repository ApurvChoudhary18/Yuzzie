/**
 * Who you are on each server, remembered, so offline work still knows (§9.3:
 * `claim` assigns you even when the server cannot be reached; §9.6 rule 4
 * finds "your" in-progress card from a git hook without a network call).
 *
 * `~/.yuzie/identity.json` holds handles only — never a token.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { serverKey } from '@yuzie/sdk/node'

interface IdentityFile {
  readonly version: 1
  readonly servers: Record<string, { readonly handle: string }>
}

export function identityPath(home: string): string {
  return join(home, '.yuzie', 'identity.json')
}

async function read(home: string): Promise<IdentityFile> {
  try {
    const parsed = JSON.parse(await readFile(identityPath(home), 'utf8')) as IdentityFile
    return parsed.version === 1 && typeof parsed.servers === 'object'
      ? parsed
      : { version: 1, servers: {} }
  } catch {
    return { version: 1, servers: {} }
  }
}

export async function knownHandle(home: string, server: string): Promise<string | null> {
  return (await read(home)).servers[serverKey(server)]?.handle ?? null
}

/** Best effort: failing to remember never fails the command that learned it. */
export async function rememberHandle(home: string, server: string, handle: string): Promise<void> {
  try {
    const file = await read(home)
    if (file.servers[serverKey(server)]?.handle === handle) return
    const next: IdentityFile = {
      version: 1,
      servers: { ...file.servers, [serverKey(server)]: { handle } },
    }
    await mkdir(dirname(identityPath(home)), { recursive: true })
    await writeFile(identityPath(home), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // A read-only home is not a reason to fail.
  }
}
