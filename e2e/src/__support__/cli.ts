/**
 * Drive the built `yuzie` binary as a separate process, the way a person or a
 * script does: real argv, real env, real stdin and stdout.
 */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url))

export interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface Machine {
  /** A HOME of its own, so tokens and config never touch the real user's. */
  readonly home: string
  readonly env: NodeJS.ProcessEnv
}

/** A fresh "computer": its own HOME, pointed at `server`, keychain off. */
export function machine(server: string): Machine {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-home-')))
  return {
    home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      YUZIE_SERVER: server,
      // Never write to the developer's real keychain from a test.
      YUZIE_KEYCHAIN: 'off',
      YUZIE_NO_BROWSER: '1',
      NO_COLOR: '1',
      LANG: 'en_US.UTF-8',
    },
  }
}

/** A git repository with an `origin` remote, on `main`. */
export function repository(remote = 'git@github.com:acme/payments-api.git'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-repo-')))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'rahul@acme.dev')
  git('config', 'user.name', 'Rahul')
  git('remote', 'add', 'origin', remote)
  return dir
}

export interface Running {
  readonly child: ChildProcessWithoutNullStreams
  stdout(): string
  /** Resolve with the first match of `pattern` in stdout+stderr. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>
  done: Promise<CliResult>
}

export function start(
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): Running {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const watchers: Array<() => void> = []
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
    for (const watcher of [...watchers]) watcher()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
    for (const watcher of [...watchers]) watcher()
  })
  if (options.input !== undefined) child.stdin.write(options.input)
  child.stdin.end()

  const done = new Promise<CliResult>((resolve) => {
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })

  return {
    child,
    stdout: () => stdout,
    waitFor(pattern, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const match = (stdout + stderr).match(pattern)
          if (match === null) return false
          watchers.splice(watchers.indexOf(check), 1)
          clearTimeout(timer)
          resolve(match)
          return true
        }
        const timer = setTimeout(() => {
          watchers.splice(watchers.indexOf(check), 1)
          reject(new Error(`timed out waiting for ${pattern}; output so far:\n${stdout}${stderr}`))
        }, timeoutMs)
        if (!check()) watchers.push(check)
      })
    },
    done,
  }
}

export function yuzie(
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): Promise<CliResult> {
  return start(args, options).done
}

/**
 * Put a `yuzie` on the machine's PATH that runs the built CLI — what the Git
 * hooks call (`command -v yuzie`), as an installed binary would be found.
 */
export function withYuzieOnPath(target: Machine): Machine {
  const bin = join(target.home, 'bin')
  mkdirSync(bin, { recursive: true })
  const shim = join(bin, 'yuzie')
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`)
  chmodSync(shim, 0o755)
  return { ...target, env: { ...target.env, PATH: `${bin}:${target.env.PATH ?? ''}` } }
}
