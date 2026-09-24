import type { Presence } from '@yuzie/core'
import { describe, expect, it } from 'vitest'
import { BoardPresence, mergeByHandle } from './realtime/presence.js'

const T0 = Date.parse('2026-08-19T09:00:00Z')
const rahul = { handle: 'rahul', kind: 'human' as const }
const claude = { handle: 'claude', kind: 'agent' as const }

function entry(handle: string, overrides: Partial<Presence> = {}): Presence {
  return {
    handle,
    kind: 'human',
    state: 'online',
    cardNo: null,
    branch: null,
    since: '2026-08-19T09:00:00.000Z',
    ...overrides,
  }
}

describe('BoardPresence', () => {
  it('puts a joining user online from the moment they connect', () => {
    const presence = new BoardPresence()
    presence.join('c1', rahul, T0)
    expect(presence.users()).toEqual([entry('rahul', { since: new Date(T0).toISOString() })])
  })

  it('applies viewing and working, and maps a client idle to online', () => {
    const presence = new BoardPresence()
    presence.join('c1', rahul, T0)

    expect(presence.update('c1', { t: 'presence', state: 'viewing', cardNo: 18 }, T0 + 1)).toBe(
      true,
    )
    expect(presence.users()[0]).toMatchObject({ state: 'viewing', cardNo: 18, branch: null })

    expect(
      presence.update(
        'c1',
        { t: 'presence', state: 'working', cardNo: 18, branch: 'task/18' },
        T0 + 2,
      ),
    ).toBe(true)
    expect(presence.users()[0]).toMatchObject({ state: 'working', branch: 'task/18' })

    expect(presence.update('c1', { t: 'presence', state: 'idle', cardNo: 18 }, T0 + 3)).toBe(true)
    expect(presence.users()[0]).toMatchObject({ state: 'online', cardNo: null, branch: null })
  })

  it('reports no change when a frame repeats the current state', () => {
    const presence = new BoardPresence()
    presence.join('c1', rahul, T0)
    presence.update('c1', { t: 'presence', state: 'viewing', cardNo: 4 }, T0)
    expect(presence.update('c1', { t: 'presence', state: 'viewing', cardNo: 4 }, T0 + 5)).toBe(
      false,
    )
    expect(presence.update('unknown', { t: 'presence', state: 'viewing' }, T0)).toBe(false)
  })

  it('expires an entry exactly one TTL after it was last heard from', () => {
    const presence = new BoardPresence()
    presence.join('c1', rahul, T0)
    presence.touch('c1', T0 + 10_000)
    expect(presence.expire(T0 + 69_999, 60_000)).toBe(false)
    expect(presence.users()).toHaveLength(1)
    expect(presence.expire(T0 + 70_000, 60_000)).toBe(true)
    expect(presence.users()).toEqual([])
  })

  it('removes an entry on leave', () => {
    const presence = new BoardPresence()
    presence.join('c1', rahul, T0)
    expect(presence.leave('c1')).toBe(true)
    expect(presence.leave('c1')).toBe(false)
    expect(presence.localSize).toBe(0)
  })

  it('merges other nodes, and forgets a node that stops refreshing', () => {
    const presence = new BoardPresence()
    presence.join('c1', rahul, T0)
    presence.setRemote('node-b', [entry('claude', { kind: 'agent', state: 'working' })], T0)
    expect(presence.users().map((user) => user.handle)).toEqual(['claude', 'rahul'])
    expect(presence.localUsers().map((user) => user.handle)).toEqual(['rahul'])

    presence.touch('c1', T0 + 59_000)
    expect(presence.expire(T0 + 60_000, 60_000)).toBe(true)
    expect(presence.users().map((user) => user.handle)).toEqual(['rahul'])
    expect(presence.remoteSize).toBe(0)
  })

  it('treats an empty remote list as that node having nobody', () => {
    const presence = new BoardPresence()
    presence.setRemote('node-b', [entry('claude')], T0)
    presence.setRemote('node-b', [], T0 + 1)
    expect(presence.remoteSize).toBe(0)
  })

  it('shows one entry per handle across sessions and nodes', () => {
    const presence = new BoardPresence()
    presence.join('tui', rahul, T0)
    presence.join('watch', rahul, T0)
    presence.join('agent', claude, T0)
    presence.update('tui', { t: 'presence', state: 'viewing', cardNo: 2 }, T0 + 1)
    expect(presence.users()).toHaveLength(2)
    expect(presence.users().find((user) => user.handle === 'rahul')?.state).toBe('viewing')
  })
})

describe('mergeByHandle', () => {
  it('prefers working over viewing over online, whatever the order', () => {
    const lists = [
      [entry('a', { state: 'viewing', cardNo: 1 })],
      [entry('a', { state: 'working', cardNo: 2 })],
      [entry('a')],
    ]
    expect(mergeByHandle(lists)[0]?.state).toBe('working')
    expect(mergeByHandle([...lists].reverse())[0]?.state).toBe('working')
  })

  it('breaks a tie on state with the most recent change', () => {
    const older = entry('a', { state: 'viewing', cardNo: 1, since: '2026-08-19T09:00:00.000Z' })
    const newer = entry('a', { state: 'viewing', cardNo: 2, since: '2026-08-19T09:05:00.000Z' })
    expect(mergeByHandle([[older], [newer]])[0]?.cardNo).toBe(2)
    expect(mergeByHandle([[newer], [older]])[0]?.cardNo).toBe(2)
  })

  it('sorts by handle so every client renders the same order', () => {
    expect(
      mergeByHandle([[entry('zed'), entry('amy')], [entry('max')]]).map((p) => p.handle),
    ).toEqual(['amy', 'max', 'zed'])
  })
})
