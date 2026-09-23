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
| M1 — Server alive | 3–4 | Not started |
| M2 — CLI usable | 5–7 | Not started |
| M3 — TUI usable | 8–10 | Not started |
| M4 — Git-aware | 11–12 | Not started |
| M5 — Resilient | 13–14 | Not started |
| M6 — Agents | 15 | Not started |
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

Requires Node 20+ (CI covers 20, 22, 24) and pnpm.

```sh
pnpm install
pnpm turbo build test lint typecheck    # the full pipeline
node packages/cli/dist/index.js --version
```

Local service dependencies for the server (from Session 3 onwards):

```sh
docker compose up -d                    # postgres 16 + redis 7
```

Every user-visible change needs a changeset:

```sh
pnpm changeset
```

See [`SPEC.md`](./SPEC.md) Appendix E for the definition of done that applies to every
session.

## Privacy

**No repository code is ever sent to the server.** Only derived numbers — commit count, file
count, branch name, the file path of an anchor — and commit SHAs/messages that you have
explicitly linked. Telemetry is off by default and opt-in. Self-hosting is a first-class,
documented path. See spec §14.3.

## License

MIT
