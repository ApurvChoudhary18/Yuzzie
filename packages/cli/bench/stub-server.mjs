/**
 * A Yuzie API that answers instantly with a fixed board (SPEC.md §18 Session 16).
 *
 * The startup budget (`yuzie list --json` under 150 ms, §10.4) is about the
 * CLI's own cost — starting Node, loading code, reading the cache, making its
 * requests — so it is measured against a server that costs nothing. Used by the
 * startup bench and by `bench/startup-budget.mjs` (hyperfine in CI).
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebalance } from '@yuzie/core'

const BOARD_ID = '11111111-1111-4111-8111-111111111111'
const T0 = '2026-08-19T09:00:00.000Z'
const hex = (n) => String(n).padStart(12, '0')

export const SLUG = 'bench'
export const TOKEN = 'yz_bench_token'

function column(key, name, index, semantics) {
  return {
    id: `66666666-6666-4666-8666-${hex(index)}`,
    boardId: BOARD_ID,
    key,
    name,
    rank: String.fromCharCode(97 + index),
    semantics,
    wipLimit: null,
  }
}

export const COLUMNS = [
  column('todo', 'Todo', 0, 'backlog'),
  column('doing', 'Doing', 1, 'in_progress'),
  column('review', 'Review', 2, 'review'),
  column('done', 'Done', 3, 'terminal'),
]

export function makeCards(count) {
  const ranks = rebalance(count)
  return Array.from({ length: count }, (_, index) => ({
    id: `33333333-3333-4333-8333-${hex(index + 1)}`,
    boardId: BOARD_ID,
    number: index + 1,
    column: COLUMNS[index % 4].key,
    rank: ranks[index],
    title: `Card ${index + 1}: something that needs doing`,
    description: null,
    priority: index % 4 === 0 ? 1 : null,
    dueAt: null,
    assignees: index % 3 === 0 ? ['rahul'] : [],
    labels: index % 5 === 0 ? ['backend'] : [],
    watchers: [],
    checklist: [],
    comments: [],
    commits: [],
    git: null,
    anchor: null,
    createdBy: 'rahul',
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
    version: 1,
  }))
}

/** Start the stub; resolves with its base URL and a `close`. */
export async function startStub({ cards = 200 } = {}) {
  const list = makeCards(cards)
  const board = {
    id: BOARD_ID,
    workspaceId: '22222222-2222-4222-8222-222222222222',
    slug: SLUG,
    name: SLUG,
    repoRemote: null,
    baseBranch: 'main',
    branchTemplate: 'task/{id}-{slug}',
    nextCardNo: cards + 1,
    autoWatch: true,
    archivedAt: null,
    createdAt: T0,
  }
  const user = {
    id: '44444444-4444-4444-8444-444444444444',
    handle: 'rahul',
    email: null,
    displayName: null,
    avatarUrl: null,
    kind: 'human',
    githubLogin: null,
    createdAt: T0,
  }
  const routes = {
    '/healthz': { status: 'ok', version: 'bench' },
    [`/v1/boards/${SLUG}`]: {
      board,
      columns: COLUMNS,
      labels: [],
      members: [
        { handle: 'rahul', displayName: null, kind: 'human', role: 'owner', lastSeenAt: null },
      ],
    },
    '/v1/me': { user, memberships: [{ boardSlug: SLUG, boardName: SLUG, role: 'owner' }] },
    [`/v1/boards/${SLUG}/events`]: { events: [], seq: cards },
    [`/v1/boards/${SLUG}/cards`]: { cards: list, boardSlug: SLUG, count: list.length },
  }
  const bodies = Object.fromEntries(
    Object.entries(routes).map(([path, body]) => [path, JSON.stringify(body)]),
  )
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]
    const body = bodies[path]
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' })
    response.end(
      body ??
        JSON.stringify({
          error: { code: 'board_not_found', message: `stub: no ${path}`, status: 404, details: {} },
        }),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    cards: list,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A HOME and a working directory for the CLI, pointed at the stub. */
export function benchDirectories() {
  return {
    home: realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-bench-home-'))),
    cwd: realpathSync(mkdtempSync(join(tmpdir(), 'yuzie-bench-cwd-'))),
  }
}

export function benchEnv(baseUrl, home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    YUZIE_SERVER: baseUrl,
    YUZIE_TOKEN: TOKEN,
    YUZIE_BOARD: SLUG,
    YUZIE_KEYCHAIN: 'off',
    NO_COLOR: '1',
  }
}
