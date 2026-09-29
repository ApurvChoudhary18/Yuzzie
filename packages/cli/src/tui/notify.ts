/**
 * OS notifications for watched cards while the board is open (SPEC.md §18
 * Session 14). Off by default (`ui.notifications`).
 *
 * The system's own notifier, run as a command: `osascript` on macOS,
 * `notify-send` on Linux, a PowerShell toast on Windows. No dependency ships
 * with the CLI for this (§18 Session 16: node-notifier alone was 5.6 MB of
 * bundled helper apps), and a missing command is not an error — the footer
 * toast still says it.
 */
import { spawn } from 'node:child_process'
import { printable } from '@yuzie/core'
import type { Notify } from './source.js'

type Env = Readonly<Record<string, string | undefined>>

export interface NotifyCommand {
  readonly program: string
  readonly args: readonly string[]
}

/** AppleScript and PowerShell string literals, safely quoted. */
const appleScript = (text: string) => `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`
const powerShell = (text: string) => `'${text.replace(/'/g, "''")}'`

/** The command that shows `title` / `message` on `platform`, or null when there is none. */
export function notifyCommand(
  platform: NodeJS.Platform,
  title: string,
  message: string,
): NotifyCommand | null {
  // Titles and messages come from card text: nothing a terminal or shell could act on.
  const clean = (text: string) =>
    printable(text)
      .replace(/\ufffd/g, ' ')
      .slice(0, 240)
  const [t, m] = [clean(title), clean(message)]
  switch (platform) {
    case 'darwin':
      return {
        program: 'osascript',
        args: ['-e', `display notification ${appleScript(m)} with title ${appleScript(t)}`],
      }
    case 'linux':
      return { program: 'notify-send', args: ['--app-name=yuzie', '--', t, m] }
    case 'win32':
      return {
        program: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          [
            '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
            '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(1)',
            `$text = $xml.GetElementsByTagName('text'); $text[0].AppendChild($xml.CreateTextNode(${powerShell(t)})) > $null; $text[1].AppendChild($xml.CreateTextNode(${powerShell(m)})) > $null`,
            "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('yuzie').Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
          ].join('; '),
        ],
      }
    default:
      return null
  }
}

export async function osNotifier(
  enabled: boolean,
  env: Env,
  platform: NodeJS.Platform = process.platform,
): Promise<Notify | null> {
  if (!enabled || env.YUZIE_NO_NOTIFY === '1' || env.CI !== undefined) return null
  if (notifyCommand(platform, '', '') === null) return null
  return (title, message) => {
    const command = notifyCommand(platform, title, message)
    if (command === null) return
    const child = spawn(command.program, [...command.args], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  }
}
