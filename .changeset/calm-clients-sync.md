---
"@yuzie/sdk": minor
"@yuzie/core": minor
"@yuzie/server": minor
---

Session 5: `@yuzie/sdk`, the typed client every front end consumes (SPEC.md §13.1).

- **`@yuzie/sdk`**: `Yuzie.connect(slug, opts)` returns a board with `cards`, `boards`,
  `members` and `comments` resources, `on(type, handler)` typed per event, presence, and
  `close()`. `board.state` is always readable synchronously: server state folded through
  `@yuzie/core`'s reducer, with this client's unconfirmed writes applied on top. A write
  settles on its response or its own event echoing back; a 409 rolls it back to the server's
  card and emits `conflict`. With `offline: "queue"` writes go to the outbox (the store's,
  when a cache is passed) and `sync()` drains them in order with their original idempotency
  keys. HTTP retries 5xx/429/network failures with backoff; errors are the typed classes.
  The realtime client reconnects with jittered backoff, heartbeats, and fills stream gaps
  from the log. The core entry has no Node-only imports and runs in a browser;
  `@yuzie/sdk/node` adds credential resolution (env → keychain → `~/.yuzie/credentials`).
- **Event fidelity (`@yuzie/core`, `@yuzie/server`)**: a client folding the event log now
  reaches exactly the card `GET /cards` returns. Each mutation uses one clock for its stored
  timestamps and its events; card events carry the card's resulting `version` (stored, so
  replays have it too — migration 0003); git and commit events carry the values the server
  stored; watching a card emits an event without bumping the version; assignees fold in
  handle order, as the server returns them.
