/**
 * §18 Session 12: which editor `yuzie open` runs and how, what it prints when
 * it may not launch, and the web pages it finds for a card.
 */
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Card } from '@yuzie/core'
import type { Repo } from '@yuzie/git'
import { describe, expect, it } from 'vitest'
import { exitCodeFor, fixFor, RuntimeError, UsageError } from './exit.js'
import { attachedLink, canLaunch, describeTarget, editorTarget, webTarget } from './open.js'

/** A PATH holding exactly these fake editors. */
function pathWith(...programs: string[]): string {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-bin-')))
  for (const program of programs) {
    const file = join(bin, program)
    writeFileSync(file, '#!/bin/sh\nexit 0\n')
    chmodSync(file, 0o755)
  }
  return bin
}

const REPO: Repo = {
  root: '/work/payments-api',
  name: 'payments-api',
  remote: {
    url: 'git@github.com:acme/payments-api.git',
    host: 'github.com',
    path: 'acme/payments-api',
    name: 'payments-api',
    display: 'github.com/acme/payments-api',
  },
  defaultBranch: 'main',
}

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: '33333333-3333-4333-8333-000000000018',
    boardId: '11111111-1111-4111-8111-111111111111',
    number: 18,
    column: 'doing',
    rank: 'a',
    title: 'Fix GitHub OAuth',
    description: null,
    priority: null,
    dueAt: null,
    assignees: [],
    labels: [],
    watchers: [],
    checklist: [],
    comments: [],
    commits: [],
    git: null,
    anchor: { path: 'src/auth/oauth.ts', line: 42, endLine: null, commitSha: null, primary: true },
    createdBy: 'rahul',
    archivedAt: null,
    createdAt: '2026-08-19T09:00:00.000Z',
    updatedAt: '2026-08-19T09:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

describe('editor resolution for yuzie open (§9.7)', () => {
  it.each([
    ['code', ['-g', '/work/payments-api/src/auth/oauth.ts:42']],
    ['cursor', ['-g', '/work/payments-api/src/auth/oauth.ts:42']],
    ['nvim', ['+42', '/work/payments-api/src/auth/oauth.ts']],
    ['vim', ['+42', '/work/payments-api/src/auth/oauth.ts']],
    ['subl', ['/work/payments-api/src/auth/oauth.ts:42']],
  ])('%s', (program, args) => {
    const env = { PATH: pathWith(program), EDITOR: program }
    expect(editorTarget(card(), REPO, env)).toEqual({
      kind: 'editor',
      program,
      args,
      location: 'src/auth/oauth.ts:42',
    })
    // Detected from PATH too, with nothing configured.
    expect(editorTarget(card(), REPO, { PATH: pathWith(program) })).toMatchObject({ program, args })
  })

  it('an unknown $EDITOR fails with a helpful message, exit 1', () => {
    const attempt = () => editorTarget(card(), REPO, { PATH: pathWith(), EDITOR: 'nosuchedit' })
    expect(attempt).toThrow(RuntimeError)
    try {
      attempt()
    } catch (error) {
      expect(exitCodeFor(error)).toBe(1)
      expect((error as Error).message).toBe(
        'The editor "nosuchedit" (from $EDITOR) is not installed or not on PATH.',
      )
      expect(fixFor(error)).toContain('$YUZIE_EDITOR')
    }
  })

  it('no editor anywhere fails the same way', () => {
    const attempt = () => editorTarget(card(), REPO, { PATH: pathWith() })
    expect(attempt).toThrow(RuntimeError)
    expect(attempt).toThrow(/No editor found/)
  })

  it('a card without an anchor says how to add one (exit 2)', () => {
    const attempt = () => editorTarget(card({ anchor: null }), REPO, { PATH: pathWith('vim') })
    expect(attempt).toThrow(UsageError)
    expect(attempt).toThrow('#18 has no code anchor.')
  })

  it('prints as a command line', () => {
    const bin = pathWith('code')
    expect(describeTarget(editorTarget(card(), REPO, { PATH: bin, EDITOR: 'code --wait' }))).toBe(
      'code --wait -g /work/payments-api/src/auth/oauth.ts:42',
    )
  })
})

describe('never launching without a terminal, or in CI', () => {
  it.each([
    [{}, true, true],
    [{}, false, false],
    [{ CI: 'true' }, true, false],
    [{ CI: '1' }, true, false],
    [{ CI: 'false' }, true, true],
  ])('%j, tty=%s → %s', (env, tty, allowed) => {
    expect(canLaunch(env, tty)).toBe(allowed)
  })
})

describe('web pages for a card', () => {
  const branched = card({
    git: {
      branch: 'task/18-fix-github-oauth',
      baseBranch: 'main',
      commits: 1,
      filesChanged: 1,
      additions: 1,
      deletions: 0,
      pushed: true,
      prUrl: null,
      prState: null,
      lastActivityAt: null,
    },
  })
  const noGh = { PATH: pathWith() }

  it('the PR, found through the GitHub API', async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify([
          { html_url: 'https://github.com/acme/payments-api/pull/204', state: 'open' },
        ]),
        {
          status: 200,
        },
      )) as typeof fetch
    expect(
      await webTarget(branched, REPO, noGh, 'github', { baseBranch: 'main' }, fetcher),
    ).toEqual({
      kind: 'url',
      url: 'https://github.com/acme/payments-api/pull/204',
      page: 'pr',
    })
  })

  it('degrades silently to the compare view when the lookup fails', async () => {
    const failing = (async () => {
      throw new TypeError('network down')
    }) as typeof fetch
    const notFound = (async () => new Response('[]', { status: 200 })) as typeof fetch
    for (const fetcher of [failing, notFound]) {
      expect(await webTarget(branched, REPO, noGh, 'pr', { baseBranch: 'main' }, fetcher)).toEqual({
        kind: 'url',
        url: 'https://github.com/acme/payments-api/compare/main...task/18-fix-github-oauth',
        page: 'compare',
      })
    }
  })

  it('uses a PR the card already knows about, without asking', async () => {
    const known = card({
      git: {
        ...(branched.git as NonNullable<Card['git']>),
        prUrl: 'https://github.com/acme/payments-api/pull/7',
      },
    })
    const never = (async () => {
      throw new Error('should not be called')
    }) as typeof fetch
    expect(
      await webTarget(known, REPO, noGh, 'github', { baseBranch: 'main' }, never),
    ).toMatchObject({
      url: 'https://github.com/acme/payments-api/pull/7',
    })
  })

  it('--browser: the first link on the card', async () => {
    const linked = card({
      description: 'Spec: https://docs.acme.dev/oauth#state. Details below.',
    })
    expect(attachedLink(linked)).toBe('https://docs.acme.dev/oauth#state')
    expect(await webTarget(linked, REPO, noGh, 'browser', { baseBranch: 'main' })).toEqual({
      kind: 'url',
      url: 'https://docs.acme.dev/oauth#state',
      page: 'link',
    })
    await expect(webTarget(card(), REPO, noGh, 'browser', { baseBranch: 'main' })).rejects.toThrow(
      'no link attached',
    )
  })

  it('a card with no branch says how to get one', async () => {
    await expect(webTarget(card(), REPO, noGh, 'github', { baseBranch: 'main' })).rejects.toThrow(
      'has no branch yet',
    )
  })
})
