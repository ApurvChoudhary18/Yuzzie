# Contributing to Yuzie

Thanks for helping. This page covers setting up, the checks a change has to pass, and how a
change gets merged.

## Set up

You need:
- Node 22 or 24;
- pnpm (via `corepack enable`);
- Docker (Docker Desktop, colima or Rancher), because the server and end-to-end tests run
  against a real Postgres through testcontainers.

```sh
pnpm install
pnpm turbo build
node packages/cli/dist/index.js --version
```

To try your build against a server: `node packages/cli/dist/index.js serve` runs one on this
machine, and the CLI looks there by default.

## Before you open a pull request

```sh
pnpm turbo build test lint typecheck    # all of it, as CI runs it
pnpm turbo bench --concurrency=1        # if you touched anything timing-sensitive
pnpm --filter @yuzie/cli budget         # install size and start-up time (needs hyperfine)
```

- **Formatting and lint.** Biome checks both. `pnpm biome check --write .` fixes most of it.
  Warnings fail the build.
- **Changing a command, flag or description:** run
  `pnpm --filter @yuzie/cli run docs:commands`. A test fails when `docs/commands.md` and
  `--help` disagree.
- **A user-visible change needs a changeset:** run `pnpm changeset` and say what changed for
  the person using yuzie. Every package is versioned together.
- **Behaviour comes with a test.** Commands are tested through the built binary in `e2e/`, the
  server against Postgres, and the board in a real pseudo-terminal.

## Where things live

| Directory | What |
| --- | --- |
| `packages/core` | Types, zod schemas, events, the reducer: the contract everything else shares |
| `packages/server` | Fastify API, WebSocket gateway, Postgres |
| `packages/sdk` | The typed client the CLI, the board and agents use |
| `packages/cli` | The `yuzie` binary and the board (Ink) |
| `packages/store`, `packages/git`, `packages/mcp` | Local cache, git introspection, the MCP server |
| `e2e/` | The journeys from SPEC.md §6, end to end |
| `docs/` | What users read |

[`SPEC.md`](SPEC.md) is the design. Appendix E is the definition of done for any change.

## Reporting a bug

Open an issue with the bug report form. It asks for `yuzie doctor`'s output, which answers most
first questions.

## Pull requests

CI runs the full pipeline on Node 22 and 24, on Linux and macOS, plus:
- the package checks;
- the self-hosting guide, followed verbatim;
- a clean-machine `npx yuzie@latest` run.

Pull requests are rebase-merged, so keep commits meaningful and their messages clear.
