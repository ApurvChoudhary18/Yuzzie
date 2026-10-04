# Yuzie

**A real-time, Git-aware kanban board for your team, in your terminal. `npx yuzie`.**

> Yuzie is Trello for developers who never leave the terminal — except it knows what
> branch you're on.

<p align="center">
  <img src="docs/demo.svg" alt="The yuzie board in a terminal: a teammate's card move arrives live, a card opens with its branch, commits and checklist, and is moved to Review." width="100%">
</p>

<sub>Recorded from the real TUI in a real terminal against a real server
(`e2e/src/demo.record.test.ts`), not drawn.</sub>

---

## Why

Developers spend their day in the terminal and the editor. Project tracking lives somewhere
else — a browser tab that costs a context switch every time. Existing terminal task tools
solve this by being single-player and Git-ignorant: a local TODO file with nicer rendering.
They break the moment a second person joins.

Yuzie takes the opposite position. It is **multiplayer first** and **Git-aware first**:

- Every teammate connected to the same board sees changes instantly — card moves,
  assignments, comments, and who is currently working on what.
- Cards are bound to real repository state. A card knows its branch, its commit count, its
  changed files, its PR, and the exact file and line where the work lives.
- `yuzie claim 18` assigns the card, creates `task/18-fix-github-oauth`, checks it out, and
  broadcasts "@rahul is working on #18" to everyone else's terminal.

It ships as a **CLI first, TUI second**. Every operation is available as a one-shot command
that composes with shell pipelines and scripts (`yuzie list --json | jq`). Running `yuzie`
with no arguments opens the full interactive board.

Underneath both is a typed SDK (`@yuzie/sdk`), so a VS Code extension, a web dashboard, a CI
job, or an AI agent can all drive the same board.

## Sixty seconds

You need Node 22+ and git, and a server. There is no hosted Yuzie: run `yuzie serve` on your
machine to try it (the CLI looks there by default), or [self-host one](docs/self-hosting.md) for
your team in two minutes with Docker. Then, in any repository:

```console
$ npm install -g yuzie                  # or put `npx yuzie@latest` wherever `yuzie` appears
$ export YUZIE_SERVER=https://yuzie.example.com/v1   # your team's server; leave unset for `yuzie serve` here
$ yuzie init
✓ Git repository detected: payments-api (github.com/acme/payments-api)
✓ Signed in as @rahul
✓ Board "payments-api" created
✓ Installed git hooks (post-commit, post-checkout)
$ git add .yuzie .gitignore && git commit -m "Track work on Yuzie"

$ yuzie add "Fix GitHub OAuth"          # → #1
$ yuzie claim 1                         # assigns you, creates task/1-fix-github-oauth, checks it out
$ git commit -am "Keep state per attempt (#1)"   # the hook links it to the card
$ yuzie                                 # the live board; ? for keys
```

`yuzie` and `yz` are the same program, and so are the `yuzie` and `@yuzie/cli` packages. For
Tab completion, add `eval "$(yuzie completion zsh)"` to your shell's startup file (or `bash`,
or `fish`).

## Commands

Every command composes with pipes: `--json` prints exactly one JSON document, and exit codes
are stable (see the [FAQ](docs/faq.md)).

| | |
| --- | --- |
| Set up | `init` `link` `unlink` `login` `logout` `whoami` `account` `doctor` `config` `hooks` `completion` `upgrade` |
| Cards | `add` `list` `card` `move` `done` `assign` `comment` `edit` `rm` `watch` `unwatch` `check` `label` `due` `priority` |
| Git | `claim` `start` `finish` `branch` `commits` `anchor` `open` `sync` |
| Team | `boards` `columns` `members` `share` `invite` `who` `activity` `feed` `token` |
| Data | `export` `import` `serve` |
| Agents | `mcp` |

The full reference — every flag of every command, generated from the program itself — is
[docs/commands.md](docs/commands.md).

## Documentation

- [Command reference](docs/commands.md)
- [Keys in the board](docs/keybindings.md)
- [Self-hosting](docs/self-hosting.md): one compose file
- [Agents and MCP](docs/agents.md): an AI agent as a board member
- [SDK](docs/sdk.md): `@yuzie/sdk`, for your own tools
- [Privacy](docs/privacy.md)
- [FAQ](docs/faq.md)

## Agents

An AI coding agent joins the board as a member, marked `(agent)`. Issue it a scoped token with
`yuzie token create`, then give it the MCP server:

```sh
claude mcp add yuzie -e YUZIE_TOKEN=yz_… -- yuzie mcp --board payments-api
```

It can list, create, move and comment on cards, and tick checklists. Claiming (git) and deleting
are off unless you pass `--allow-git` or `--allow-destructive`. Every call is audited. See
[docs/agents.md](docs/agents.md).

