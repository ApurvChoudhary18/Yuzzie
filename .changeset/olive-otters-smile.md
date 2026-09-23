---
"@yuzie/store": minor
---

Session 2: implement the local cache and offline outbox.

- Two drivers behind one interface: SQLite via `better-sqlite3` (an **optional**
  dependency) and a pure-JSON fallback. §17 requires `npx yuzie` to work where the native
  module will not build, so the fallback is held to the identical 64-test conformance
  suite rather than treated as a toy.
- The §11.3 schema with versioned migrations: `cards`, `columns`, `comments`,
  `checklist_items` and `git_links` denormalised, plus `sync_state` and `outbox`. WAL mode
  and transactional writes.
- Repositories for cards, columns, comments, checklist, git, events, sync state and outbox,
  all scoped by board slug so one file can hold several boards.
- `applyEventToCache` folds server events in by reading a state slice, running
  `@yuzie/core`'s reducer, and writing back the difference — the reducer is not
  reimplemented, so a cached board and an in-memory board cannot diverge.
- Outbox with idempotency-key deduplication, attempt/error bookkeeping and jittered
  exponential backoff. A failing write stops the drain so queued writes stay ordered.
- Cache location resolution: `.yuzie/cache/yuzie.db` inside a repo, `~/.yuzie/cache/<slug>.db`
  outside one, overridable with `YUZIE_CACHE_DIR`. Driver selectable with `YUZIE_CACHE_DRIVER`.
