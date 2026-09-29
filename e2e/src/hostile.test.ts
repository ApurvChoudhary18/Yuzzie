/**
 * SPEC.md §18 Session 16: fuzzing the CLI with malformed arguments and hostile
 * input — unicode, 10 KB titles, control characters, invalid unicode, path
 * traversal in anchors — against a real server and the built binary.
 *
 * Whatever goes in, four things hold for every run:
 *   1. the exit code is one §7.4 defines;
 *   2. no stack trace reaches the user;
 *   3. under --json, stdout is exactly one valid document;
 *   4. what a person sees has no raw control characters: nothing typed into a
 *      card can move the cursor, retitle the window or clear someone's screen.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseOutput } from '@yuzie/core'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CliResult, machine, repository, yuzie } from './__support__/cli.js'
import {
  createBoard,
  signIn,
  startWorld,
  type User,
  unique,
  type World,
} from './__support__/world.js'

let world: World
let rahul: User
let slug: string
let repo: string
let env: NodeJS.ProcessEnv

const EXIT_CODES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8])
/** A V8 stack frame: `    at fn (file.js:12:34)`. */
const STACK = /\n\s+at\s.+:\d+:\d+\)?/
/** C0 and C1 controls other than newline and tab, and DEL. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for exactly these
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

beforeAll(async () => {
  world = await startWorld()
  rahul = await signIn(world.baseUrl, unique('rahul'))
  slug = await createBoard(world.baseUrl, rahul)
  repo = repository()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  writeFileSync(join(repo, 'README.md'), 'hello\n'.repeat(20))
  git('add', '.')
  git('commit', '-m', 'init')
  env = { ...machine(world.baseUrl).env, YUZIE_TOKEN: rahul.token, YUZIE_BOARD: slug }
  const first = await yuzie(['add', 'A card to aim at'], { cwd: repo, env })
  expect(first.code, first.stderr).toBe(0)
})

afterAll(async () => {
  await world?.close()
})

/** Run, and hold the four invariants whatever happened. */
async function hostile(args: string[]): Promise<CliResult> {
  const result = await yuzie(args, { cwd: repo, env })
  const label = JSON.stringify(args).slice(0, 200)
  expect(EXIT_CODES.has(result.code), `${label}: exit ${result.code}`).toBe(true)
  expect(result.stderr, `${label}: stack trace on stderr`).not.toMatch(STACK)
  expect(result.stdout, `${label}: stack trace on stdout`).not.toMatch(STACK)
  if (args.includes('--json')) {
    const lines = result.stdout.trim().split('\n').filter(Boolean)
    if (result.code === 0) {
      expect(lines, `${label}: one document`).toHaveLength(1)
      parseOutput(JSON.parse(lines[0] ?? ''))
    } else {
      // Errors are one JSON document too (on stdout), or nothing there at all.
      for (const line of lines) JSON.parse(line)
    }
  } else {
    expect(result.stdout, `${label}: control characters on stdout`).not.toMatch(CONTROL)
    expect(result.stderr, `${label}: control characters on stderr`).not.toMatch(CONTROL)
  }
  return result
}

// No NUL here: an operating system cannot put one in argv (the server's own
// tests send it through the API instead).
const NASTY = [
  '\u001b[2J\u001b[H screen cleared',
  '\u001b]0;pwned\u0007 window title',
  '\u009b31m C1 CSI',
  'bell\u0007 and backspace\b\b\b',
  'carriage\rreturn',
  'tab\there',
  'emoji 🧪👩‍💻🇮🇳 and 漢字 and עברית',
  'combining é́́',
  'zero​width‍joiners⁠',
  'rtl ‮override‬',
  'lone \ud800 surrogate',
  '   ',
  '-flag-looking',
  '--json',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${…} is one of the hostile inputs
  '%s %d ${oops} $(whoami) `whoami`',
  '"quotes" \'and\' \\backslashes\\',
  'x'.repeat(10 * 1024),
  `${'🧪'.repeat(3000)}`,
]

describe('hostile card content', () => {
  it('titles: stored or refused, never a crash, never a raw control character', async () => {
    for (const title of NASTY) {
      const added = await hostile(['add', title, '--json'])
      if (added.code !== 0) {
        expect(added.code, `${JSON.stringify(title)} refused`).toBe(2)
        continue
      }
      const number = JSON.parse(added.stdout).data.number as number
      await hostile(['card', String(number)])
      await hostile(['card', String(number), '--json'])
      await hostile(['comment', String(number), title])
    }
    await hostile(['list'])
    await hostile(['list', '--json'])
    await hostile(['activity', '--limit', '100'])
    await hostile(['list', '--search', '\u001b[2J'])
  })

  it('random unicode and control characters, as titles and searches', async () => {
    const samples = fc.sample(
      fc.string({
        unit: fc.oneof(
          fc.constantFrom('\u001b', '\u0007', '\u009b', '\n', '\r'),
          fc
            .string({ unit: 'binary', minLength: 1, maxLength: 1 })
            .filter((char: string) => char !== '\u0000'),
        ),
        minLength: 1,
        maxLength: 60,
      }),
      { numRuns: 12, seed: 20260929 },
    )
    for (const text of samples) {
      const added = await hostile(['add', text, '--json'])
      if (added.code === 0) await hostile(['card', String(JSON.parse(added.stdout).data.number)])
      await hostile(['list', '--search', text])
    }
  })
})

describe('malformed arguments', () => {
  const cases: Array<[string[], number]> = [
    [['move'], 2],
    [['move', '1'], 2],
    [['add'], 2],
    [['card', '-1'], 4],
    [['card', '0'], 4],
    [['card', '99999999999999999999999'], 4],
    [['card', 'not-a-number-at-all'], 4],
    [['list', '--limit', 'abc'], 2],
    [['list', '--limit', '-5'], 2],
    [['list', '--sort', 'sideways'], 2],
    [['list', '--stale', 'soon'], 2],
    [['due', '1', 'the twelfth of never'], 2],
    [['priority', '1', 'p9'], 2],
    [['move', '1', 'no-such-column'], 4],
    [['label', '1', ''], 2],
    [['activity', '--before', 'yesterday'], 2],
    [['activity', '--limit', '100000'], 2],
    [['list', '--nope'], 2],
    [['definitely-not-a-command'], 2],
    [['--board', '../../etc', 'list'], 4],
  ]
  it.each(cases)('%j exits %i with one line of help and no stack', async (args, code) => {
    const result = await hostile(args)
    expect(result.code, `${args.join(' ')}: ${result.stderr}`).toBe(code)
    expect(result.stderr.trim().length).toBeGreaterThan(0)
  })
})

describe('anchors cannot escape the repository', () => {
  it.each([
    '../../../../etc/passwd:1',
    '/etc/passwd:1',
    'README.md/../../outside.txt:3',
    '..:1',
    'README.md:0',
    'README.md:-3',
    'README.md:99999999999',
    'README.md:5-2',
  ])('refuses %j', async (location) => {
    const result = await hostile(['anchor', '1', location])
    expect(result.code, result.stderr).toBe(2)
  })

  it('accepts a real file', async () => {
    expect((await hostile(['anchor', '1', 'README.md:3'])).code).toBe(0)
  })
})
