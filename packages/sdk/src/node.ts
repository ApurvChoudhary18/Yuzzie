/**
 * `@yuzie/sdk/node` — the SDK plus the local credential store (SPEC.md §13.3).
 *
 * Identical to `@yuzie/sdk`, except that `Yuzie.connect` and `Yuzie.client`
 * find a token themselves when none is passed: `YUZIE_TOKEN`, then the OS
 * keychain, then `~/.yuzie/credentials`.
 */
import { AuthenticationError } from '@yuzie/core'
import type { Board } from './board.js'
import {
  Yuzie as BaseYuzie,
  type ClientOptions,
  type ConnectOptions,
  DEFAULT_BASE_URL,
  type YuzieClient,
} from './client.js'
import { type CredentialOptions, resolveToken } from './credentials.js'

export * from './credentials.js'
export * from './index.js'

export interface NodeClientOptions extends ClientOptions {
  /** Where to look for a stored token when `token` is not given. */
  readonly credentials?: CredentialOptions
}

async function withToken<T extends NodeClientOptions>(options: T): Promise<T & { token: string }> {
  if (options.token !== undefined) return { ...options, token: options.token }
  const resolved = await resolveToken(options.baseUrl ?? DEFAULT_BASE_URL, options.credentials)
  if (resolved === undefined) {
    throw new AuthenticationError('unauthenticated', 'No credentials. Run `yuzie login`.')
  }
  return { ...options, token: resolved.token }
}

export const Yuzie = {
  async connect(slug: string, options: ConnectOptions & NodeClientOptions = {}): Promise<Board> {
    const { credentials: _credentials, ...rest } = await withToken(options)
    return BaseYuzie.connect(slug, rest)
  },

  /** Unlike the browser entry this is async, because finding the token may read the keychain. */
  async client(options: NodeClientOptions = {}): Promise<YuzieClient> {
    const { credentials: _credentials, ...rest } = await withToken(options)
    return BaseYuzie.client(rest)
  },
} as const
