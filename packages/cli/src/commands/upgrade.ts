/**
 * `yuzie upgrade` (SPEC.md §18 Session 17): install the latest version the way
 * this one was installed — or say how, when that is not ours to do.
 */
import { spawnSync } from 'node:child_process'
import { OfflineError } from '@yuzie/core'
import type { Context } from '../context.js'
import { RuntimeError } from '../exit.js'
import { installer, isNewer, latestVersion, PACKAGE, upgradeCommand } from '../update.js'
import { VERSION } from '../version.js'

export async function upgrade(context: Context, options: { dryRun?: boolean }): Promise<number> {
  context.requireNetwork('Upgrading')
  const latest = await latestVersion(context.io.env, 10_000)
  if (latest === null) {
    throw new OfflineError(
      'offline_network_required',
      `Could not find the latest ${PACKAGE} on the npm registry.`,
    )
  }
  const how = installer(process.argv[1])
  const command = upgradeCommand(how)
  const current = !isNewer(latest, VERSION)
  const report = { current: VERSION, latest, upToDate: current, installer: how, command }

  if (current) {
    context.output.success(`yuzie ${VERSION} is the latest`)
    context.output.result('Upgrade', { ...report, upgraded: false })
    return 0
  }
  if (command === null) {
    context.output.success(`yuzie ${latest} is available (you have ${VERSION})`)
    context.output.line('  You are running yuzie through npx, which fetches it each time:')
    context.output.line(
      `  ${context.output.paint('cyan', 'npx yuzie@latest')} runs the new version.`,
    )
    context.output.result('Upgrade', { ...report, upgraded: false })
    return 0
  }

  const printed = command.join(' ')
  context.output.line(`yuzie ${latest} is available (you have ${VERSION}).`)
  if (options.dryRun === true) {
    context.output.line(`  Would run: ${printed}`)
    context.output.result('Upgrade', { ...report, upgraded: false })
    return 0
  }
  const go = await context.prompter.confirm(`Run \`${printed}\`?`, true)
  if (!go) {
    context.output.line(`  Not upgraded. To do it yourself: ${printed}`)
    context.output.result('Upgrade', { ...report, upgraded: false })
    return 0
  }
  const result = spawnSync(command[0] as string, command.slice(1), {
    stdio: context.output.json ? ['inherit', 'ignore', 'inherit'] : 'inherit',
    env: context.io.env as NodeJS.ProcessEnv,
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new RuntimeError(
      `\`${printed}\` did not finish${result.status === null ? '' : ` (exit ${result.status})`}.`,
      'Run it yourself to see why — a global install may need a different prefix or permissions.',
    )
  }
  context.output.success(`Upgraded to yuzie ${latest}`)
  context.output.result('Upgrade', { ...report, upgraded: true })
  return 0
}
