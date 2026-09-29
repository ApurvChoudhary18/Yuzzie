# Yuzie

**A real-time, Git-aware kanban board for your team, in your terminal. `npx yuzie`.**

> Yuzie is Trello for developers who never leave the terminal — except it knows what
> branch you're on.

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

## Status

🚧 **In development.** Built against [`SPEC.md`](./SPEC.md) across 18 discrete sessions
(spec §18). Nothing is published to npm yet.

| Milestone | Sessions | State |
| --- | --- | --- |
| M0 — Foundation | 0–2 | Complete |
| M1 — Server alive | 3–4 | Complete |
| M2 — CLI usable | 5–7 | Complete |
| M3 — TUI usable | 8–10 | Complete |
| M4 — Git-aware | 11–12 | Complete |
| M5 — Resilient | 13–14 | Complete |
| M6 — Agents | 15 | Complete |
| M7 — Launch | 16–17 | Not started |

## Repository layout

```
packages/
  core/     @yuzie/core    types, zod schemas, events, reducer, rank, slug
  store/    @yuzie/store   local SQLite cache + offline outbox
  sdk/      @yuzie/sdk     typed client: http, realtime, offline queue
  git/      @yuzie/git     repo introspection, branches, commits, hooks
  cli/      @yuzie/cli     the `yuzie` binary and Ink TUI
  server/   @yuzie/server  Fastify REST API + WebSocket gateway
  mcp/      @yuzie/mcp     MCP stdio server for AI agents
e2e/                       cross-package end-to-end tests (journeys §6)
```

## Development

Requires Node 22+ (CI covers 22 and 24) and pnpm.

```sh
pnpm install
pnpm turbo build test lint typecheck    # the full pipeline
node packages/cli/dist/index.js --version
pnpm turbo bench --concurrency=1        # timing budgets, run alone
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
session.

## Agents

An AI coding agent works on the board as a member of its own, marked `(agent)` everywhere a
person would see its work: presence, the card view, activity and the live feed.

**1. Issue the agent a token** (board owners only). The agent joins the board under that handle.
The token can be at most a member, and it only works on this board. The plaintext is printed
once and never stored.

```sh
yuzie token create claude-agent --agent claude            # add --allow-destructive to let it delete cards
yuzie token list                                          # yours, and the ones you issued to agents
yuzie token revoke claude-agent
```

**2. Give it the MCP server.** For Claude Code:

```sh
claude mcp add yuzie -e YUZIE_TOKEN=yz_… -- yuzie mcp --board payments-api
```

or, in any MCP host's configuration file:

```json
{
  "mcpServers": {
    "yuzie": {
      "command": "yuzie",
      "args": ["mcp", "--board", "payments-api"],
      "env": { "YUZIE_TOKEN": "yz_…" }
    }
  }
}
```

The server exposes the following tools:

| Tool | What it does |
| --- | --- |
| `board_list_cards` | List cards, with filters |
| `board_get_card` | Show one card |
| `board_create_card` | Create a card |
| `board_move_card` | Move a card |
| `board_comment` | Comment on a card |
| `board_update_checklist` | Tick or add checklist items |
| `board_claim_card` | Claim a card (needs `--allow-git`) |
| `board_delete_card` | Delete a card (needs `--allow-destructive`) |

**Guardrails.**
- `--allow-git` lets the agent claim a card. Claiming creates and checks out a branch in the
  agent's checkout. It refuses rather than stash anyone's uncommitted work.
- `--allow-destructive` lets the agent delete cards, and only works if the token was issued with
  `--allow-destructive` as well. The server enforces this, not just the MCP process.
- Without these flags, the agent's call is refused with an explanation, and nothing happens.
- Every tool call is written to an audit log on stderr, one JSON line per call. Add
  `--audit-log <file>` to keep a copy.

**Agent etiquette.** The server's instructions tell the agent to:
- narrate its progress with `board_comment`: what it's about to do, what it did, and what's left;
- tick checklist items as it finishes them;
- move the card to review when it's done, rather than to done;
- never delete anything silently. If something should go, it says so in a comment and lets a
  person decide.

From a shell, `yuzie claim 27 --agent` claims a card without ever prompting.

## Privacy

**No repository code is ever sent to the server.** Only derived numbers — commit count, file
count, branch name, the file path of an anchor — and commit SHAs/messages that you have
explicitly linked. Telemetry is off by default and opt-in. Self-hosting is a first-class,
documented path. See spec §14.3.

## License

MIT
