import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createBoard,
  startTestServer,
  type TestBoard,
  type TestServer,
  unique,
} from './__tests__/harness.js'

/**
 * SPEC.md §12.1 and §18 Session 3 acceptance:
 * "the same key replayed 10x creates one card."
 *
 * This is what makes the offline outbox (§11.3) safe to drain more than once.
 */
describe('Idempotency-Key', () => {
  let server: TestServer
  let board: TestBoard

  beforeAll(async () => {
    server = await startTestServer()
    board = await createBoard(server)
  })

  afterAll(async () => {
    await server?.close()
  })

  const createWithKey = (key: string, title = 'Queued while offline') =>
    call<{ number: number; title: string }>(server, {
      method: 'POST',
      url: `/v1/boards/${board.slug}/cards`,
      token: board.owner.token,
      body: { title },
      headers: { 'idempotency-key': key },
    })

  it('creates one card when the same key is replayed ten times in sequence', async () => {
    const key = unique('write')
    const responses = []
    for (let attempt = 0; attempt < 10; attempt += 1) {
      responses.push(await createWithKey(key))
    }

    for (const response of responses) {
      expect(response.status).toBe(201)
    }

    const numbers = new Set(responses.map((response) => response.body.number))
    expect(numbers.size).toBe(1)

    const list = await call<{ cards: { title: string }[] }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/cards`,
      token: board.owner.token,
    })
    expect(list.body.cards.filter((card) => card.title === 'Queued while offline')).toHaveLength(1)
  })

  it('creates one card when ten replays race', async () => {
    const key = unique('write')
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => createWithKey(key, 'Raced replay')),
    )

    const succeeded = responses.filter((response) => response.status === 201)
    expect(succeeded.length).toBe(10)
    expect(new Set(succeeded.map((response) => response.body.number)).size).toBe(1)
  })

  it('appends only one event for a replayed write', async () => {
    const before = await call<{ seq: number }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/events?since=0&limit=1`,
      token: board.owner.token,
    })

    const key = unique('write')
    await createWithKey(key, 'One event only')
    await createWithKey(key, 'One event only')
    await createWithKey(key, 'One event only')

    const after = await call<{ seq: number }>(server, {
      method: 'GET',
      url: `/v1/boards/${board.slug}/events?since=0&limit=1`,
      token: board.owner.token,
    })
    expect(after.body.seq - before.body.seq).toBe(1)
  })

  it('refuses to reuse a key for a different request', async () => {
    const key = unique('write')
    await createWithKey(key, 'First body')

    const reused = await call<{ error: { code: string; message: string } }>(server, {
      method: 'POST',
      url: `/v1/boards/${board.slug}/cards`,
      token: board.owner.token,
      body: { title: 'Different body' },
      headers: { 'idempotency-key': key },
    })

    expect(reused.status).toBe(400)
    expect(reused.body.error.code).toBe('validation_failed')
    expect(reused.body.error.message).toContain('Use a new key')
  })

  it('scopes keys to the user, so two clients can pick the same key', async () => {
    const other = await createBoard(server)
    const key = 'shared-key-value'

    const mine = await createWithKey(key, 'Mine')
    const theirs = await call<{ number: number }>(server, {
      method: 'POST',
      url: `/v1/boards/${other.slug}/cards`,
      token: other.owner.token,
      body: { title: 'Theirs' },
      headers: { 'idempotency-key': key },
    })

    expect(mine.status).toBe(201)
    expect(theirs.status).toBe(201)
  })

  it('does not burn the key when the request fails', async () => {
    const key = unique('write')

    const rejected = await call(server, {
      method: 'POST',
      url: `/v1/boards/${board.slug}/cards`,
      token: board.owner.token,
      body: { title: '' },
      headers: { 'idempotency-key': key },
    })
    expect(rejected.status).toBe(400)

    // The client fixed the input; the same key must still work.
    const accepted = await createWithKey(key, 'Retried after fixing')
    expect(accepted.status).toBe(201)
  })

  it('works without a key at all', async () => {
    const first = await call<{ number: number }>(server, {
      method: 'POST',
      url: `/v1/boards/${board.slug}/cards`,
      token: board.owner.token,
      body: { title: 'No key' },
    })
    const second = await call<{ number: number }>(server, {
      method: 'POST',
      url: `/v1/boards/${board.slug}/cards`,
      token: board.owner.token,
      body: { title: 'No key' },
    })
    expect(first.body.number).not.toBe(second.body.number)
  })
})
