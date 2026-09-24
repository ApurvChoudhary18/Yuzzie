/**
 * Multi-node fan-out through Redis (SPEC.md §10.1). Two server instances share
 * one Postgres and one Redis, as two replicas behind a load balancer would; a
 * write on one must reach a client streaming from the other.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  addMember,
  createBoard,
  createCard,
  createUser,
  startTestServer,
  type TestServer,
} from './__tests__/harness.js'
import { listen, range, StreamClient, sleep } from './__tests__/stream.js'
import { createRedisPubSub } from './realtime/redis.js'

function redisUrl(): string {
  const url = process.env.TEST_REDIS_URL
  if (url === undefined) throw new Error('TEST_REDIS_URL is not set; see global-setup.ts')
  return url
}

describe('two nodes sharing Redis', () => {
  let one: TestServer
  let two: TestServer
  let baseOne: string
  let baseTwo: string
  const clients: StreamClient[] = []

  beforeAll(async () => {
    // Each node builds its own Redis connections from config, as in production.
    one = await startTestServer({ redisUrl: redisUrl(), presenceSweepMs: 50 }, { nodeId: 'one' })
    two = await startTestServer({ redisUrl: redisUrl(), presenceSweepMs: 50 }, { nodeId: 'two' })
    baseOne = await listen(one)
    baseTwo = await listen(two)
  })

  afterEach(() => {
    for (const client of clients.splice(0)) client.terminate()
  })

  afterAll(async () => {
    await one.close()
    await two.close()
  })

  it('delivers a write on node one to a client on node two, in order, once', async () => {
    const board = await createBoard(one)
    const bob = await createUser(one)
    await addMember(one, board, bob, 'member')

    const onOne = await StreamClient.connect(baseOne, board.slug, board.owner.token)
    const onTwo = await StreamClient.connect(baseTwo, board.slug, bob.token)
    clients.push(onOne, onTwo)
    await onOne.ready(0)
    await onTwo.ready(0)

    // Writes land on both nodes, interleaved, as a load balancer would spread them.
    for (const index of range(1, 30)) {
      await createCard(index % 2 === 0 ? one : two, board, board.owner.token)
    }

    await onOne.waitForSeq(30)
    await onTwo.waitForSeq(30)
    await sleep(200)
    expect(onOne.seqs).toEqual(range(1, 30))
    expect(onTwo.seqs).toEqual(range(1, 30))
  })

  it('shows presence from both nodes to clients on each', async () => {
    const board = await createBoard(one)
    const bob = await createUser(one)
    await addMember(one, board, bob, 'member')

    const alice = await StreamClient.connect(baseOne, board.slug, board.owner.token)
    clients.push(alice)
    await alice.ready()
    const b = await StreamClient.connect(baseTwo, board.slug, bob.token)
    clients.push(b)
    await b.ready()

    await alice.until(() => alice.present.includes(bob.handle), 3_000, 'bob on node one')
    await b.until(() => b.present.includes(board.owner.handle), 3_000, 'alice on node two')

    b.send({ t: 'presence', state: 'working', cardNo: 7, branch: 'task/7-x' })
    await alice.until(
      () =>
        alice.presenceFrames
          .at(-1)
          ?.users.some((u) => u.handle === bob.handle && u.state === 'working') ?? false,
      3_000,
      'bob working, seen from node one',
    )

    // A goodbye on node two reaches node one too.
    await b.close()
    await alice.until(() => !alice.present.includes(bob.handle), 3_000, 'bob gone from node one')
  })

  it('rejects an unreachable Redis at startup rather than failing later', async () => {
    await expect(createRedisPubSub('redis://127.0.0.1:1', { onError: () => {} })).rejects.toThrow()
  })
})
