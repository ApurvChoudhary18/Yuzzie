/**
 * The Git layer behind `claim`, `start`, `finish` and the hooks (§18 Session 11):
 * every repository state the acceptance lists, in real temp repositories.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BranchError,
  cardForCommit,
  cardFromBranch,
  commitAt,
  commitsBetween,
  currentBranch,
  diffStats,
  dirtyFiles,
  EditorNotFoundError,
  findRepo,
  head,
  lineArgs,
  localBranchExists,
  remoteBranchExists,
  resolveEditor,
  splitCommand,
  summarize,
  switchToBranch,
  upstreamState,
} from './index.js'
import { type FixtureRepo, fixtureRepo, plainDirectory } from './testing.js'

const repos: Array<{ remove(): void }> = []
afterEach(() => {
  for (const repo of repos.splice(0)) repo.remove()
})

function repo(options: Parameters<typeof fixtureRepo>[0] = {}): FixtureRepo {
  const made = fixtureRepo(options)
  repos.push(made)
  return made
}

describe('repository states', () => {
  it('clean tree: on its branch, nothing dirty', async () => {
    const r = repo()
    expect(await head(r.root)).toEqual({ kind: 'branch', name: 'main' })
    expect(await dirtyFiles(r.root)).toEqual([])
  })

  it('dirty tree: modified and untracked files both count', async () => {
    const r = repo()
    r.write('README.md', 'changed\n')
    r.write('new.ts')
    expect((await dirtyFiles(r.root)).sort()).toEqual(['README.md', 'new.ts'])
  })

  it('detached HEAD: no current branch', async () => {
    const r = repo()
    const sha = r.git('rev-parse', 'HEAD')
    r.git('checkout', '-q', '--detach')
    expect(await head(r.root)).toEqual({ kind: 'detached', sha })
    expect(await currentBranch(r.root)).toBeNull()
  })

  it('no commits yet: HEAD is unborn, not detached', async () => {
    const r = repo({ initialCommit: false })
    expect(await head(r.root)).toEqual({ kind: 'unborn', name: 'main' })
  })

  it('not a repository', async () => {
    const plain = plainDirectory()
    repos.push(plain)
    expect(await findRepo(plain.root)).toBeNull()
  })
})

describe('switchToBranch', () => {
  it('creates the branch from the base when it exists nowhere', async () => {
    const r = repo()
    expect(await switchToBranch(r.root, 'task/18-fix-oauth', 'main')).toBe('created')
    expect(await currentBranch(r.root)).toBe('task/18-fix-oauth')
  })

  it('checks out an existing local branch instead of creating it', async () => {
    const r = repo()
    r.git('branch', 'task/18-fix-oauth')
    expect(await switchToBranch(r.root, 'task/18-fix-oauth', 'main')).toBe('checked-out')
    expect(await currentBranch(r.root)).toBe('task/18-fix-oauth')
  })

  it('fetches and tracks a branch that exists only on the remote', async () => {
    const r = repo({ remote: true })
    r.git('checkout', '-q', '-b', 'task/18-fix-oauth')
    r.commit('work elsewhere', { 'a.ts': 'a\n' })
    r.git('push', '-q', 'origin', 'task/18-fix-oauth')
    r.git('checkout', '-q', 'main')
    r.git('branch', '-q', '-D', 'task/18-fix-oauth')
    r.git('update-ref', '-d', 'refs/remotes/origin/task/18-fix-oauth')

    expect(await localBranchExists(r.root, 'task/18-fix-oauth')).toBe(false)
    expect(await remoteBranchExists(r.root, 'task/18-fix-oauth')).toBe(true)
    expect(await switchToBranch(r.root, 'task/18-fix-oauth', 'main')).toBe('tracked')
    expect((await upstreamState(r.root, 'task/18-fix-oauth')).upstream).toBe(
      'origin/task/18-fix-oauth',
    )
  })

  it('without a remote, only local branches count', async () => {
    const r = repo()
    expect(await remoteBranchExists(r.root, 'anything')).toBe(false)
  })

  it('is a no-op on the current branch', async () => {
    const r = repo()
    expect(await switchToBranch(r.root, 'main', 'main', { current: 'main' })).toBe('current')
  })

  it('branches from origin/<base> when there is no local base', async () => {
    const r = repo({ remote: true })
    r.git('checkout', '-q', '-b', 'scratch')
    r.git('branch', '-q', '-D', 'main')
    expect(await switchToBranch(r.root, 'task/2-x', 'main')).toBe('created')
  })

  it('says so when the base does not exist anywhere', async () => {
    const r = repo()
    await expect(switchToBranch(r.root, 'task/2-x', 'develop')).rejects.toBeInstanceOf(BranchError)
  })

  it('carries uncommitted changes across, as git does', async () => {
    const r = repo()
    r.write('wip.ts')
    await switchToBranch(r.root, 'task/3-x', 'main')
    expect(await dirtyFiles(r.root)).toEqual(['wip.ts'])
  })
})

describe('commits and summaries', () => {
  it('lists base..branch commits and derives the §9.1 summary', async () => {
    const r = repo({ remote: true })
    r.git('checkout', '-q', '-b', 'task/18-fix-oauth')
    r.commit('fix: callback state #18', { 'src/auth.ts': 'a\nb\nc\n' })
    r.commit('test: regression\n\nBoard-Card: 18', { 'src/auth.test.ts': 'x\n' })

    const commits = await commitsBetween(r.root, 'main', 'task/18-fix-oauth')
    expect(commits.map((commit) => commit.subject)).toEqual([
      'test: regression',
      'fix: callback state #18',
    ])
    expect(commits[0]?.message).toContain('Board-Card: 18')
    expect(commits[0]?.authorEmail).toBe('fixture@example.test')

    expect(await diffStats(r.root, 'main', 'task/18-fix-oauth')).toEqual({
      filesChanged: 2,
      additions: 4,
      deletions: 0,
    })
    const unpushed = await summarize(r.root, 'main', 'task/18-fix-oauth')
    expect(unpushed).toMatchObject({ commits: 2, filesChanged: 2, pushed: false })
    expect(unpushed?.lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    r.git('push', '-q', '-u', 'origin', 'task/18-fix-oauth')
    expect(await summarize(r.root, 'main', 'task/18-fix-oauth')).toMatchObject({ pushed: true })
    r.commit('more', { 'src/more.ts': 'm\n' })
    expect(await upstreamState(r.root, 'task/18-fix-oauth')).toMatchObject({ ahead: 1 })
    expect(await summarize(r.root, 'main', 'task/18-fix-oauth')).toMatchObject({ pushed: false })
  })

  it('reads the commit just made', async () => {
    const r = repo()
    const sha = r.commit('feat: thing\n\nlonger body #7')
    expect(await commitAt(r.root)).toMatchObject({ sha, subject: 'feat: thing' })
  })

  it('has no summary for a branch that does not exist', async () => {
    const r = repo()
    expect(await summarize(r.root, 'main', 'nope')).toBeNull()
  })
})

describe('commit → card resolution (§9.6)', () => {
  const template = 'task/{id}-{slug}'
  const resolve = (message: string, branch: string | null = null, claimed: number[] = []) =>
    cardForCommit({ message, branch, template, claimed })

  it('1. an explicit Board-Card trailer wins over everything', () => {
    expect(resolve('fix #3\n\nBoard-Card: 18', 'task/7-x', [9])).toEqual({
      cardNo: 18,
      rule: 'trailer',
    })
    expect(resolve('x\n\nboard-card: #21')).toEqual({ cardNo: 21, rule: 'trailer' })
  })

  it('2. then #id anywhere in the subject or body', () => {
    expect(resolve('fix: oauth (#18)', 'task/7-x', [9])).toEqual({ cardNo: 18, rule: 'mention' })
    expect(resolve('subject\n\nCloses #22.')).toEqual({ cardNo: 22, rule: 'mention' })
  })

  it('…but not HTML entities, URL fragments or words', () => {
    expect(resolve('escape &#18; and see http://x.dev/page#section1 and a#9')).toBeNull()
  })

  it('3. then the branch name, matched against the template', () => {
    expect(resolve('wip', 'task/18-fix-github-oauth', [9])).toEqual({
      cardNo: 18,
      rule: 'branch',
    })
    expect(cardFromBranch('rahul/31-thing', '{user}/{id}-{slug}')).toBe(31)
    expect(cardFromBranch('feat/7-a-2fa-thing', 'feat/{id}-{slug}')).toBe(7)
    expect(cardFromBranch('main', template)).toBeNull()
    expect(cardFromBranch('task/x-18', template)).toBeNull()
  })

  it('4. then the one card you have in progress, only if exactly one', () => {
    expect(resolve('wip', 'main', [9])).toEqual({ cardNo: 9, rule: 'claimed' })
    expect(resolve('wip', 'main', [9, 10])).toBeNull()
    expect(resolve('wip', 'main', [])).toBeNull()
  })
})

describe('editor resolution (§9.7)', () => {
  const nothing = () => false

  it('YUZIE_EDITOR, then VISUAL, then EDITOR', () => {
    const env = { YUZIE_EDITOR: 'code --wait', VISUAL: 'vim', EDITOR: 'nano' }
    expect(resolveEditor(env, 'a.ts', 42, nothing)).toEqual({
      program: 'code',
      args: ['--wait', '-g', 'a.ts:42'],
      source: 'YUZIE_EDITOR',
    })
    expect(resolveEditor({ VISUAL: 'nvim', EDITOR: 'nano' }, 'a.ts', 42, nothing)).toMatchObject({
      program: 'nvim',
      args: ['+42', 'a.ts'],
      source: 'VISUAL',
    })
    expect(resolveEditor({ EDITOR: 'nano' }, 'a.ts', null, nothing)).toMatchObject({
      args: ['a.ts'],
      source: 'EDITOR',
    })
  })

  it('detects code, cursor, subl, nvim, vim in that order', () => {
    const has = (names: string[]) => (program: string) => names.includes(program)
    expect(resolveEditor({}, 'a.ts', 3, has(['vim', 'subl'])).program).toBe('subl')
    expect(resolveEditor({}, 'a.ts', 3, has(['vim'])).args).toEqual(['+3', 'a.ts'])
    expect(() => resolveEditor({}, 'a.ts', 3, nothing)).toThrow(EditorNotFoundError)
  })

  it('knows each editor’s line syntax', () => {
    expect(lineArgs('cursor', 'a.ts', 9)).toEqual(['-g', 'a.ts:9'])
    expect(lineArgs('/usr/local/bin/subl', 'a.ts', 9)).toEqual(['a.ts:9'])
    expect(lineArgs('idea', 'a.ts', 9)).toEqual(['--line', '9', 'a.ts'])
    expect(lineArgs('emacs', 'a.ts', 9)).toEqual(['+9', 'a.ts'])
  })

  it('splits a configured command, honouring quotes', () => {
    expect(splitCommand('"/Applications/My Editor/bin/ed" --wait')).toEqual([
      '/Applications/My Editor/bin/ed',
      '--wait',
    ])
  })
})

describe('dirtyFiles edge cases', () => {
  it('keeps names intact: spaces, renames, a leading-space status line', async () => {
    const r = repo()
    r.commit('files', { 'old name.ts': 'o\n', 'keep.ts': 'k\n' })
    r.git('mv', 'old name.ts', 'new name.ts')
    r.write('keep.ts', 'changed\n')
    expect((await dirtyFiles(r.root)).sort()).toEqual(['keep.ts', 'new name.ts'])
  })
})
