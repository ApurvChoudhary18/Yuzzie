import { STREAM_PROTOCOL } from '@yuzie/core'
import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { selectProtocol, upgradeAuthorization } from './realtime/gateway.js'
import { createMemoryPubSub } from './realtime/pubsub.js'

describe('createMemoryPubSub', () => {
  it('delivers to every subscriber of a topic, in publish order, and to no other topic', async () => {
    const broker = createMemoryPubSub()
    const a: string[] = []
    const b: string[] = []
    const other: string[] = []
    await broker.subscribe('board:1', (message) => a.push(message))
    await broker.subscribe('board:1', (message) => b.push(message))
    await broker.subscribe('board:2', (message) => other.push(message))

    await broker.publish('board:1', 'one')
    await broker.publish('board:1', 'two')
    expect(a).toEqual(['one', 'two'])
    expect(b).toEqual(['one', 'two'])
    expect(other).toEqual([])
  })

  it('isolates a throwing subscriber from the rest', async () => {
    const broker = createMemoryPubSub()
    const received: string[] = []
    await broker.subscribe('t', () => {
      throw new Error('broken subscriber')
    })
    await broker.subscribe('t', (message) => received.push(message))
    await broker.publish('t', 'still delivered')
    expect(received).toEqual(['still delivered'])
  })

  it('stops delivering after unsubscribe and after close', async () => {
    const broker = createMemoryPubSub()
    const received: string[] = []
    const unsubscribe = await broker.subscribe('t', (message) => received.push(message))
    await broker.publish('t', 'before')
    await unsubscribe()
    await unsubscribe()
    await broker.publish('t', 'after')

    await broker.subscribe('u', (message) => received.push(message))
    await broker.close()
    await broker.publish('u', 'closed')
    expect(received).toEqual(['before'])
  })
})

describe('upgrade helpers', () => {
  const request = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest

  it('prefers the Authorization header', () => {
    expect(
      upgradeAuthorization(
        request({ authorization: 'Bearer yz_a', 'sec-websocket-protocol': 'bearer.yz_b' }),
      ),
    ).toBe('Bearer yz_a')
  })

  it('reads the token from the bearer sub-protocol, wherever it is in the list', () => {
    expect(
      upgradeAuthorization(
        request({ 'sec-websocket-protocol': `${STREAM_PROTOCOL}, bearer.yz_b` }),
      ),
    ).toBe('Bearer yz_b')
    expect(
      upgradeAuthorization(request({ 'sec-websocket-protocol': `bearer.yz_c,${STREAM_PROTOCOL}` })),
    ).toBe('Bearer yz_c')
  })

  it('finds nothing when neither is present', () => {
    expect(upgradeAuthorization(request({}))).toBeUndefined()
    expect(
      upgradeAuthorization(request({ 'sec-websocket-protocol': STREAM_PROTOCOL })),
    ).toBeUndefined()
  })

  it('selects the versioned protocol only', () => {
    expect(selectProtocol(new Set([STREAM_PROTOCOL, 'bearer.yz_secret']))).toBe(STREAM_PROTOCOL)
    expect(selectProtocol(new Set(['bearer.yz_secret']))).toBe(false)
    expect(selectProtocol(new Set(['yuzie.v2']))).toBe(false)
  })
})
