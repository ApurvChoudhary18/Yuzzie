/**
 * The `yuzie` command tree (SPEC.md §7). Every command funnels through
 * {@link run}, which owns the one place an exit code is decided (§7.4).
 */

import { Command, CommanderError, Option } from 'commander'
import { login, logout, whoami } from './commands/auth.js'
import { doctor } from './commands/doctor.js'
import { init } from './commands/init.js'
import { configGet, configSet, hook, hooksInstall, hooksUninstall } from './commands/setup.js'
import { Context, type GlobalOptions, type Io } from './context.js'
import { EXIT_OK, EXIT_USAGE, exitCodeFor } from './exit.js'
import { VERSION } from './version.js'

/** A command body: gets the context, then commander's positional args and options. */
type Handler = (context: Context, ...args: never[]) => Promise<unknown>

function build(io: Io, finish: (code: number) => void): Command {
  const program = new Command('yuzie')
    .description('Real-time, git-aware kanban for your team, in your terminal.')
    .version(VERSION, '--version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .addOption(new Option('--json', 'machine-readable output; no colour, no spinners'))
    .addOption(
      new Option('--board <slug>', 'use this board instead of the one in .yuzie/config.json'),
    )
    .addOption(new Option('--no-color', 'disable colour (NO_COLOR is honoured too)'))
    .addOption(new Option('-q, --quiet', 'print only errors'))
    .addOption(new Option('-v, --verbose', 'debug logging on stderr'))
    .addOption(new Option('--offline', 'do not contact the server'))
    .addOption(new Option('-y, --yes', 'assume yes; take defaults instead of asking'))
    .addOption(new Option('--config <path>', 'use this config file'))
    .showSuggestionAfterError(true)
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
    })
    .exitOverride()

  /** Run a handler with a fresh context, and turn whatever happens into an exit code. */
  const action =
    (handler: Handler) =>
    async (...raw: unknown[]): Promise<void> => {
      // commander calls actions with (…positional args, options, command).
      const command = raw.at(-1) as Command
      const context = new Context(command.optsWithGlobals() as GlobalOptions, io)
      context.output.debug(`yuzie ${VERSION} · ${command.name()}`)
      try {
        const body = handler as (context: Context, ...args: unknown[]) => Promise<unknown>
        const code = await body(context, ...raw.slice(0, -1))
        finish(typeof code === 'number' ? code : EXIT_OK)
      } catch (error) {
        context.output.error(error)
        context.output.debug(
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        )
        finish(exitCodeFor(error))
      } finally {
        context.prompter.close()
      }
    }

  program
    .command('init')
    .description('detect the repo, sign in, create or link a board, write config, install hooks')
    .option('--no-hooks', 'do not install git hooks')
    .action(action((context: Context, options: { hooks?: boolean }) => init(context, options)))

  program
    .command('login')
    .description('sign in with a device code; the token goes to the OS keychain')
    .action(action((context: Context) => login(context)))

  program
    .command('logout')
    .description('revoke this machine’s token and forget it')
    .action(action((context: Context) => logout(context)))

  program
    .command('whoami')
    .description('show who you are, which server, and which board')
    .action(action((context: Context) => whoami(context)))

  program
    .command('doctor')
    .description('check node, git, sign-in, server, hooks and cache')
    .action(action((context: Context) => doctor(context)))

  const config = program.command('config').description('read and change .yuzie/config.json')
  config
    .command('get [key]')
    .description('print a value, e.g. `git.baseBranch`, or everything')
    .action(action((context: Context, key: string | undefined) => configGet(context, key)))
  config
    .command('set <key> <value>')
    .description('set a value in the repo config (or --global for your user)')
    .option('--global', 'write ~/.yuzie/config.json instead')
    .action(
      action((context: Context, key: string, value: string, options: { global?: boolean }) =>
        configSet(context, key, value, options),
      ),
    )

  const hooks = program.command('hooks').description('manage the git hooks')
  hooks
    .command('install')
    .description('install the hooks listed in git.hooks')
    .action(action((context: Context) => hooksInstall(context)))
  hooks
    .command('uninstall')
    .description('remove yuzie’s hooks, keeping anything else in those files')
    .action(action((context: Context) => hooksUninstall(context)))

  // What the installed shims call. Hidden, and it can never fail a git command.
  program
    .command('__hook <name>', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (name: string, _options: unknown, command: Command) => {
      try {
        await hook(new Context(command.optsWithGlobals() as GlobalOptions, io), name)
      } catch {
        // Swallowed on purpose (§9.5).
      }
      finish(EXIT_OK)
    })

  // `yuzie` with no command opens the board (the TUI arrives in Session 8).
  program.action(() => {
    io.stdout.write(`${program.helpInformation()}\n`)
    finish(EXIT_OK)
  })

  return program
}

/** Run the CLI; resolves to the exit code instead of exiting, so it is testable. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  let exitCode: number | undefined
  const finish = (code: number) => {
    exitCode ??= code
  }
  const program = build(io, finish)

  try {
    await program.parseAsync([...argv], { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version "error" with exit code 0.
      return error.exitCode === 0 ? EXIT_OK : EXIT_USAGE
    }
    throw error
  }
  return exitCode ?? EXIT_OK
}
