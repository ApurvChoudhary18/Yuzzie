import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serverCommand } from './serve.js'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A project with @yuzie/server installed, exporting only its entry point as the real one does. */
function projectWithServer(): { root: string; bin: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-serve-')))
  made.push(root)
  const server = join(root, 'node_modules', '@yuzie', 'server')
  mkdirSync(join(server, 'dist'), { recursive: true })
  mkdirSync(join(server, 'bin'), { recursive: true })
  writeFileSync(
    join(server, 'package.json'),
    JSON.stringify({
      name: '@yuzie/server',
      exports: { '.': { import: './dist/index.js', require: './dist/index.cjs' } },
    }),
  )
  writeFileSync(join(server, 'dist', 'index.js'), '')
  writeFileSync(join(server, 'dist', 'index.cjs'), '')
  writeFileSync(join(server, 'bin', 'yuzie-server.js'), '')
  return { root, bin: join(server, 'bin', 'yuzie-server.js') }
}

describe('serverCommand', () => {
  it('runs YUZIE_SERVER_BIN when it is set', () => {
    expect(serverCommand({ YUZIE_SERVER_BIN: '/opt/server.js' }, tmpdir())).toEqual([
      process.execPath,
      '/opt/server.js',
    ])
  })

  it('finds an installed @yuzie/server, whose exports do not include package.json', () => {
    const { root, bin } = projectWithServer()
    expect(serverCommand({}, root)).toEqual([process.execPath, bin])
  })
})
