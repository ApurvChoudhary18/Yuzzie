/**
 * §18 Session 11 against a real server and real repositories: `claim` and
 * `start` in every repository state the acceptance lists, the post-commit
 * hook through each §9.6 resolution rule (and with the server gone), `branch`,
 * `commits`, `finish`, and Journey B (§6.2) with its printed receipt.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type OutputKind, parseOutput } from '@yuzie/core'
import { type FixtureRepo, fixtureRepo, plainDirectory } from '@yuzie/git/testing'
import { createClient } from '@yuzie/sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type CliResult,
  type Machine,
  machine,
  start,
  withYuzieOnPath,
  yuzie,
} from './__support__/cli.js'
import { startWorld, unique, type World } from './__support__/world.js'

let world: World
let computer: Machine
let repo: FixtureRepo
let slug: string
const cleanup: Array<() => void> = []

async function approve(userCode: string, handle: string): Promise<void> {
  const response = await fetch(`${world.baseUrl}/auth/device/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userCode, handle }),
  })
  if (response.status !== 200) throw new Error(`approve failed: ${response.status}`)
}

async function signInAs(target: Machine, cwd: string, handle: string): Promise<void> {
  const running = start(['login'], { cwd, env: target.env })
  const [, code] = await running.waitFor(/Code: (\S+)/)
  await approve(code as string, handle)
  const result = await running.done
  if (result.code !== 0) throw new Error(`login failed: ${result.stderr}`)
}

function run(
  args: string[],
  options: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  return yuzie(args, {
    cwd: options.cwd ?? repo.root,
    env: { ...computer.env, ...options.env },
    ...(options.input === undefined ? {} : { input: options.input }),
  })
}

async function json(args: string[], kind: OutputKind) {
  const result = await run([...args, '--json'])
  expect(result.code, `${args.join(' ')}: ${result.stdout}${result.stderr}`).toBe(0)
  const document = JSON.parse(result.stdout) as { kind: string; data: never }
  expect(document.kind).toBe(kind)
  parseOutput(document)
  return document.data
}

/** A real `git commit`, hooks and all, as a person would run it. */
function commit(
  message: string,
  files: Record<string, string> = {},
): { stdout: string; ms: number } {
  for (const [path, content] of Object.entries(files)) repo.write(path, content)
  repo.git('add', '--all')
  const started = performance.now()
  const result = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', message], {
    cwd: repo.root,
    env: {
      ...computer.env,
      GIT_AUTHOR_NAME: 'R',
      GIT_AUTHOR_EMAIL: 'r@x',
      GIT_COMMITTER_NAME: 'R',
      GIT_COMMITTER_EMAIL: 'r@x',
    },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`git commit failed: ${result.stderr}`)
  return { stdout: `${result.stdout}${result.stderr}`, ms: performance.now() - started }
}

async function card(number: number) {
  return (await json(['card', String(number)], 'Card')) as {
    number: number
    column: string
    assignees: string[]
    git: { branch: string | null } | null
    commits: Array<{ sha: string }>
  }
}

