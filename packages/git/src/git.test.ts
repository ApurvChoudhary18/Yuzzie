import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultBranch,
  findRepo,
  gitVersion,
  hookBlock,
  hookStatus,
  installHooks,
  parseRemote,
  uninstallHooks,
} from './index.js'

describe('parseRemote', () => {
  it.each([
    ['git@github.com:acme/payments-api.git', 'github.com', 'acme/payments-api'],
    ['https://github.com/acme/payments-api.git', 'github.com', 'acme/payments-api'],
    ['https://github.com/acme/payments-api', 'github.com', 'acme/payments-api'],
    ['https://x-token:secret@GitHub.com/acme/payments-api.git/', 'github.com', 'acme/payments-api'],
    [
      'ssh://git@gitlab.example.com:2222/group/sub/repo.git',
      'gitlab.example.com',
      'group/sub/repo',
    ],
    ['git://example.org/team/tool.git', 'example.org', 'team/tool'],
    ['/srv/git/payments-api.git', null, 'srv/git/payments-api'],
  ])('%s', (url, host, path) => {
    const remote = parseRemote(url)
    expect(remote?.host).toBe(host)
    expect(remote?.path).toBe(path)
    expect(remote?.name).toBe(path.split('/').at(-1))
    expect(remote?.display).toBe(host === null ? path : `${host}/${path}`)
  })

  it('never keeps credentials from the URL in what it displays', () => {
    expect(parseRemote('https://x-token:secret@github.com/acme/a.git')?.display).not.toContain(
      'secret',
    )
  })

  it('rejects what is not a remote', () => {
    expect(parseRemote('')).toBeNull()
    expect(parseRemote('https://github.com/')).toBeNull()
  })
})

describe('with a real repository', () => {
  let dir: string
  const run = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const commit = (message: string, env: NodeJS.ProcessEnv = process.env) =>
    execFileSync('git', ['commit', '--allow-empty', '-m', message], {
      cwd: dir,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-git-')))
    run('init', '-b', 'main')
    run('config', 'user.email', 'test@example.com')
    run('config', 'user.name', 'Test')
    run('config', 'commit.gpgsign', 'false')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports git itself', async () => {
    expect(await gitVersion(dir)).toMatch(/^\d+\.\d+/)
  })

  it('finds the repository from a subdirectory, with its remote and default branch', async () => {
    run('remote', 'add', 'origin', 'git@github.com:acme/payments-api.git')
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
    const repo = await findRepo(join(dir, 'src', 'deep'))
    expect(repo).toMatchObject({
      root: dir,
      name: 'payments-api',
      defaultBranch: 'main',
      remote: { display: 'github.com/acme/payments-api' },
    })
  })

  it('names a repository with no remote after its directory', async () => {
    const repo = await findRepo(dir)
    expect(repo?.remote).toBeNull()
    expect(repo?.name).toBe(dir.split('/').at(-1))
  })

  it('prefers what origin/HEAD points at for the default branch', async () => {
    commit('init')
    run('update-ref', 'refs/remotes/origin/trunk', 'HEAD')
    run('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    run('checkout', '-q', '-b', 'feature')
    expect(await defaultBranch(dir)).toBe('trunk')
  })

  it('is null outside any repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'yuzie-plain-'))
    try {
      expect(await findRepo(outside)).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  describe('hooks', () => {
    const hookPath = (name: string) => join(dir, '.git', 'hooks', name)

    it('installs an executable shim and reports it installed', async () => {
      const results = await installHooks(dir, ['post-commit', 'post-checkout'])
      expect(results.map((r) => [r.name, r.changed])).toEqual([
        ['post-commit', true],
        ['post-checkout', true],
      ])
      expect(readFileSync(hookPath('post-commit'), 'utf8')).toBe(
        `#!/bin/sh\n${hookBlock('post-commit')}\n`,
      )
      expect(statSync(hookPath('post-commit')).mode & 0o111).not.toBe(0)
      const status = await hookStatus(dir, ['post-commit', 'post-checkout', 'pre-push'])
      expect(status.map((s) => s.state)).toEqual(['installed', 'installed', 'missing'])
    })

    it('is idempotent: a second install changes nothing and adds no second block', async () => {
      await installHooks(dir, ['post-commit'])
      const before = readFileSync(hookPath('post-commit'), 'utf8')
      const again = await installHooks(dir, ['post-commit'])
      expect(again[0]?.changed).toBe(false)
      expect(readFileSync(hookPath('post-commit'), 'utf8')).toBe(before)
      expect(before.match(/>>> yuzie >>>/g)).toHaveLength(1)
    })

    it('keeps an existing hook’s content, and uninstall gives it back unchanged', async () => {
      const original = '#!/bin/sh\necho "lint first"\n'
      writeFileSync(hookPath('post-commit'), original)
      chmodSync(hookPath('post-commit'), 0o755)

      await installHooks(dir, ['post-commit'])
      const installed = readFileSync(hookPath('post-commit'), 'utf8')
      expect(installed.startsWith(original)).toBe(true)
      expect(installed).toContain(hookBlock('post-commit'))

      await uninstallHooks(dir, ['post-commit'])
      expect(readFileSync(hookPath('post-commit'), 'utf8')).toBe(original)
    })

    it('replaces an outdated block in place rather than adding another', async () => {
      writeFileSync(
        hookPath('post-commit'),
        '#!/bin/sh\necho mine\n# >>> yuzie >>>\nold yuzie line\n# <<< yuzie <<<\necho after\n',
      )
      expect((await hookStatus(dir, ['post-commit']))[0]?.state).toBe('outdated')
      await installHooks(dir, ['post-commit'])
      const content = readFileSync(hookPath('post-commit'), 'utf8')
      expect(content).not.toContain('old yuzie line')
      expect(content.match(/>>> yuzie >>>/g)).toHaveLength(1)
      expect(content).toContain('echo mine')
      expect(content).toContain('echo after')
    })

    it('uninstall deletes a hook that held nothing but ours', async () => {
      await installHooks(dir, ['post-checkout'])
      await uninstallHooks(dir, ['post-checkout'])
      expect(() => statSync(hookPath('post-checkout'))).toThrow()
    })

    it('honours core.hooksPath', async () => {
      run('config', 'core.hooksPath', '.githooks')
      await installHooks(dir, ['post-commit'])
      expect(readFileSync(join(dir, '.githooks', 'post-commit'), 'utf8')).toContain('>>> yuzie >>>')
    })

    it('never fails a commit: not when yuzie is missing, not when it crashes', async () => {
      await installHooks(dir, ['post-commit'])

      // No yuzie anywhere on PATH (git itself is found by absolute path).
      const gitDir = execFileSync('sh', ['-c', 'dirname "$(command -v git)"'], {
        encoding: 'utf8',
      }).trim()
      expect(() =>
        commit('without yuzie', { ...process.env, PATH: `${gitDir}:/usr/bin:/bin` }),
      ).not.toThrow()

      // A yuzie on PATH that fails loudly.
      const bin = join(dir, 'fake-bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'yuzie'), '#!/bin/sh\necho boom >&2\nexit 42\n')
      chmodSync(join(bin, 'yuzie'), 0o755)
      expect(() =>
        commit('with a broken yuzie', { ...process.env, PATH: `${bin}:${process.env.PATH}` }),
      ).not.toThrow()
      expect(run('log', '--format=%s')).toBe('with a broken yuzie\nwithout yuzie')
    })
  })
})
