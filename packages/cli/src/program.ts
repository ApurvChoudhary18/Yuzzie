/**
 * The `yuzie` command tree (SPEC.md §7). Every command funnels through
 * {@link run}, which owns the one place an exit code is decided (§7.4).
 */

import { Command, CommanderError, Option } from 'commander'
import type { AddOptions, ListOptions } from './commands/cards.js'
import type { ExportOptions, ImportOptions } from './commands/data.js'
import type { McpOptions } from './commands/mcp.js'
import type { ServeOptions } from './commands/serve.js'
import type { TokenCreateOptions } from './commands/tokens.js'
import type { Context, GlobalOptions, Io } from './context.js'
import { EXIT_OK, EXIT_USAGE, exitCodeFor, UsageError } from './exit.js'
import { VERSION } from './version.js'

/**
 * Each command's code loads when that command runs, not at start-up (§18 Session 16):
 * `yuzie --version` never parses the TUI, the editor's YAML or the MCP server.
 */
const lazy =
  <Module, Name extends keyof Module>(load: () => Promise<Module>, name: Name) =>
  async (...args: unknown[]) =>
    ((await load())[name] as (...args: unknown[]) => Promise<unknown>)(...args)

const loadAuth = () => import('./commands/auth.js')
const loadCards = () => import('./commands/cards.js')
const loadCode = () => import('./commands/code.js')
const loadCompletion = () => import('./commands/completion.js')
const loadData = () => import('./commands/data.js')
const loadDoctor = () => import('./commands/doctor.js')
const loadGit = () => import('./commands/git.js')
const loadHooks = () => import('./commands/hooks.js')
const loadInit = () => import('./commands/init.js')
const loadLink = () => import('./commands/link.js')
const loadMcp = () => import('./commands/mcp.js')
const loadServe = () => import('./commands/serve.js')
const loadSetup = () => import('./commands/setup.js')
const loadSync = () => import('./commands/sync.js')
const loadTeam = () => import('./commands/team.js')
const loadTokens = () => import('./commands/tokens.js')
const loadUpgrade = () => import('./commands/upgrade.js')

const login = lazy(loadAuth, 'login')
const logout = lazy(loadAuth, 'logout')
const whoami = lazy(loadAuth, 'whoami')
const add = lazy(loadCards, 'add')
const assign = lazy(loadCards, 'assign')
const check = lazy(loadCards, 'check')
const comment = lazy(loadCards, 'comment')
const done = lazy(loadCards, 'done')
const due = lazy(loadCards, 'due')
const edit = lazy(loadCards, 'edit')
const labels = lazy(loadCards, 'labels')
const list = lazy(loadCards, 'list')
const move = lazy(loadCards, 'move')
const priority = lazy(loadCards, 'priority')
const rm = lazy(loadCards, 'rm')
const show = lazy(loadCards, 'show')
const watch = lazy(loadCards, 'watch')
const anchor = lazy(loadCode, 'anchor')
const open = lazy(loadCode, 'open')
const completion = lazy(loadCompletion, 'completion')
const accountDelete = lazy(loadData, 'accountDelete')
const exportBoard = lazy(loadData, 'exportBoard')
const importCards = lazy(loadData, 'importCards')
const doctor = lazy(loadDoctor, 'doctor')
const branch = lazy(loadGit, 'branch')
const claim = lazy(loadGit, 'claim')
const commits = lazy(loadGit, 'commits')
const finishCard = lazy(loadGit, 'finish')
const hook = lazy(loadHooks, 'hook')
const init = lazy(loadInit, 'init')
const link = lazy(loadLink, 'link')
const unlink = lazy(loadLink, 'unlink')
const serve = lazy(loadServe, 'serve')
const mcp = lazy(loadMcp, 'mcp')
const configGet = lazy(loadSetup, 'configGet')
const configSet = lazy(loadSetup, 'configSet')
const hooksInstall = lazy(loadSetup, 'hooksInstall')
const hooksUninstall = lazy(loadSetup, 'hooksUninstall')
const sync = lazy(loadSync, 'sync')
const activity = lazy(loadTeam, 'activity')
const boardsArchive = lazy(loadTeam, 'boardsArchive')
const boardsCreate = lazy(loadTeam, 'boardsCreate')
const boardsList = lazy(loadTeam, 'boardsList')
const boardsRename = lazy(loadTeam, 'boardsRename')
const columnsAdd = lazy(loadTeam, 'columnsAdd')
const columnsList = lazy(loadTeam, 'columnsList')
const columnsRemove = lazy(loadTeam, 'columnsRemove')
const feed = lazy(loadTeam, 'feed')
const invite = lazy(loadTeam, 'invite')
const members = lazy(loadTeam, 'members')
const share = lazy(loadTeam, 'share')
const who = lazy(loadTeam, 'who')
const tokenCreate = lazy(loadTokens, 'tokenCreate')
const tokenList = lazy(loadTokens, 'tokenList')
const tokenRevoke = lazy(loadTokens, 'tokenRevoke')
const upgrade = lazy(loadUpgrade, 'upgrade')

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

