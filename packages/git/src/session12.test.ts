/**
 * §18 Session 12: web URLs from every remote shape, anchor normalisation, and
 * stale-anchor detection in a real repository.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AnchorError,
  anchorStale,
  branchUrl,
  compareUrl,
  normaliseAnchor,
  pullsApiUrl,
  webRepo,
} from './index.js'
import { type FixtureRepo, fixtureRepo } from './testing.js'

describe('web URLs from remotes', () => {
  it.each([
    ['git@github.com:acme/payments-api.git', 'github', 'https://github.com/acme/payments-api'],
    ['https://github.com/acme/payments-api.git', 'github', 'https://github.com/acme/payments-api'],
    [
      'https://x-token:secret@github.com/acme/payments-api',
      'github',
      'https://github.com/acme/payments-api',
    ],
    [
      'ssh://git@github.com/acme/payments-api.git',
      'github',
      'https://github.com/acme/payments-api',
    ],
    ['git@gitlab.com:group/sub/repo.git', 'gitlab', 'https://gitlab.com/group/sub/repo'],
    ['https://gitlab.com/group/sub/repo.git', 'gitlab', 'https://gitlab.com/group/sub/repo'],
    [
      'ssh://git@gitlab.acme.dev:2222/platform/api.git',
      'gitlab',
      'https://gitlab.acme.dev/platform/api',
    ],
    ['https://git.acme.dev:8443/team/tool.git', 'unknown', 'https://git.acme.dev:8443/team/tool'],
    ['http://git.internal:3000/team/tool', 'unknown', 'http://git.internal:3000/team/tool'],
    ['git@bitbucket.org:acme/api.git', 'bitbucket', 'https://bitbucket.org/acme/api'],
  ])('%s', (remote, forge, base) => {
    expect(webRepo(remote)).toMatchObject({ forge, base })
  })

  it('never keeps credentials', () => {
    expect(webRepo('https://x-token:secret@github.com/acme/a.git')?.base).not.toContain('secret')
  })

  it('has nothing for a local path or a bare host', () => {
    expect(webRepo('/srv/git/repo.git')).toBeNull()
    expect(webRepo('file:///srv/git/repo.git')).toBeNull()
    expect(webRepo('https://github.com/')).toBeNull()
  })

  it('builds branch and compare pages per forge', () => {
    const gh = webRepo('git@github.com:acme/payments-api.git')
    const gl = webRepo('git@gitlab.com:group/sub/repo.git')
    const bb = webRepo('git@bitbucket.org:acme/api.git')
    const own = webRepo('ssh://git@git.acme.dev:2222/team/tool.git')
    if (gh === null || gl === null || bb === null || own === null) throw new Error('parse')
    expect(branchUrl(gh, 'task/18-fix-oauth')).toBe(
      'https://github.com/acme/payments-api/tree/task/18-fix-oauth',
    )
    expect(compareUrl(gh, 'main', 'task/18-fix-oauth')).toBe(
      'https://github.com/acme/payments-api/compare/main...task/18-fix-oauth',
    )
    expect(compareUrl(gl, 'main', 'task/18-x')).toBe(
      'https://gitlab.com/group/sub/repo/-/compare/main...task/18-x',
    )
    expect(branchUrl(gl, 'task/18-x')).toBe('https://gitlab.com/group/sub/repo/-/tree/task/18-x')
    expect(compareUrl(bb, 'main', 'task/18-x')).toBe(
      'https://bitbucket.org/acme/api/branches/compare/task/18-x%0Dmain',
    )
    expect(compareUrl(own, 'main', 'feat/a b#c')).toBe(
      'https://git.acme.dev/team/tool/compare/main...feat/a%20b%23c',
    )
  })

  it('knows where GitHub and GitHub Enterprise list pull requests', () => {
    const gh = webRepo('git@github.com:acme/payments-api.git')
    const ghe = webRepo('https://github.acme.dev:8443/acme/payments-api.git')
    const gl = webRepo('git@gitlab.com:group/repo.git')
    if (gh === null || ghe === null || gl === null) throw new Error('parse')
    expect(pullsApiUrl(gh, 'task/18')).toBe(
      'https://api.github.com/repos/acme/payments-api/pulls?head=acme%3Atask%2F18&state=all&per_page=1',
    )
    expect(pullsApiUrl(ghe, 'task/18')).toMatch(
      /^https:\/\/github\.acme\.dev:8443\/api\/v3\/repos\/acme\/payments-api\/pulls\?/,
    )
    expect(pullsApiUrl(gl, 'task/18')).toBeNull()
  })
})

const repos: FixtureRepo[] = []
afterEach(() => {
  for (const repo of repos.splice(0)) repo.remove()
})

function repo(): FixtureRepo {
  const made = fixtureRepo()
  repos.push(made)
  made.commit('code', {
    'src/auth/oauth.ts': `${Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')}\n`,
  })
  return made
}

describe('normaliseAnchor', () => {
  it('stores paths relative to the repository root, from anywhere inside it', async () => {
    const r = repo()
    mkdirSync(join(r.root, 'src', 'deep'), { recursive: true })
    expect(
      await normaliseAnchor(r.root, join(r.root, 'src'), { path: 'auth/oauth.ts', line: 42 }),
    ).toMatchObject({
      path: 'src/auth/oauth.ts',
      line: 42,
      endLine: null,
    })
    expect(
      await normaliseAnchor(r.root, join(r.root, 'src', 'deep'), {
        path: '../auth/oauth.ts',
        line: 1,
        endLine: 50,
      }),
    ).toMatchObject({ path: 'src/auth/oauth.ts', line: 1, endLine: 50 })
    expect(
      await normaliseAnchor(r.root, '/', { path: join(r.root, 'src/auth/oauth.ts') }),
    ).toMatchObject({ path: 'src/auth/oauth.ts', line: null })
  })

  it('refuses what is not there', async () => {
    const r = repo()
    const bad = (input: { path: string; line?: number; endLine?: number }) =>
      normaliseAnchor(r.root, r.root, input)
    await expect(bad({ path: 'src/nope.ts' })).rejects.toThrow('src/nope.ts does not exist')
    await expect(bad({ path: 'src' })).rejects.toThrow('is not a file')
    await expect(bad({ path: '../outside.ts' })).rejects.toThrow('outside the repository')
    await expect(bad({ path: 'src/auth/oauth.ts', line: 51 })).rejects.toThrow('has 50 lines')
    await expect(bad({ path: 'src/auth/oauth.ts', line: 10, endLine: 9 })).rejects.toThrow(
      'ends before it starts',
    )
    await expect(bad({ path: 'src/auth/oauth.ts', line: 10, endLine: 60 })).rejects.toBeInstanceOf(
      AnchorError,
    )
  })
})

describe('anchorStale', () => {
  it('false while the file matches the anchor commit; true once it changes', async () => {
    const r = repo()
    const sha = r.git('rev-parse', 'HEAD')
    const anchor = { path: 'src/auth/oauth.ts', commitSha: sha }
    expect(await anchorStale(r.root, anchor)).toBe(false)

    // Another file changing does not matter.
    r.commit('elsewhere', { 'README.md': 'changed\n' })
    expect(await anchorStale(r.root, anchor)).toBe(false)

    // This one changing does — committed or not.
    r.write('src/auth/oauth.ts', `line 0\n${'x\n'.repeat(50)}`)
    expect(await anchorStale(r.root, anchor)).toBe(true)
    r.commit('edit the anchored file')
    expect(await anchorStale(r.root, anchor)).toBe(true)
  })

  it('true when the file is gone; unknown without a commit or with one this clone lacks', async () => {
    const r = repo()
    const sha = r.git('rev-parse', 'HEAD')
    expect(await anchorStale(r.root, { path: 'src/auth/oauth.ts', commitSha: null })).toBeNull()
    expect(
      await anchorStale(r.root, { path: 'src/auth/oauth.ts', commitSha: 'f'.repeat(40) }),
    ).toBeNull()
    r.git('rm', '-q', 'src/auth/oauth.ts')
    expect(await anchorStale(r.root, { path: 'src/auth/oauth.ts', commitSha: sha })).toBe(true)
  })
})
