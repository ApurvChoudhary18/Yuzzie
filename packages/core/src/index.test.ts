import { describe, expect, it } from 'vitest'
import * as core from './index.js'

/**
 * The package entry point is the contract every other package imports. A missing
 * re-export is a build break three sessions later, so it is asserted here.
 */
describe('@yuzie/core public surface', () => {
  it('exports the domain constants', () => {
    expect(core.ROLES).toEqual(['owner', 'member', 'viewer'])
    expect(core.USER_KINDS).toEqual(['human', 'agent'])
    expect(core.COLUMN_SEMANTICS).toEqual(['backlog', 'in_progress', 'review', 'terminal'])
    expect(core.PRIORITIES).toEqual([0, 1, 2, 3])
    expect(core.PRESENCE_STATES).toEqual(['online', 'viewing', 'working'])
  })

  it('exports the pieces each later session depends on', () => {
    expect(typeof core.applyEvent).toBe('function')
    expect(typeof core.applyEvents).toBe('function')
    expect(typeof core.initialState).toBe('function')
    expect(typeof core.rankBetween).toBe('function')
    expect(typeof core.rebalance).toBe('function')
    expect(typeof core.branchFor).toBe('function')
    expect(typeof core.slugify).toBe('function')
    expect(typeof core.newId).toBe('function')
    expect(typeof core.boardError).toBe('function')
    expect(typeof core.parseEvent).toBe('function')
    expect(core.CardSchema).toBeDefined()
    expect(core.EventEnvelopeSchema).toBeDefined()
    expect(core.JSON_API_VERSION).toBe('yuzie/v1')
  })

  it('exports the error classes named in §13.1', () => {
    expect(typeof core.BoardError).toBe('function')
    expect(typeof core.NotFoundError).toBe('function')
    expect(typeof core.ConflictError).toBe('function')
    expect(typeof core.OfflineError).toBe('function')
    expect(typeof core.PermissionError).toBe('function')
  })
})
