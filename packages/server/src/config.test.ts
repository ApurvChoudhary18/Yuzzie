import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

describe('loadConfig', () => {
  it('reads the database url from the environment', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://localhost/yuzie' })
    expect(config.databaseUrl).toBe('postgres://localhost/yuzie')
  })

  it('applies the defaults from §12.1 and §13.2', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://localhost/yuzie' })
    expect(config.port).toBe(8787)
    expect(config.readRateLimit).toBe(600)
    expect(config.writeRateLimit).toBe(120)
    expect(config.idempotencyTtlMs).toBe(24 * 60 * 60 * 1000)
    expect(config.signupMode).toBe('open')
  })

  it('lets explicit overrides win over the environment', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://env/db', PORT: '1234' }, { port: 9999 })
    expect(config.port).toBe(9999)
  })

  it('explains what is wrong instead of failing cryptically', () => {
    expect(() => loadConfig({})).toThrow(/Set DATABASE_URL/)
    expect(() => loadConfig({})).toThrow(/databaseUrl/)
  })

  it('rejects a port that is not a number', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x/y', PORT: 'eighty' })).toThrow(
      /Invalid server configuration/,
    )
  })

  it('rejects an unknown signup mode', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x/y', YUZIE_SIGNUP: 'whoever' })).toThrow(
      /Invalid server configuration/,
    )
  })

  it('applies the realtime defaults from §12.2 and §14.1', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://localhost/yuzie' })
    expect(config.redisUrl).toBeUndefined()
    expect(config.wsMaxConnectionsPerUser).toBe(2)
    expect(config.wsReplayLimit).toBe(500)
    expect(config.wsHeartbeatTimeoutMs).toBe(45_000)
    expect(config.presenceTtlMs).toBe(60_000)
    expect(config.presenceBroadcastIntervalMs).toBe(200)
  })

  it('reads REDIS_URL for multi-node fan-out', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/yuzie',
      REDIS_URL: 'redis://localhost:6379',
    })
    expect(config.redisUrl).toBe('redis://localhost:6379')
  })
})
