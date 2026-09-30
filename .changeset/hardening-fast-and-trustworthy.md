---
"@yuzie/cli": minor
"@yuzie/core": minor
"@yuzie/sdk": minor
"@yuzie/store": minor
"@yuzie/server": minor
"@yuzie/git": patch
---

Session 16: hardening. The CLI is faster, much smaller, and safer to point at hostile data.

- **Install size: 85 MB → 1.5 MB (0.4 MB to download).**
  - The CLI is one tree-shaken, minified bundle with no runtime dependencies.
  - SQLite now comes from Node itself (`node:sqlite`), which removes the native better-sqlite3
    build. A Node older than 22.13 falls back to the JSON cache.
  - OS notifications use the system's own notifier instead of node-notifier.
  - A size check in CI keeps the install under 4 MB.
- **Startup.**
  - Each command's code loads only when it runs.
  - Node's compile cache is on.
  - Config no longer runs git subprocesses to find the repository.
  - The SDK no longer loads the WebSocket implementation unless it streams.
  - The CLI makes its requests with `node:http` (the new `nodeFetch` in `@yuzie/sdk/node`) instead of
    the global `fetch`, whose undici implementation cost about 35 ms to load. A request to a server
    that goes silent is abandoned after 300 s, as undici's are.
  - The board and `feed` stream over the `ws` package (the new `@yuzie/sdk/websocket` entry)
    instead of Node's global WebSocket, whose undici implementation added 20–30 MB. The TUI on a
    500-card board now peaks at about 99 MB on Node 22 and 106 MB on Node 24 (budget 120 MB).
  - The shared cache waits up to 5 s for another process's write lock, as better-sqlite3 did,
    instead of failing with "database is locked".
  - One-shot commands exit as soon as their output is flushed.
  - `list` fetches the board once, and fetches the board and `/me` together.
  - An unchanged refresh no longer rewrites the cache.
  - `yuzie list --json` p50 is about 87 ms locally (it was about 142 ms), and hyperfine enforces
    under 150 ms in CI.
- **Server throughput.**
  - A card and everything on it load in one query instead of ten.
  - Events are appended with one read and one multi-row insert.
  - Auto-watch is one statement.
  - A write to a board went from about 23 queries to 12, which lifted the ceiling above 100 writes
    a second. The new load test (25 clients × 2,000 cards × 100 events/s) holds p95 propagation
    around 90–175 ms, with a 250 ms budget.
- **Hostile input.**
  - Titles, names, labels, comments and checklist items can no longer contain control
    characters. The API refuses them with a message naming the character, where a NUL used to be
    a Postgres error.
  - Anything already stored is drawn as `�`, in the CLI and the TUI alike, so a card title can
    no longer clear someone's screen or retitle their window.
- **Diagnostics.**
  - `yuzie doctor --bundle` writes a redacted diagnostic file.
  - `~/.yuzie/logs/yuzie.log` is a structured log, rotated at 5 MB.
  - A crash handler gives back the terminal, prints one line and logs the stack.
  - SIGINT, SIGTERM and SIGHUP exit with conventional codes, and the TUI restores the screen
    first.
  - `yuzie list | head` no longer prints an EPIPE stack trace.
- **Fixes found while demoing.**
  - Tokens now record when they were last used.
  - Activity says which checklist item was added.
  - `yuzie card` marks agents in comments, presence and watchers.
