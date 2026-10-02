---
"@yuzie/cli": minor
"@yuzie/core": minor
"@yuzie/sdk": minor
"@yuzie/server": minor
---

The rest of the command surface (SPEC.md §7.2, §14.3).

- **`yuzie link <board>` / `yuzie unlink`.** Attach this repository to a board you are already on,
  or detach it. The board stays on the server.
- **`yuzie export [--format json|md|csv] [-o file]`.**
  - JSON is the complete dump: board, columns, labels, members, cards with comments, checklists
    and commits, and the activity log.
  - Markdown and CSV are for people and spreadsheets.
- **`yuzie import <file>`.**
  - Reads a markdown checklist, a CSV, or JSON (a yuzie export or a list of cards); `-` reads
    stdin. Markdown round-trips with export.
  - `--dry-run` shows what would be created.
  - Unknown columns and people are reported, not guessed.
  - The new `POST /v1/boards/:slug/cards/import` creates up to 500 cards per request, all or
    nothing.
  - SDK: `board.cards.import()`.
- **`yuzie serve`.** Runs the server on this machine:
  - against `DATABASE_URL`, or a Postgres container it starts with Docker;
  - `@yuzie/server` now has a `yuzie-server` executable.
- **`yuzie account delete`.** Your tokens stop at once, and the handle can't sign in again.
  - Everything else of yours is purged within 30 days by a sweep in the server. Cards stay on
    their boards, without your name.
  - A board's only owner is asked to hand it over or archive it first.
  - Server: `DELETE /v1/me`. SDK: `client.account.delete()`.
- `pnpm --filter @yuzie/cli run docs:commands` regenerates the command reference. `pnpm docs` is
  pnpm's own command.
- Development: vitest 4.1.11, which clears two moderate dev-only advisories.
