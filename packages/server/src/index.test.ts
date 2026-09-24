import { describe, expect, it } from 'vitest'
import * as server from './index.js'

describe('@yuzie/server public surface', () => {
  it('exports the ways to build and run a server', () => {
    expect(typeof server.buildServer).toBe('function')
    expect(typeof server.start).toBe('function')
    expect(typeof server.createDatabase).toBe('function')
    expect(typeof server.loadConfig).toBe('function')
  })

  it('exports migrations for both dialects', () => {
    expect(typeof server.migratePostgres).toBe('function')
    expect(typeof server.migrateSqlite).toBe('function')
    expect(typeof server.loadMigrations).toBe('function')
    expect(server.MIGRATIONS_TABLE).toBe('_yuzie_migrations')
    expect(server.loadMigrations('postgres').length).toBeGreaterThan(0)
    expect(server.loadMigrations('sqlite').length).toBeGreaterThan(0)
  })

  it('exports the auth and permission surface', () => {
    expect(typeof server.authenticate).toBe('function')
    expect(typeof server.resolveBoard).toBe('function')
    expect(typeof server.can).toBe('function')
    expect(typeof server.authorize).toBe('function')
    expect(server.ACTIONS.length).toBeGreaterThan(10)
    expect(server.TOKEN_PREFIX).toBe('yz_')
  })

  it('exports the seams Session 4 needs', () => {
    expect(typeof server.createEventBus).toBe('function')
    expect(typeof server.mutateBoard).toBe('function')
    expect(typeof server.currentSeq).toBe('function')
    expect(typeof server.createMetrics).toBe('function')
  })

  it('exports the realtime gateway and both brokers', () => {
    expect(typeof server.createGateway).toBe('function')
    expect(typeof server.createMemoryPubSub).toBe('function')
    expect(typeof server.createRedisPubSub).toBe('function')
    expect(typeof server.loadEvents).toBe('function')
    expect(typeof server.loadSnapshot).toBe('function')
    expect(typeof server.OutboundQueue).toBe('function')
    expect(typeof server.BoardPresence).toBe('function')
  })

  it('narrows a role to the weaker of two', () => {
    expect(server.narrowestRole('owner', 'viewer')).toBe('viewer')
    expect(server.narrowestRole('viewer', 'owner')).toBe('viewer')
    expect(server.narrowestRole('member', 'owner')).toBe('member')
    expect(server.narrowestRole('owner', 'owner')).toBe('owner')
  })
})