## Privacy

**No repository code is ever sent to the server.** Only derived numbers — commit count, file
count, branch name, the file path of an anchor — and commit SHAs/messages that you have
explicitly linked. There is no telemetry. Self-hosting is a first-class, documented path. See
[docs/privacy.md](docs/privacy.md).

## When something goes wrong

- `yuzie doctor` checks node, git, sign-in, the server, hooks and the cache, and says the command
  that fixes each problem.
- `yuzie doctor --bundle` also writes a diagnostic file to attach to an issue. It contains:
  - versions and the checks;
  - config and environment, with every token, password and your home directory redacted;
  - the last 200 log lines;
  - facts about your git repository.

  Read it before you share it.
- `~/.yuzie/logs/yuzie.log` holds a JSON line for every command. It is rotated at 5 MB, keeps three
  old files, and is also redacted. Set `YUZIE_LOG=off` to turn it off.
- Every error is one line saying what went wrong and what to do about it, with the exit code set by
  §7.4. A stack trace appears only with `--verbose`.

## Status

All 18 sessions of [`SPEC.md`](./SPEC.md) §18 are complete, along with a follow-up that
finished the rest of the command surface: `link`, `unlink`, `export`, `import`, `serve` and
account deletion.

| Milestone | Sessions | State |
| --- | --- | --- |
| M0 — Foundation | 0–2 | Complete |
| M1 — Server alive | 3–4 | Complete |
| M2 — CLI usable | 5–7 | Complete |
| M3 — TUI usable | 8–10 | Complete |
| M4 — Git-aware | 11–12 | Complete |
| M5 — Resilient | 13–14 | Complete |
| M6 — Agents | 15 | Complete |
| M7 — Launch | 16–17 | Complete |

The release pipeline is in place (see [RELEASE.md](RELEASE.md)), and nothing has been published
yet.

## Repository layout

```
packages/
  core/     @yuzie/core    types, zod schemas, events, reducer, rank, slug
  store/    @yuzie/store   local SQLite cache + offline outbox
  sdk/      @yuzie/sdk     typed client: http, realtime, offline queue
  git/      @yuzie/git     repo introspection, branches, commits, hooks
  cli/      @yuzie/cli     the `yuzie` binary and Ink TUI
  server/   @yuzie/server  Fastify REST API + WebSocket gateway (and its Dockerfile)
  mcp/      @yuzie/mcp     MCP stdio server for AI agents
  yuzie/    yuzie          the unscoped alias, so `npx yuzie` works
deploy/                    the self-hosting compose file
docs/                      user documentation
e2e/                       cross-package end-to-end tests (journeys §6)
scripts/                   package and release checks
```

## Development

Requires Node 22+ (CI covers 22 and 24) and pnpm.

```sh
pnpm install
pnpm turbo build test lint typecheck    # the full pipeline
node packages/cli/dist/index.js --version
pnpm turbo bench --concurrency=1        # timing budgets, run alone (includes the load test)
pnpm --filter @yuzie/server load        # 25 clients × 2,000 cards × 100 events/s, on its own
pnpm --filter @yuzie/cli budget         # install size < 4 MB; `list --json` p50 < 150 ms (needs hyperfine)
pnpm --filter @yuzie/cli run docs:commands   # regenerate docs/commands.md after changing a command
node scripts/check-packages.mjs         # every export loads under import and require; arethetypeswrong
```

Local service dependencies for the server (from Session 3 onwards):

```sh
docker compose up -d postgres           # postgres 16 (add redis for multi-node)
DATABASE_URL=postgres://yuzie:yuzie@127.0.0.1:5432/yuzie \
  pnpm --filter @yuzie/server start     # http://127.0.0.1:8787, after a build
YUZIE_SERVER=http://127.0.0.1:8787/v1 node packages/cli/dist/index.js login
```

With no GitHub app configured, sign-in is approved by posting the code and a handle to
`POST /v1/auth/device/approve`; `YUZIE_PUBLIC_URL` sets the address the device page is
advertised at (it defaults to this server's own port).

Redis is optional. Without `REDIS_URL` the realtime gateway fans out in-process, which is all
a single node needs; set it when running more than one server node behind a load balancer.

`@yuzie/server`'s tests run against a real Postgres through
[testcontainers](https://node.testcontainers.org/), so they need a Docker runtime. Docker
Desktop, colima and Rancher all work — the suite reads your active `docker context`, so no
environment variables are required.

Every user-visible change needs a changeset:

```sh
pnpm changeset
```

See [`SPEC.md`](./SPEC.md) Appendix E for the definition of done that applies to every
session, and [RELEASE.md](RELEASE.md) for how a release is cut.

## License

[MIT](LICENSE) © 2026 Apurv Choudhary
