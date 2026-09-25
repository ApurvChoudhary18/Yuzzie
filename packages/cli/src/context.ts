/**
 * What every command runs with: the global flags (§7.1), where to print, how to
 * ask, the repository, the layered config, and SDK clients.
 *
 * The CLI reaches the server only through `@yuzie/sdk` (§13.1). Nothing here
 * builds a URL or calls `fetch`.
 */
import { homedir } from 'node:os'
import { AuthenticationError, OfflineError } from '@yuzie/core'
import { findRepo, type Repo } from '@yuzie/git'
import { createClient, type YuzieClient } from '@yuzie/sdk'
import { type CredentialOptions, resolveToken } from '@yuzie/sdk/node'
import { type LoadedConfig, loadConfig } from './config.js'
import { colorEnabled, Output, type Stream } from './output.js'
import { type Input, Prompter } from './prompt.js'
import { VERSION } from './version.js'

/** The flags §7.1 puts on every command. */
export interface GlobalOptions {
  readonly json?: boolean
  readonly board?: string
  /** commander's `--no-color` sets this to false. */
  readonly color?: boolean
  readonly quiet?: boolean
  readonly verbose?: boolean
  readonly offline?: boolean
  readonly yes?: boolean
  readonly config?: string
}

export interface Io {
  readonly stdout: Stream
  readonly stderr: Stream
  readonly stdin: Input
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  /** Defaults to `HOME`, then the OS home directory. */
  readonly home?: string
  /** Ends a blocking command such as `yuzie feed`; the binary relies on SIGINT instead. */
  readonly stop?: Promise<void>
}

export class Context {
  readonly output: Output
  readonly prompter: Prompter
  readonly home: string
  private repoPromise: Promise<Repo | null> | null = null
  private configPromise: Promise<LoadedConfig> | null = null
  private readonly requests = new AbortController()

  constructor(
    readonly options: GlobalOptions,
    readonly io: Io,
  ) {
    const json = options.json === true
    this.output = new Output({
      json,
      color: colorEnabled(options.color, io.env, io.stdout),
      quiet: options.quiet === true,
      verbose: options.verbose === true,
      stdout: io.stdout,
      stderr: io.stderr,
      interactive: io.stdout.isTTY === true,
    })
    this.prompter = new Prompter(this.output, io.stdin, json || options.yes === true)
    this.home = io.home ?? io.env.HOME ?? homedir()
  }

  repo(): Promise<Repo | null> {
    const pending = this.repoPromise ?? findRepo(this.io.cwd)
    this.repoPromise = pending
    return pending
  }

  async config(): Promise<LoadedConfig> {
    const pending =
      this.configPromise ??
      this.repo().then((repo) =>
        loadConfig({
          root: repo?.root ?? null,
          home: this.home,
          env: this.io.env,
          ...(this.options.config === undefined ? {} : { configPath: this.options.config }),
          ...(this.options.board === undefined ? {} : { board: this.options.board }),
        }),
      )
    this.configPromise = pending
    return pending
  }

  /** Forget cached config after a command has rewritten it. */
  reloadConfig(): void {
    this.configPromise = null
  }

  async server(): Promise<string> {
    return (await this.config()).config.server
  }

  /** Where tokens are read from and written to (§13.3). `YUZIE_KEYCHAIN=off` skips the OS keychain. */
  credentials(): CredentialOptions {
    return {
      env: this.io.env,
      home: this.home,
      ...(this.io.env.YUZIE_KEYCHAIN === 'off' ? { keychain: false } : {}),
    }
  }

  async token(): Promise<string | undefined> {
    return (await resolveToken(await this.server(), this.credentials()))?.token
  }

  /** `--offline` forbids anything that needs the server. */
  requireNetwork(what: string): void {
    if (this.options.offline === true) {
      throw new OfflineError(
        'offline_network_required',
        `${what} needs the network, and --offline is set.`,
      )
    }
  }

  /** A client with no credentials, for the device login itself. */
  async anonymousClient(): Promise<YuzieClient> {
    return createClient({ baseUrl: await this.server(), client: `cli/${VERSION}` })
  }

  /**
   * Give up on every request still in flight. The TUI calls this on the way
   * out, so a server that never answers cannot keep the process alive.
   */
  abortRequests(): void {
    this.requests.abort()
  }

  /** A signed-in client; exits 3 with one actionable line when there is no token (§18 Session 6). */
  async client(): Promise<YuzieClient> {
    const token = await this.token()
    if (token === undefined) {
      throw new AuthenticationError('unauthenticated', 'Not signed in. Run `yuzie login`.')
    }
    return createClient({
      baseUrl: await this.server(),
      token,
      client: `cli/${VERSION}`,
      // `--offline` (§7.1): the SDK sees a network that is down, so it reads from
      // the cache and queues writes, exactly as it would on a plane.
      ...(this.options.offline === true
        ? {
            retries: 0,
            fetch: () => Promise.reject(new TypeError('offline (--offline)')),
          }
        : {
            fetch: (url: string, init: RequestInit) =>
              fetch(url, { ...init, signal: this.requests.signal }),
          }),
    })
  }

  /** The terminal's width, for tables (§7.3); 80 when it cannot be known. */
  get width(): number {
    const columns = (this.io.stdout as { columns?: number }).columns
    if (typeof columns === 'number' && columns > 0) return columns
    const env = Number(this.io.env.COLUMNS)
    return Number.isInteger(env) && env > 0 ? env : 80
  }

  /** The clock, injectable so output with relative times can be tested. */
  now(): Date {
    const fixed = this.io.env.YUZIE_NOW
    return fixed === undefined ? new Date() : new Date(fixed)
  }
}