const eventually = async (check: () => Promise<boolean>, what: string) => {
  const until = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

beforeAll(async () => {
  world = await startWorld({ devicePollIntervalSeconds: 1 })
  computer = withYuzieOnPath(machine(world.baseUrl))
  cleanup.push(() => rmSync(computer.home, { recursive: true, force: true }))
}, 120_000)

afterAll(async () => {
  for (const step of cleanup.splice(0)) step()
  await world.close()
})

/** A fresh repository with an origin, a board, and hooks, for each test. */
beforeEach(async () => {
  repo = fixtureRepo({ remote: true })
  cleanup.push(() => repo.remove())
  if (slug === undefined) await signInAs(computer, repo.root, 'rahul')
  const init = await run(['init', '--yes'])
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`)
  slug = (
    JSON.parse(readFileSync(join(repo.root, '.yuzie', 'config.json'), 'utf8')) as { board: string }
  ).board
  await run(['config', 'set', 'git.hooks', '["post-commit","post-checkout","pre-push"]'])
  await run(['hooks', 'install'])
  repo.git('add', '--all')
  repo.git('-c', 'user.name=R', '-c', 'user.email=r@x', 'commit', '-q', '-m', 'chore: yuzie config')
  for (const title of ['Fix GitHub OAuth', 'Rate limits', 'Onboarding docs', 'Flaky test'])
    await run(['add', title])
}, 60_000)

describe('claim (§9.3)', () => {
  it('on a clean tree: assigns, moves, creates and checks out the branch, links it', async () => {
    const result = await run(['claim', '1'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe(
      [
        '✓ #1 assigned to @rahul',
        '✓ Moved to Doing',
        '✓ Created branch task/1-fix-github-oauth',
        '✓ Checked out task/1-fix-github-oauth',
        '',
      ].join('\n'),
    )
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/1-fix-github-oauth')
    expect(await card(1)).toMatchObject({
      column: 'doing',
      assignees: ['rahul'],
      git: { branch: 'task/1-fix-github-oauth' },
    })
  })

  it('under --json, one Claim document', async () => {
    const data = (await json(['claim', '2'], 'Claim')) as { branch: string; branchAction: string }
    expect(data).toMatchObject({ branch: 'task/2-rate-limits', branchAction: 'created' })
  })

  it('on a dirty tree: exits 8 under --yes, carries the changes with --force', async () => {
    repo.write('wip.ts', 'unsaved\n')
    const refused = await run(['claim', '1', '--yes'])
    expect(refused.code).toBe(8)
    expect(refused.stderr).toContain('1 uncommitted file')
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')

    const forced = await run(['claim', '1', '--yes', '--force'])
    expect(forced.code, forced.stderr).toBe(0)
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/1-fix-github-oauth')
    expect(repo.git('status', '--porcelain')).toContain('wip.ts')
  })

  it('on a dirty tree, interactively: stash, stay on this branch, or abort', async () => {
    repo.write('wip.ts', 'unsaved\n')
    const aborted = await run(['claim', '1'], { input: '3\n' })
    expect(aborted.code).toBe(8)
    expect(aborted.stdout).toContain('What now?')

    const stayed = await run(['claim', '2'], { input: '2\n' })
    expect(stayed.code, stayed.stderr).toBe(0)
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(stayed.stdout).toContain('#2 assigned to @rahul')

    const stashed = await run(['claim', '1'], { input: '1\n' })
    expect(stashed.code, stashed.stderr).toBe(0)
    expect(stashed.stdout).toContain('✓ Stashed 1 change')
    expect(repo.git('stash', 'list')).toContain('yuzie: before claiming #1')
    expect(repo.git('status', '--porcelain')).toBe('')
  })

  it('on a dirty tree with no answer given: exits 8 and stashes nothing', async () => {
    repo.write('wip.ts', 'unsaved\n')
    const result = await run(['claim', '1'], { input: '' })
    expect(result.code).toBe(8)
    expect(result.stderr).toContain('no answer was given')
    expect(repo.git('stash', 'list')).toBe('')
    expect(repo.git('status', '--porcelain')).toContain('wip.ts')
  })

  it('on a detached HEAD: exits 8 and touches nothing', async () => {
    repo.git('checkout', '-q', '--detach')
    const result = await run(['claim', '1'])
    expect(result.code).toBe(8)
    expect(result.stderr).toContain('HEAD is detached')
    expect((await card(1)).assignees).toEqual([])
  })

  it('checks out a branch that already exists locally', async () => {
    repo.git('branch', 'task/1-fix-github-oauth')
    const result = await run(['claim', '1'])
    expect(result.stdout).toContain('✓ Checked out existing branch task/1-fix-github-oauth')
  })

  it('tracks a branch that exists only on the remote', async () => {
    repo.git('checkout', '-q', '-b', 'task/1-fix-github-oauth')
    repo.commit('started elsewhere', { 'elsewhere.ts': 'x\n' })
    repo.git('push', '-q', 'origin', 'task/1-fix-github-oauth')
    repo.git('checkout', '-q', 'main')
    repo.git('branch', '-q', '-D', 'task/1-fix-github-oauth')
    repo.git('update-ref', '-d', 'refs/remotes/origin/task/1-fix-github-oauth')

    const result = await run(['claim', '1'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('✓ Tracking origin/task/1-fix-github-oauth')
    expect(repo.git('rev-parse', '--abbrev-ref', '@{upstream}')).toBe(
      'origin/task/1-fix-github-oauth',
    )
  })

  it('works with no remote at all', async () => {
    repo.git('remote', 'remove', 'origin')
    const result = await run(['claim', '1'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('✓ Created branch task/1-fix-github-oauth')
  })

  it('outside a repository: claims without a branch, and says so', async () => {
    const plain = plainDirectory()
    cleanup.push(() => plain.remove())
    const result = await run(['claim', '1', '--board', slug], { cwd: plain.root })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('Not in a Git repository')
    expect(result.stdout).toContain('#1 assigned to @rahul')
  })

  it('--no-branch leaves Git alone', async () => {
    const result = await run(['claim', '1', '--no-branch'])
    expect(result.code).toBe(0)
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  it('exits 4 for a card that does not exist', async () => {
    expect((await run(['claim', '99'])).code).toBe(4)
  })

  it('with the server gone: the branch is still made, and the writes queue', async () => {
    const offline = await run(['claim', '1', '--offline'])
    expect(offline.code, offline.stderr).toBe(0)
    expect(offline.stdout).toContain('queued (offline)')
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/1-fix-github-oauth')
  })
})

describe('start', () => {
  it('checks out the card’s existing branch, and creates none', async () => {
    const without = await run(['start', '1'])
    expect(without.code).toBe(0)
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')

    repo.git('branch', 'task/2-rate-limits')
    const with_ = await run(['start', '2'])
    expect(with_.stdout).toContain('Checked out existing branch task/2-rate-limits')
  })
})

describe('the post-commit hook (§9.5, §9.6)', () => {
  it('rule 1: a Board-Card trailer', async () => {
    const { stdout } = commit('chore: tidy\n\nBoard-Card: 2')
    expect(stdout).toMatch(/\[yuzie\] linked commit [0-9a-f]{7} → #2/)
    await eventually(async () => (await card(2)).commits.length === 1, 'the commit on #2')
  })

  it('rule 2: #id in the message', async () => {
    const { stdout } = commit('fix: flaky retry (#4)')
    expect(stdout).toContain('→ #4')
    await eventually(async () => (await card(4)).commits.length === 1, 'the commit on #4')
  })

  it('rule 3: the branch name', async () => {
    repo.git('checkout', '-q', '-b', 'task/3-onboarding-docs')
    const { stdout } = commit('docs: first draft', { 'docs.md': 'hi\n' })
    expect(stdout).toContain('→ #3')
  })

  it('rule 4: the one card you have in progress', async () => {
    await run(['claim', '1', '--no-branch'])
    const { stdout } = commit('wip: no number anywhere')
    expect(stdout).toContain('→ #1')
    await eventually(async () => (await card(1)).commits.length === 1, 'the commit on #1')
  })

  it('nothing to go on: no line, and the commit is kept for later', async () => {
    const { stdout } = commit('wip: who knows')
    expect(stdout).not.toContain('[yuzie]')
    expect(repo.git('show', '-s', '--format=%s')).toBe('wip: who knows')
  })

  it('never fails or holds up a commit when the server is gone', async () => {
    await world.stop()
    try {
      const { stdout, ms } = commit('fix: offline work #2')
      expect(stdout).toContain('→ #2')
      expect(ms).toBeLessThan(3_000)
    } finally {
      await world.restart()
    }
  })

  it('install twice: identical hook files', async () => {
    const hooks = repo.git('rev-parse', '--path-format=absolute', '--git-path', 'hooks')
    const read = () =>
      execFileSync('cat', [`${hooks}/post-commit`, `${hooks}/pre-push`], { encoding: 'utf8' })
    const before = read()
    await run(['hooks', 'install'])
    expect(read()).toBe(before)
  })
})

describe('branch, commits, finish', () => {
  it('branch prints, creates and links', async () => {
    expect((await run(['branch', '2'])).stdout).toBe('task/2-rate-limits\n')
    const created = (await json(['branch', '2', '--create'], 'Branch')) as { linked: boolean }
    expect(created.linked).toBe(true)
    expect(repo.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/2-rate-limits')
    const linked = await run(['branch', '3', '--link', 'feature/docs'])
    expect(linked.stdout).toContain('Linked #3 to feature/docs')
    expect((await card(3)).git?.branch).toBe('feature/docs')
  })

  it('commits lists attached commits, and local ones not attached yet', async () => {
    await run(['claim', '1'])
    commit('fix: state param #1', { 'a.ts': 'a\n' })
    await eventually(async () => (await card(1)).commits.length === 1, 'attached')
    const listed = await run(['commits', '1'])
    expect(listed.stdout).toContain('fix: state param #1')
    const data = (await json(['commits', '1'], 'CommitList')) as Array<{ attached: boolean }>
    expect(data.every((row) => row.attached)).toBe(true)
  })

  it('finish: every check passes, the card moves to Review with its git summary', async () => {
    await run(['claim', '1'])
    commit('fix: it #1', { 'fix.ts': 'fixed\n' })
    const result = await run(['finish', '1', '--push'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('✓ Working tree clean')
    expect(result.stdout).toContain('✓ 1 commit on task/1-fix-github-oauth')
    expect(result.stdout).toContain('✓ Pushed to origin/task/1-fix-github-oauth')
    expect(result.stdout).toContain('✓ #1 → Review')
    const finished = (await json(['card', '1'], 'Card')) as {
      column: string
      git: { commits: number; pushed: boolean }
    }
    expect({ column: finished.column, git: finished.git }).toMatchObject({
      column: 'review',
      git: { commits: 1, pushed: true },
    })
  })

  it('finish: a failing check asks; exits 8 under --yes; --skip-checks goes anyway', async () => {
    await run(['claim', '1'])
    const refused = await run(['finish', '1', '--yes'])
    expect(refused.code).toBe(8)
    expect(refused.stderr).toContain('did not pass')
    const declined = await run(['finish', '1'], { input: 'n\n' })
    expect(declined.code).toBe(8)
    expect(declined.stdout).toContain('? Continue anyway? (y/N)')
    const skipped = (await json(['finish', '1', '--skip-checks'], 'Finish')) as {
      column: string
      skipped: boolean
    }
    expect(skipped).toMatchObject({ column: 'review', skipped: true })
  })

  it('finish runs checks.test and reports it', async () => {
    await run(['config', 'set', 'checks.test', 'exit 3'])
    repo.git(
      '-c',
      'user.name=R',
      '-c',
      'user.email=r@x',
      'commit',
      '-q',
      '-am',
      'chore: test command',
    )
    await run(['claim', '1'])
    commit('fix #1', { 'x.ts': 'x\n' })
    const result = await run(['finish', '1', '--yes'])
    expect(result.code).toBe(8)
    expect(result.stdout).toContain('⚠ Tests failed (exit 3)')
  })
})

describe('Journey B (§6.2)', () => {
  it('claim → commit → comment → move → finish, as printed in the spec', async () => {
    // Card #18 on a board with four teammates.
    const teammates = ['priya', 'adarsh', 'sam', 'lee'].map((name) => unique(name))
    for (const handle of teammates) {
      const other = machine(world.baseUrl)
      cleanup.push(() => rmSync(other.home, { recursive: true, force: true }))
      await signInAs(other, repo.root, handle)
      await run(['invite', `@${handle}`])
    }
    const token = execFileSync('cat', [`${computer.home}/.yuzie/credentials`], { encoding: 'utf8' })
    const board = await createClient({
      baseUrl: world.baseUrl,
      token: (JSON.parse(token) as { servers: Record<string, { token: string }> }).servers[
        world.baseUrl
      ]?.token as string,
    }).connect(slug, { realtime: false })
    for (let n = 5; n < 18; n += 1) await board.cards.create({ title: `Filler ${n}` })
    await board.cards.create({ title: 'Fix GitHub OAuth' })
    await board.close()

    const claimed = await run(['claim', '18'])
    expect(claimed.stdout).toBe(
      [
        '✓ #18 assigned to @rahul',
        '✓ Moved to Doing',
        '✓ Created branch task/18-fix-github-oauth',
        '✓ Checked out task/18-fix-github-oauth',
        '✓ Broadcast to 4 teammates',
        '',
      ].join('\n'),
    )

    const committed = commit('fix: handle oauth callback state mismatch', { 'oauth.ts': 'fixed\n' })
    expect(committed.stdout).toMatch(/^\[yuzie\] linked commit [0-9a-f]{7} → #18$/m)

    expect(
      (await run(['comment', '18', 'Callback was dropping the state param. Fixed.'])).code,
    ).toBe(0)
    expect((await run(['move', '18', 'review'])).code).toBe(0)

    repo.write('scratch-1.ts', 'x\n')
    repo.write('scratch-2.ts', 'y\n')
    const finished = await run(['finish', '18'], { input: 'n\n' })
    expect(finished.stdout).toContain('⚠ Branch task/18-fix-github-oauth has 2 uncommitted files')
    expect(finished.stdout).toContain('? Continue anyway? (y/N)')
    expect(finished.code).toBe(8)
  })
})