/**
 * A newer version, mentioned at most once a day, to a person at a terminal
 * (§18 Session 17). Never delays or fails the command it follows.
 */
async function nudge(context: Context, command: string): Promise<void> {
  if (['upgrade', 'mcp', 'completion'].includes(command)) return
  // Only a person at a terminal: never a script, a pipe or a test runner.
  if (context.io.stderr.isTTY !== true) return
  try {
    const { afterCommand, checksAllowed } = await import('./update.js')
    const { config } = await context.config()
    const allowed = checksAllowed(context.io.env, {
      json: context.options.json === true,
      quiet: context.options.quiet === true,
      configured: config.ui.updateCheck,
    })
    if (!allowed) return
    const line = afterCommand(context.home, context.io.env, {
      execPath: process.execPath,
      script: process.argv[1],
    })
    if (line !== null) context.io.stderr.write(`${context.output.paint('dim', line)}\n`)
  } catch {
    // A version check is never the reason a command fails.
  }
}

/** `token create`, not just `create`: for the log. */
function commandPath(command: Command): string {
  const names: string[] = []
  for (let current: Command | null = command; current?.parent; current = current.parent)
    names.unshift(current.name())
  return names.join(' ')
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
      // The terminal's width when there is one; 80 otherwise, so the generated
      // command reference (docs/commands.md) is the same on every machine.
      getOutHelpWidth: () => (io.stdout as { columns?: number }).columns ?? 80,
      getErrHelpWidth: () => (io.stderr as { columns?: number }).columns ?? 80,
    })
    .exitOverride()

  /** Run a handler with a fresh context, and turn whatever happens into an exit code. */
  const action =
    (handler: Handler) =>
    async (...raw: unknown[]): Promise<void> => {
      // commander calls actions with (…positional args, options, command).
      const command = raw.at(-1) as Command
      const { Context } = await import('./context.js')
      const context = new Context(command.optsWithGlobals() as GlobalOptions, io)
      context.output.debug(`yuzie ${VERSION} · ${command.name()}`)
      const started = Date.now()
      const name = commandPath(command)
      context.log.log('info', 'command', { command: name, version: VERSION })
      try {
        const body = handler as (context: Context, ...args: unknown[]) => Promise<unknown>
        const code = await body(context, ...raw.slice(0, -1))
        const exitCode = typeof code === 'number' ? code : EXIT_OK
        context.log.log('info', 'done', { command: name, exitCode, ms: Date.now() - started })
        finish(exitCode)
      } catch (error) {
        context.output.error(error)
        context.output.debug(
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        )
        const exitCode = exitCodeFor(error)
        // The stack goes to the log, never to the terminal without --verbose.
        context.log.log(exitCode === 1 ? 'error' : 'warn', 'failed', {
          command: name,
          exitCode,
          ms: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
          code: (error as { code?: unknown } | null)?.code,
          stack: error instanceof Error ? error.stack : undefined,
        })
        finish(exitCode)
      } finally {
        context.prompter.close()
        // Nothing left in flight keeps the process alive after the command.
        context.abortRequests()
        await nudge(context, name)
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
    .command('link <board>')
    .description('attach this repository to an existing board')
    .action(action((context: Context, slug: string) => link(context, slug)))

  program
    .command('unlink')
    .description('detach this repository from its board (the board stays on the server)')
    .action(action((context: Context) => unlink(context)))

  const account = program.command('account').description('your account on this server')
  account
    .command('delete')
    .description('delete your account: tokens stop now, everything else goes within 30 days')
    .option('--confirm <handle>', 'your handle, to delete without being asked')
    .action(
      action((context: Context, options: { confirm?: string }) => accountDelete(context, options)),
    )

  program
    .command('doctor')
    .description('check node, git, sign-in, server, hooks and cache')
    .option(
      '--bundle [file]',
      'also write a redacted diagnostic bundle (versions, config, last 200 log lines, git facts)',
    )
    .action(
      action((context: Context, options: { bundle?: boolean | string }) =>
        doctor(context, options),
      ),
    )

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
    .option('--agent', 'for agents and scripts: never prompt, stop on uncommitted work')
    .action(
      action(
        (
          context: Context,
          reference: string,
          options: { branch?: boolean; from?: string; force?: boolean; agent?: boolean },
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
    .command('sync')
    .description('push queued changes, pull the board, re-scan git, and report what happened')
    .option('--rebuild', 'clear the cached board first and rebuild it (queued changes are kept)')
    .option('--retry-set-aside', 'put changes the server kept refusing back in the queue')
    .option('--drop-set-aside', 'give up on changes the server kept refusing')
    .action(
      action(
        (
          context: Context,
          options: { rebuild?: boolean; retrySetAside?: boolean; dropSetAside?: boolean },
        ) => sync(context, options),
      ),
    )

  program
    .command('anchor <id> <location>')
    .description('attach a code location (file:line or file:start-end) to a card')
    .action(
      action((context: Context, reference: string, location: string) =>
        anchor(context, reference, location),
      ),
    )

  program
    .command('open <id>')
    .description('open the card’s code in $EDITOR, or its PR / branch / link in a browser')
    .option('--github', 'the PR if there is one, else the branch compare view')
    .option('--pr', 'the pull request (falls back to the compare view)')
    .option('--browser', 'the link attached to the card')
    .action(
      action(
        (
          context: Context,
          reference: string,
          options: { github?: boolean; pr?: boolean; browser?: boolean },
        ) => open(context, reference, options),
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
    .option('--author <handle>', 'only what this person did')
    .option('--limit <n>', 'at most n events per page (default 50)')
    .option('--before <seq>', 'the page before this one (the `next` a page printed)')
    .action(
      action(
        (
          context: Context,
          options: {
            since?: string
            card?: string
            author?: string
            before?: string
            limit?: string
          },
        ) => activity(context, options),
      ),
    )

  const token = program.command('token').description('API tokens for CI, scripts and agents')
  token
    .command('create <name>')
    .description('create a token; the plaintext is shown once')
    .option('--role <role>', 'owner, member or viewer (default member)')
    .option('--all-boards', 'do not scope it to one board (default: this board, or --board)')
    .option('--agent <handle>', 'issue it to an agent, who joins the board as that handle')
    .option('--allow-destructive', 'let the agent delete cards')
    .option('--expires <duration>', 'expire after e.g. 30d or 12h')
    .action(
      action((context: Context, name: string, options: TokenCreateOptions) =>
        tokenCreate(context, name, options),
      ),
    )
  token
    .command('list')
    .description('your tokens and the ones you issued to agents')
    .action(action((context: Context) => tokenList(context)))
  token
    .command('revoke <token>')
    .description('revoke by id, id prefix or name')
    .action(action((context: Context, reference: string) => tokenRevoke(context, reference)))

  program
    .command('completion <shell>')
    .description('print shell completion for bash, zsh or fish (see `yuzie completion --help`)')
    .addHelpText(
      'after',
      `
Install:
  bash  echo 'eval "$(yuzie completion bash)"' >> ~/.bashrc
  zsh   echo 'eval "$(yuzie completion zsh)"' >> ~/.zshrc
  fish  yuzie completion fish > ~/.config/fish/completions/yuzie.fish

Card numbers and column names are completed from the local cache, offline.`,
    )
    .action(action((context: Context, shell: string) => completion(context, shell)))

  program
    .command('export')
    .description('export the board: everything as JSON, or cards as markdown or CSV')
    .addOption(
      new Option('--format <format>', 'json (complete), md or csv; else from --output').choices([
        'json',
        'md',
        'csv',
      ]),
    )
    .option('-o, --output <file>', 'write to a file instead of stdout')
    .action(action((context: Context, options: ExportOptions) => exportBoard(context, options)))

  program
    .command('import <file>')
    .description('create cards from JSON, CSV or a markdown checklist (- for stdin)')
    .addOption(
      new Option('--format <format>', 'json, csv or md; else from the extension').choices([
        'json',
        'md',
        'csv',
      ]),
    )
    .option('--column <column>', 'where cards with no (known) column go; default the first')
    .option('--dry-run', 'show what would be created, and create nothing')
    .action(
      action((context: Context, file: string, options: ImportOptions) =>
        importCards(context, file, options),
      ),
    )

  program
    .command('serve')
    .description('run the board server on this machine (Postgres from DATABASE_URL, or Docker)')
    .option('--port <port>', 'port to listen on (default 8787, or PORT)')
    .option('--host <host>', 'address to bind (default 127.0.0.1, or HOST)')
    .option('--database-url <url>', 'Postgres to use (default DATABASE_URL, else a container)')
    .action(action((context: Context, options: ServeOptions) => serve(context, options)))

  program
    .command('upgrade')
    .description('install the latest yuzie, the way this one was installed')
    .option('--dry-run', 'say what would run, and run nothing')
    .action(action((context: Context, options: { dryRun?: boolean }) => upgrade(context, options)))

  program
    .command('mcp')
    .description('serve the board to an AI agent over MCP (stdio)')
    .option('--allow-destructive', 'let the agent delete cards (its token must allow it too)')
    .option('--allow-git', 'let the agent claim cards, creating and checking out branches')
    .option('--audit-log <file>', 'also append the audit log to this file')
    .action(action((context: Context, options: McpOptions) => mcp(context, options)))

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
        const { Context } = await import('./context.js')
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

/** The command tree, for the generated command reference (§18 Session 17). */
export function commandTree(io: Io): Command {
  return build(io, () => {})
}

/** Run the CLI; resolves to the exit code instead of exiting, so it is testable. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  let exitCode: number | undefined
  const finish = (code: number) => {
    exitCode ??= code
  }
  const program = build(io, finish)

  // The once-a-day background version check (§18 Session 17): no output, ever.
  if (argv[0] === '__update-check') {
    const { updateCheck } = await import('./update.js')
    const { homedir } = await import('node:os')
    await updateCheck(io.home ?? io.env.HOME ?? homedir(), io.env).catch(() => {})
    return EXIT_OK
  }

  // Shell completion (§18 Session 17): the words after `__complete` are the
  // user's half-typed command line, so they are never parsed as our own flags.
  if (argv[0] === '__complete') {
    const { Context } = await import('./context.js')
    const { complete } = await import('./commands/completion.js')
    try {
      await complete(new Context({}, io), program, argv[1] ?? '', argv.slice(2))
    } catch {
      // Completion never prints an error into someone's prompt.
    }
    return EXIT_OK
  }

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
