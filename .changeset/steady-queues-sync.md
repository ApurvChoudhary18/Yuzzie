---
"@yuzie/sdk": minor
"@yuzie/store": minor
"@yuzie/cli": minor
"@yuzie/core": minor
---

Session 13: offline mode and the sync engine. The tool is never blocked by the network.

- **`@yuzie/store`**: outbox quarantine (schema 2, migrating existing caches): set aside, list,
  release, remove.
- **`@yuzie/sdk`**
  - A reachability probe (`reachabilityTimeoutMs`, 250 ms in the CLI): a dead or black-holed
    network costs the budget, not a timeout. Once the server is known to be unreachable, no
    request is attempted.
  - A queued write carries its "shadow", so every later process shows it until it's sent.
  - The drain is ordered and idempotent. A write the server refuses is tried three times and
    then set aside, and only that card's later writes wait behind it. Conflicts come with the
    server's card and who changed it first. Several offline edits to one card no longer
    conflict with each other.
  - `board.open()` sends queued writes first when the server is reachable. `sync()` is push,
    then pull. New: `board.quarantine`, `retryQuarantined()` and `discardQuarantined()`.
  - Adding a checklist item is optimistic, so it works offline.
- **`@yuzie/cli`**
  - Every board command works with the server down. Reads come from the cache, labelled
    `offline · cached 5m ago`. Writes queue and say so, including in `--json` meta.
  - `yuzie list` marks changes not yet sent with `◌`.
  - `yuzie sync [--rebuild] [--retry-set-aside] [--drop-set-aside]` pushes, pulls, re-scans git
    and attributes buffered commits, and prints a reconciliation report.
  - `yuzie doctor` reports queued and set-aside changes.
  - Any command that finds queued writes sends them first and reports the outcome.
- **`@yuzie/core`**: `SyncReport` and `QueuedCard` envelopes. Cards created offline appear in
  `--json` as `QueuedCard` (`list` puts them in `meta.provisional`).
