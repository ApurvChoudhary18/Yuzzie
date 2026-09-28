import { describe, expect, it } from 'vitest'
import { osNotifier } from './notify.js'

describe('OS notifications (§18 Session 14)', () => {
  it('are off unless asked for, and never in CI or with YUZIE_NO_NOTIFY', async () => {
    expect(await osNotifier(false, {})).toBeNull()
    expect(await osNotifier(true, { CI: 'true' })).toBeNull()
    expect(await osNotifier(true, { YUZIE_NO_NOTIFY: '1' })).toBeNull()
  })

  it('load node-notifier when enabled', async () => {
    expect(typeof (await osNotifier(true, {}))).toBe('function')
  })
})
