import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMember,
  call,
  createBoard,
  createUser,
  startTestServer,
  type TestBoard,
  type TestServer,
} from './__tests__/harness.js'

/**
 * SPEC.md §12.1: "600 req/min per token for reads, 120/min for writes, 429 with
 * Retry-After." The limits are configurable so this suite can reach them without
 * making ten thousand requests.
 */
describe('rate limiting', () => {
  let server: TestServer
  let board: TestBoard

  beforeAll(async () => {
    server = await startTestServer({
      rateLimitEnabled: true,
      readRateLimit: 5,
      writeRateLimit: 2,
    })
    board = await createBoard(server)
  })

  afterAll(async () => {
    await server?.close()
  })

  it('limits reads and answers with the §12.1 envelope', async () => {
    const reader = await createUser(server)

    const statuses: number[] = []
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await call(server, { method: 'GET', url: '/v1/me', token: reader.token })
      statuses.push(response.status)
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(5)
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0)

    const limited = await call<{ error: { code: string; message: string } }>(server, {
      method: 'GET',
      url: '/v1/me',
      token: reader.token,
    })
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('rate_limited')
    expect(limited.body.error.message).toMatch(/Retry in \d+s/)
    expect(limited.headers['retry-after']).toBeDefined()
  })

  it('gives writes a tighter budget than reads', async () => {
    // A writer with an untouched budget: creating the board already spent one of
    // the owner's two writes.
    const writer = await createUser(server)
    await addMember(server, board, writer, 'member')

    const writes: number[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await call(server, {
        method: 'POST',
        url: `/v1/boards/${board.slug}/cards`,
        token: writer.token,
        body: { title: `Card ${attempt}` },
      })
      writes.push(response.status)
    }

    expect(writes.filter((status) => status === 201)).toHaveLength(2)
    expect(writes.filter((status) => status === 429)).toHaveLength(2)
  })

  it('counts against the token, not the address', async () => {
    // Two users from the same client must not share a budget: a team behind one
    // NAT is many people (§12.1).
    const first = await createUser(server)
    const second = await createUser(server)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await call(server, { method: 'GET', url: '/v1/me', token: first.token })
    }
    const exhausted = await call(server, { method: 'GET', url: '/v1/me', token: first.token })
    const untouched = await call(server, { method: 'GET', url: '/v1/me', token: second.token })

    expect(exhausted.status).toBe(429)
    expect(untouched.status).toBe(200)
  })
})
