import { describe, expect, it } from 'vitest'
import { makeBoard, makeCard, makeColumn, makeEvent, makeMember } from './__fixtures__/board.js'
import {
  BEARER_PROTOCOL_PREFIX,
  ClientFrameSchema,
  eventFrame,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PRESENCE_TTL_MS,
  parseClientFrame,
  parseServerFrame,
  REPLAY_LIMIT,
  STREAM_CLOSE_CODES,
  STREAM_PROTOCOL,
  streamProtocols,
} from './realtime.js'

const RAHUL = {
  handle: 'rahul',
  kind: 'human' as const,
  state: 'working' as const,
  cardNo: 18,
  branch: 'task/18-fix-github-oauth',
  since: '2026-08-19T09:20:11Z',
}

describe('client frames (§12.2)', () => {
  it('accepts every example the spec gives', () => {
    const examples = [
      { t: 'hello', lastSeq: 4211, client: 'cli/1.0.0', caps: ['presence'] },
      { t: 'presence', state: 'viewing', cardNo: 18 },
      { t: 'presence', state: 'working', cardNo: 18, branch: 'task/18-fix-github-oauth' },
      { t: 'ping' },
    ]
    for (const example of examples) expect(parseClientFrame(example)).toEqual(example)
  })

  it('lets a client with no local state say hello without a lastSeq', () => {
    expect(parseClientFrame({ t: 'hello' })).toEqual({ t: 'hello' })
  })

  it('rejects frames the server would otherwise have to guess at', () => {
    const invalid = [
      {},
      { t: 'welcome', seq: 1, presence: [], resumed: true },
      { t: 'hello', lastSeq: -1 },
      { t: 'hello', lastSeq: 1.5 },
      { t: 'presence', state: 'dancing' },
      { t: 'presence', state: 'viewing', cardNo: 0 },
      { t: 'hello', caps: Array.from({ length: 17 }, () => 'x') },
    ]
    for (const frame of invalid) expect(ClientFrameSchema.safeParse(frame).success).toBe(false)
  })
})

describe('server frames (§12.2)', () => {
  it('parses welcome, presence and pong', () => {
    const frames = [
      { t: 'welcome', seq: 4211, presence: [RAHUL], resumed: true },
      { t: 'presence', users: [RAHUL] },
      { t: 'pong' },
    ]
    for (const frame of frames) expect(parseServerFrame(frame)).toEqual(frame)
  })

  it('parses a snapshot carrying a whole board', () => {
    const frame = {
      t: 'snapshot',
      seq: 4300,
      board: {
        board: makeBoard(),
        columns: [makeColumn('todo', 'a')],
        labels: [],
        members: [makeMember('rahul')],
        cards: [makeCard()],
      },
    }
    expect(parseServerFrame(frame)).toEqual(frame)
  })

  it('validates an event frame against the full §12.3 catalogue', () => {
    const event = makeEvent('card.moved', 4212, { from: 'review', to: 'done', rank: 'a0m' })
    const frame = eventFrame(event)
    expect(frame.t).toBe('event')
    expect(parseServerFrame(JSON.parse(JSON.stringify(frame)))).toEqual(frame)

    expect(() => parseServerFrame({ ...frame, payload: { from: 'review' } })).toThrow()
    expect(() => parseServerFrame({ t: 'event', type: 'presence.view', seq: 1 })).toThrow()
  })

  it('rejects anything without a known discriminator', () => {
    expect(() => parseServerFrame({ t: 'hello' })).toThrow()
    expect(() => parseServerFrame(null)).toThrow()
    expect(() => parseServerFrame('pong')).toThrow()
  })
})

describe('protocol constants', () => {
  it('offers the versioned protocol first and the token second', () => {
    expect(streamProtocols('yz_abc')).toEqual([STREAM_PROTOCOL, `${BEARER_PROTOCOL_PREFIX}yz_abc`])
  })

  it('matches the numbers in §12.2 and §18 Session 4', () => {
    expect(REPLAY_LIMIT).toBe(500)
    expect(HEARTBEAT_INTERVAL_MS).toBe(20_000)
    expect(HEARTBEAT_TIMEOUT_MS).toBe(45_000)
    expect(PRESENCE_TTL_MS).toBe(60_000)
  })

  it('uses only codes a WebSocket peer may send, each once', () => {
    const codes = Object.values(STREAM_CLOSE_CODES)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) {
      expect(code === 1001 || (code >= 4000 && code <= 4999)).toBe(true)
    }
  })
})
