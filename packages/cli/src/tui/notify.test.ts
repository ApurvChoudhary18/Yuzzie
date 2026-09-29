import { describe, expect, it } from 'vitest'
import { notifyCommand, osNotifier } from './notify.js'

describe('OS notifications (§18 Session 14)', () => {
  it('are off unless asked for, and never in CI or with YUZIE_NO_NOTIFY', async () => {
    expect(await osNotifier(false, {})).toBeNull()
    expect(await osNotifier(true, { CI: 'true' })).toBeNull()
    expect(await osNotifier(true, { YUZIE_NO_NOTIFY: '1' })).toBeNull()
    expect(await osNotifier(true, {}, 'aix')).toBeNull()
  })

  it('use the system notifier when enabled', async () => {
    expect(typeof (await osNotifier(true, {}, 'darwin'))).toBe('function')
  })

  it('quote card text so it cannot become script, and drop control characters', () => {
    const mac = notifyCommand('darwin', 'yuzie · #18', 'He said "hi" \\ \u001b[2J')
    expect(mac).toEqual({
      program: 'osascript',
      args: ['-e', 'display notification "He said \\"hi\\" \\\\  [2J" with title "yuzie · #18"'],
    })
    expect(notifyCommand('linux', '-t', '--x')).toEqual({
      program: 'notify-send',
      args: ['--app-name=yuzie', '--', '-t', '--x'],
    })
    const windows = notifyCommand('win32', "it's", 'ok')
    expect(windows?.args.at(-1)).toContain("CreateTextNode('it''s')")
  })
})
