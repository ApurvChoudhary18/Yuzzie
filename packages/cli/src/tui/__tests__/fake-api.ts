/**
 * Just enough of the REST API for a real SDK board to open against, with
 * routes a test can replace — to hold a write open, or answer it with a 409.
 */
import type { Card, Column } from '@yuzie/core'
import type { FetchLike, RequestInitLike, ResponseLike } from '@yuzie/sdk'
import { type Board, createClient } from '@yuzie/sdk'

const BOARD_ID = '11111111-1111-4111-8111-111111111111'
const T = '2026-08-19T09:00:00.000Z'
const BASE = 'https://api.test/v1'

export function reply(status: number, body?: unknown): ResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

export function problem(code: string, status: number, details: Record<string, unknown> = {}) {
  return { error: { code, message: `${code} happened`, status, details } }
}

type Route = (
  init: RequestInitLike,
  match: RegExpMatchArray,
) => ResponseLike | Promise<ResponseLike>

export class FakeApi {
  readonly calls: Array<{ method: string; path: string; body: unknown }> = []
  private readonly routes: Array<{ method: string; pattern: RegExp; handle: Route }> = []

  constructor(
    public columns: Column[],
    public cards: Card[],
    public members: string[] = ['rahul', 'priya'],
  ) {
    this.on('GET', /^\/boards\/b$/, () =>
      reply(200, {
        board: {
          id: BOARD_ID,
          workspaceId: '22222222-2222-4222-8222-222222222222',
          slug: 'b',
          name: 'B',
          repoRemote: null,
          baseBranch: 'main',
          branchTemplate: 'task/{id}-{slug}',
          nextCardNo: 100,
          archivedAt: null,
          createdAt: T,
        },
        columns: this.columns,
        labels: [],
        members: this.members.map((handle) => ({
          handle,
          displayName: null,
          kind: 'human',
          role: 'member',
          lastSeenAt: null,
        })),
      }),
    )
    this.on('GET', /^\/me$/, () =>
      reply(200, {
        user: {
          id: '44444444-4444-4444-8444-444444444444',
          handle: 'rahul',
          email: null,
          displayName: null,
          avatarUrl: null,
          kind: 'human',
          githubLogin: null,
          createdAt: T,
        },
        memberships: [],
      }),
    )
    this.on('GET', /^\/boards\/b\/events/, () => reply(200, { events: [], seq: 0 }))
    this.on('GET', /^\/boards\/b\/cards$/, () =>
      reply(200, { cards: this.cards, boardSlug: 'b', count: this.cards.length }),
    )
    this.on('GET', /^\/boards\/b\/cards\/(\d+)$/, (_init, match) => {
      const found = this.cards.find((card) => card.number === Number(match[1]))
      return found === undefined ? reply(404, problem('card_not_found', 404)) : reply(200, found)
    })
  }

  on(method: string, pattern: RegExp, handle: Route): void {
    this.routes.unshift({ method, pattern, handle })
  }

  readonly fetch: FetchLike = async (url, init) => {
    const path = url.replace(BASE, '')
    this.calls.push({
      method: init.method,
      path,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    for (const route of this.routes) {
      const match = path.match(route.pattern)
      if (route.method === init.method && match !== null) return route.handle(init, match)
    }
    return reply(404, problem('card_not_found', 404))
  }

  writes(): string[] {
    return this.calls.filter((call) => call.method !== 'GET').map((c) => `${c.method} ${c.path}`)
  }
}

/** A real SDK board on the fake API, opened over HTTP (no stream). */
export async function openBoard(api: FakeApi): Promise<Board> {
  const board = createClient({ baseUrl: BASE, token: 'yz_t', fetch: api.fetch, retries: 0 }).board(
    'b',
    { realtime: false },
  )
  await board.open()
  return board
}
