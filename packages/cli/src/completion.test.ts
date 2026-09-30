import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { openCache } from '@yuzie/store'
import { beforeAll, describe, expect, it } from 'vitest'
import { completionScript } from './commands/completion.js'
import { run } from './program.js'
import { card, column } from './tui/__tests__/fixtures.js'

let home = ''
let cwd = ''
const env = () => ({ HOME: home, YUZIE_BOARD: 'demo', NO_COLOR: '1', PATH: process.env.PATH })

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-complete-home-')))
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-complete-cwd-')))
  const cache = openCache({ boardSlug: 'demo', cwd, home, env: {} })
  cache.columns.putMany('demo', [
    column('todo', 'Todo', 0, 'backlog'),
    column('doing', 'Doing', 1, 'in_progress'),
    column('done', 'Done', 2, 'terminal'),
  ])
  cache.cards.putMany('demo', [
    card(7, { title: 'Fix OAuth', column: 'doing' }),
    card(18, { title: 'Rate limits' }),
  ])
  cache.close()
})

async function complete(...words: string[]): Promise<string[]> {
  const stdout = new PassThrough()
  let text = ''
  stdout.on('data', (chunk: Buffer) => {
    text += chunk.toString()
  })
  const code = await run(['__complete', String(words.length - 1), ...words], {
    stdout,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    env: env(),
    cwd,
  })
  expect(code).toBe(0)
  return text.split('\n').filter(Boolean)
}

describe('yuzie __complete (§18 Session 17)', () => {
  it('offers commands, with descriptions, filtered by what is typed', async () => {
    const all = await complete('')
    expect(all.map((line) => line.split('\t')[0])).toEqual(
      expect.arrayContaining(['list', 'move', 'claim', 'completion', 'token']),
    )
    expect(all.some((line) => line.startsWith('__complete'))).toBe(false)
    expect((await complete('mo')).map((line) => line.split('\t')[0])).toEqual(['move'])
  })

  it('offers card numbers with titles and columns, from the cache', async () => {
    expect(await complete('move', '')).toEqual(['7\tFix OAuth (Doing)', '18\tRate limits (Todo)'])
    expect(await complete('move', '1')).toEqual(['18\tRate limits (Todo)'])
    expect((await complete('move', '7', 'd')).map((line) => line.split('\t')[0])).toEqual([
      'doing',
      'done',
    ])
    expect((await complete('assign', '18', '')).length).toBe(0)
  })

  it('offers flags, and values for the flags that take them', async () => {
    expect(await complete('list', '--col')).toEqual(['--column\tsame as --status'])
    expect((await complete('list', '--column', '')).map((line) => line.split('\t')[0])).toEqual([
      'todo',
      'doing',
      'done',
    ])
    expect((await complete('add', 'x', '--priority', 'p')).map((l) => l.split('\t')[0])).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
    ])
    expect((await complete('token', '')).map((l) => l.split('\t')[0])).toEqual([
      'create',
      'list',
      'revoke',
    ])
    expect((await complete('completion', '')).map((l) => l.split('\t')[0])).toEqual([
      'bash',
      'zsh',
      'fish',
    ])
  })

  it('never errors into a prompt: no board, no cache, nonsense', async () => {
    const stdout = new PassThrough()
    let text = ''
    stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString()
    })
    const code = await run(['__complete', '1', 'move', ''], {
      stdout,
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env: { HOME: home, PATH: process.env.PATH },
      cwd: tmpdir(),
    })
    expect(code).toBe(0)
    expect(text).toBe('')
  })
})

describe('the bash script, in bash (§18 Session 17)', () => {
  it('completes card numbers through `yuzie __complete`', () => {
    // A `yuzie` on PATH that runs this source tree's program in-process.
    const bin = join(home, 'bin')
    mkdirSync(bin, { recursive: true })
    const cli = new URL('../dist/index.js', import.meta.url).pathname
    writeFileSync(join(bin, 'yuzie'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`)
    chmodSync(join(bin, 'yuzie'), 0o755)
    const out = execFileSync(
      'bash',
      [
        '-c',
        `${completionScript('bash')}
COMP_WORDS=(yuzie move "")
COMP_CWORD=2
_yuzie
printf '%s\\n' "\${COMPREPLY[@]}"`,
      ],
      { cwd, env: { ...env(), PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' },
    )
    expect(out.trim().split('\n')).toEqual(['7', '18'])
  })

  it('prints a script for each shell, and refuses others', async () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const)
      expect(completionScript(shell)).toContain('yuzie __complete')
    const code = await run(['completion', 'powershell'], {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      env: env(),
      cwd,
    })
    expect(code).toBe(2)
  })
})
