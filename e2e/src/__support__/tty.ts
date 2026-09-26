/**
 * The real `yuzie` TUI in a real pseudo-terminal, read back as a screen.
 *
 * A few lines of Python's `pty` give the binary a terminal of a fixed size, so
 * Ink gets raw-mode input exactly as in a person's terminal; a headless xterm
 * replays everything it draws, so a test reads the screen a person would see —
 * not a log of escape codes. (`script(1)` would do, but macOS's refuses a pipe
 * for stdin, and node-pty is a native build.)
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import xterm from '@xterm/headless'
import { CLI } from './cli.js'

const { Terminal } = xterm

export interface Tui {
  /** The screen, one string per row, trailing spaces trimmed. */
  screen(): string[]
  /** The whole screen as one string, for `toContain`. */
  text(): string
  /** Type into the TUI: keys, or escape sequences such as `\r` and `\u001b`. */
  press(...keys: string[]): Promise<void>
  /** Resolve once the screen matches; the screen is in the error otherwise. */
  waitFor(
    match: string | RegExp | ((screen: string) => boolean),
    what?: string,
    timeoutMs?: number,
  ): Promise<void>
  /** Screen changes seen so far: each write that reached the terminal. */
  readonly writes: number
  /** Quit with `q` and wait for the process to exit. */
  quit(): Promise<number>
  kill(): void
  readonly child: ChildProcessWithoutNullStreams
}

/** Fork the command on a pty of the given size and shuttle bytes both ways. */
const BRIDGE = `
import fcntl, os, pty, select, signal, struct, sys, termios
cols, rows, cmd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    os.execvp(cmd[0], cmd)
signal.signal(signal.SIGTERM, lambda *_: os.kill(pid, signal.SIGTERM))
inputs = [fd, 0]
while True:
    try:
        ready, _, _ = select.select(inputs, [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if data:
            os.write(fd, data)
        else:
            inputs.remove(0)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else status >> 8)
`

export function startTui(options: {
  cwd: string
  env: NodeJS.ProcessEnv
  args?: readonly string[]
  cols?: number
  rows?: number
}): Tui {
  const cols = options.cols ?? 120
  const rows = options.rows ?? 36
  const argv = [
    '-c',
    BRIDGE,
    String(cols),
    String(rows),
    process.execPath,
    CLI,
    ...(options.args ?? []),
  ]
  const child = spawn('python3', argv, {
    cwd: options.cwd,
    env: { TERM: 'xterm-256color', ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const terminal = new Terminal({ cols, rows, allowProposedApi: true })
  let writes = 0
  let pending = Promise.resolve()
  let stderr = ''
  const listeners = new Set<() => void>()
  child.stdout.on('data', (chunk: Buffer) => {
    pending = pending.then(
      () =>
        new Promise<void>((resolve) =>
          terminal.write(chunk, () => {
            writes += 1
            for (const listener of listeners) listener()
            resolve()
          }),
        ),
    )
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  let exited: number | null = null
  const exit = new Promise<number>((resolve) =>
    child.on('close', (code) => {
      exited = code ?? 1
      resolve(exited)
    }),
  )

  const screen = () => {
    const buffer = terminal.buffer.active
    const out: string[] = []
    for (let row = 0; row < rows; row += 1)
      out.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
    return out
  }
  const text = () => screen().join('\n')

  return {
    child,
    screen,
    text,
    get writes() {
      return writes
    },
    async press(...keys) {
      for (const key of keys) {
        child.stdin.write(key)
        // A lone Esc is held briefly by the TUI in case a sequence follows.
        await new Promise((resolve) => setTimeout(resolve, key === '\u001b' ? 120 : 30))
      }
    },
    waitFor(match, what, timeoutMs = 10_000) {
      const test =
        typeof match === 'function'
          ? match
          : typeof match === 'string'
            ? (s: string) => s.includes(match)
            : (s: string) => match.test(s)
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!test(text())) return
          listeners.delete(check)
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          listeners.delete(check)
          reject(
            new Error(
              `timed out waiting for ${what ?? String(match)}${exited === null ? '' : ` (exited ${exited})`}\n--- screen ---\n${text()}\n--- stderr ---\n${stderr}`,
            ),
          )
        }, timeoutMs)
        listeners.add(check)
        check()
      })
    },
    async quit() {
      if (exited !== null) return exited
      child.stdin.write('q')
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      const code = await exit
      clearTimeout(timer)
      return code
    },
    kill() {
      if (exited === null) child.kill('SIGKILL')
    },
  }
}
