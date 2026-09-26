/**
 * The `yuzie` command tree (SPEC.md §7). Every command funnels through
 * {@link run}, which owns the one place an exit code is decided (§7.4).
 */

import { Command, CommanderError, Option } from 'commander'
import { login, logout, whoami } from './commands/auth.js'
import {
  type AddOptions,
  add,
  assign,
  check,
  comment,
  done,
  due,
  edit,
  type ListOptions,
  labels,
  list,
  move,
  priority,
  rm,
  show,
  watch,
} from './commands/cards.js'
import { doctor } from './commands/doctor.js'
import { branch, claim, commits, finish as finishCard } from './commands/git.js'
import { hook } from './commands/hooks.js'
import { init } from './commands/init.js'
import { configGet, configSet, hooksInstall, hooksUninstall } from './commands/setup.js'
import {
  activity,
  boardsArchive,
  boardsCreate,
  boardsList,
  boardsRename,
  columnsAdd,
  columnsList,
  columnsRemove,
  feed,
  invite,
  members,
  share,
  who,
} from './commands/team.js'
import { Context, type GlobalOptions, type Io } from './context.js'
import { EXIT_OK, EXIT_USAGE, exitCodeFor, UsageError } from './exit.js'
import { VERSION } from './version.js'

/** The command a mistyped word most likely meant: close in spelling, or a unique prefix. */
export function closest(word: string, names: readonly string[]): string | null {
  const distance = (a: string, b: string): number => {
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
    let beforePrevious = previous
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i]
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        current[j] = Math.min(
          (previous[j] ?? 0) + 1,
          (current[j - 1] ?? 0) + 1,
          (previous[j - 1] ?? 0) + cost,
        )
        // Two letters swapped (`lsit`) is one slip, not two.
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
          current[j] = Math.min(current[j] ?? 0, (beforePrevious[j - 2] ?? 0) + 1)
      }
      beforePrevious = previous
      previous = current
    }
    return previous[b.length] ?? Number.POSITIVE_INFINITY
  }
  const lower = word.toLowerCase()
  const prefixed = names.filter((name) => name.startsWith(lower))
  if (prefixed.length === 1) return prefixed[0] ?? null
  let best: string | null = null
  let bestDistance = 3
  for (const name of names) {
    const d = distance(lower, name)
    if (d < bestDistance) {
      best = name
      bestDistance = d
    }
  }
  return best
}

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

  program
    .command('claim <id>')
    .description('assign to yourself, move to Doing, create and check out the branch (§9.3)')
    .option('--no-branch', 'claim without touching Git')
    .option('--from <base>', 'branch from this instead of the configured base')
    .option('--force', 'carry uncommitted changes along instead of stopping')
    .action(
      action(
        (
          context: Context,
          reference: string,
          options: { branch?: boolean; from?: string; force?: boolean },
        ) => claim(context, reference, options),
      ),
    )

  program
    .command('start <id>')
    .description('like claim, but only checks out a branch that already exists')
    .option('--force', 'carry uncommitted changes along instead of stopping')
    .action(
      action((context: Context, reference: string, options: { force?: boolean }) =>
        claim(context, reference, options, 'start'),
      ),
    )

  program
    .command('finish <id>')
    .description('pre-flight checks, then move the card on for review (§9.4)')
    .option('--skip-checks', 'move it on without checking')
    .option('--push', 'push the branch first if it is not pushed')
    .action(
      action(
        (context: Context, reference: string, options: { skipChecks?: boolean; push?: boolean }) =>
          finishCard(context, reference, options),
      ),
    )

  program
    .command('branch <id>')
    .description('print the branch for a card; --create checks it out, --link records one')
    .option('--create', 'create (or check out) the branch and link it')
    .option('--link <name>', 'record an existing branch as this card’s branch')
    .action(
      action((context: Context, reference: string, options: { create?: boolean; link?: string }) =>
        branch(context, reference, options),
      ),
    )

  program
    .command('commits <id>')
    .description('list the commits linked to a card')
    .action(action((context: Context, reference: string) => commits(context, reference)))

  const hooks = program.command('hooks').description('manage the git hooks')
  hooks
    .command('install')
    .description('install the hooks listed in git.hooks')
    .action(action((context: Context) => hooksInstall(context)))
  hooks
    .command('uninstall')
    .description('remove yuzie’s hooks, keeping anything else in those files')
    .action(action((context: Context) => hooksUninstall(context)))

  const collect = (value: string, previous: string[] = []) => [...previous, value]

  // --- Cards (§7.2) -----------------------------------------------------------
  program
    .command('add <title...>')
    .description('create a card')
    .option('--desc <text>', 'description')
    .option('--assign <handle>', 'assign someone (repeatable)', collect)
    .option('--column <column>', 'start in this column')
    .option('--label <label>', 'add a label (repeatable)', collect)
    .option('--due <date>', 'due date: friday, tomorrow, +3d, 2026-10-02')
    .option('--anchor <file:line>', 'the code this card is about')
    .option('--priority <p>', 'p0 (highest) to p3')
    .action(
      action((context: Context, title: string[], options: AddOptions) =>
        add(context, title, options),
      ),
    )

  program
    .command('list')
    .alias('ls')
    .description('list cards, most recently active first')
    .option('--status <column>', 'only this column')
    .option('--column <column>', 'same as --status')
    .option('--assignee <handle>', 'only cards assigned to this person')
    .option('--label <label>', 'only cards with this label')
    .option('--mine', 'only cards assigned to you')
    .option('--watching', 'only cards you watch')
    .option('--stale <duration>', 'unfinished cards idle at least this long, e.g. 2d')
    .option('--search <text>', 'title or description contains')
    .option('--limit <n>', 'at most n cards')
    .option('--sort <order>', 'updated (default), rank, created, due, priority')
    .action(action((context: Context, options: ListOptions) => list(context, options)))

  program
    .command('card <id>')
    .description('everything about one card')
    .action(action((context: Context, id: string) => show(context, id)))

  program
    .command('move <id> <column>')
    .description('move a card; the column matches by prefix')
    .action(action((context: Context, id: string, column: string) => move(context, id, column)))

  program
    .command('done <id>')
    .description('move a card to the final column')
    .action(action((context: Context, id: string) => done(context, id)))

  program
    .command('assign <id> [handles...]')
    .description('assign people or agents')
    .option('--clear', 'unassign everyone else')
    .action(
      action((context: Context, id: string, handles: string[], options: { clear?: boolean }) =>
        assign(context, id, handles, options),
      ),
    )

  program
    .command('comment <id> [text...]')
    .description('add a comment; `-` reads it from stdin')
    .option('--editor', 'write it in $EDITOR')
    .action(
      action((context: Context, id: string, text: string[], options: { editor?: boolean }) =>
        comment(context, id, text, options),
      ),
    )

  program
    .command('edit <id>')
    .description('edit a card in $EDITOR as YAML front matter + markdown')
    .action(action((context: Context, id: string) => edit(context, id)))

  program
    .command('rm <id>')
    .description('delete a card (asks first; --yes to skip)')
    .action(action((context: Context, id: string) => rm(context, id)))

  program
    .command('watch <id>')
    .description('follow a card’s activity')
    .action(action((context: Context, id: string) => watch(context, id, true)))
  program
    .command('unwatch <id>')
    .description('stop following a card')
    .action(action((context: Context, id: string) => watch(context, id, false)))

  program
    .command('check <id> <item> [text...]')
    .description('toggle checklist item n, or `check <id> add <text>`')
    .option('--done', 'mark done')
    .option('--undone', 'mark not done')
    .action(
      action(
        (
          context: Context,
          id: string,
          item: string,
          text: string[],
          options: { done?: boolean; undone?: boolean },
        ) => check(context, id, item, text, options),
      ),
    )

  program
    .command('label <id> <labels...>')
    .description('add labels; --rm to remove them')
    .option('--rm', 'remove instead')
    .action(
      action((context: Context, id: string, names: string[], options: { rm?: boolean }) =>
        labels(context, id, names, options),
      ),
    )

  program
    .command('due <id> <date...>')
    .description('set the due date (friday, +3d, 2026-10-02) or `none`')
    .action(action((context: Context, id: string, date: string[]) => due(context, id, date)))

  program
    .command('priority <id> <priority>')
    .description('set priority p0..p3, or `none`')
    .action(action((context: Context, id: string, level: string) => priority(context, id, level)))

  // --- Boards and people (§7.2) ----------------------------------------------
  const boards = program
    .command('boards')
    .description('list your boards')
    .action(action((context: Context) => boardsList(context)))
  boards
    .command('create <name...>')
    .description('create a board')
    .option('--slug <slug>', 'its short name (derived from the name otherwise)')
    .action(
      action((context: Context, name: string[], options: { slug?: string }) =>
        boardsCreate(context, name, options),
      ),
    )
  boards
    .command('rename <slug> <name...>')
    .description('rename a board')
    .action(
      action((context: Context, slug: string, name: string[]) => boardsRename(context, slug, name)),
    )
  boards
    .command('archive <slug>')
    .description('archive a board (asks first; --yes to skip)')
    .action(action((context: Context, slug: string) => boardsArchive(context, slug)))

  const columns = program
    .command('columns')
    .description('list this board’s columns')
    .action(action((context: Context) => columnsList(context)))
  columns
    .command('add <name...>')
    .description('add a column')
    .option('--after <column>', 'place it after this column')
    .action(
      action((context: Context, name: string[], options: { after?: string }) =>
        columnsAdd(context, name, options),
      ),
    )
  columns
    .command('rm <column>')
    .description('remove an empty column')
    .action(action((context: Context, column: string) => columnsRemove(context, column)))

  program
    .command('members')
    .description('who is on this board, with roles')
    .action(action((context: Context) => members(context)))

  program
    .command('share')
    .description('print how a teammate joins this board')
    .action(action((context: Context) => share(context)))

  program
    .command('invite <who>')
    .description('invite someone by email or @handle')
    .option('--role <role>', 'viewer, member (default) or owner')
    .action(
      action((context: Context, whom: string, options: { role?: string }) =>
        invite(context, whom, options),
      ),
    )

  program
    .command('who')
    .description('who is online, and what they are working on')
    .action(action((context: Context) => who(context)))

  program
    .command('activity')
    .description('what happened recently')
    .option('--since <duration>', 'only this far back, e.g. 2h, 1d')
    .option('--card <id>', 'only this card')
    .option('--limit <n>', 'at most n events (default 50)')
    .action(
      action((context: Context, options: { since?: string; card?: string; limit?: string }) =>
        activity(context, options),
      ),
    )

  program
    .command('feed')
    .description('stream the board’s events live, one per line (Ctrl-C to stop)')
    .action(action((context: Context) => feed(context)))

  // What the installed shims call. Hidden, and it can never fail a git command.
  program
    .command('__hook <name>', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (name: string, _options: unknown, command: Command) => {
      try {
        await hook(
          new Context(command.optsWithGlobals() as GlobalOptions, io),
          name,
          command.args.slice(1),
        )
      } catch {
        // Swallowed on purpose (§9.5).
      }
      finish(EXIT_OK)
    })

  // `yuzie` with no command opens the board (§7.1). Under a pipe there is no
  // screen to draw on, so it prints help instead. YUZIE_FORCE_TUI draws anyway
  // (the first-paint timing test uses it).
  // Unknown words reach this action as arguments; say so plainly rather than
  // Commander's "too many arguments".
  program.allowExcessArguments(true)
  program.action(async (...raw: unknown[]) => {
    const [word] = program.args
    if (word !== undefined) {
      const suggestion = closest(
        word,
        program.commands.map((command) => command.name()),
      )
      await action(async () => {
        throw new UsageError(
          `Unknown command "${word}".${suggestion === null ? '' : ` Did you mean \`yuzie ${suggestion}\`?`}`,
          'Run `yuzie --help` to see the commands.',
        )
      })(...raw)
      return
    }
    const terminal = io.stdout.isTTY === true || io.env.YUZIE_FORCE_TUI === '1'
    if (!terminal) {
      io.stdout.write(`${program.helpInformation()}\n`)
      finish(EXIT_OK)
      return
    }
    // Loaded on demand: the TUI's dependencies are most of the start-up time
    // of every other command.
    await action(async (context: Context) => (await import('./tui/run.js')).startTui(context))(
      ...raw,
    )
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
