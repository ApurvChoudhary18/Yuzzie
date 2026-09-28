---
"@yuzie/core": minor
"@yuzie/server": minor
"@yuzie/sdk": minor
"@yuzie/cli": minor
---

Session 14: watching, activity, notifications and search.

- **`@yuzie/core`**
  - `matchesSearch`: every word, case-insensitive, in the number, title, description, comments,
    labels or assignees. The server, the CLI offline and the TUI all use it.
  - `isStale`, `claimTimes` and `durationMs`. A claimed, in-progress card is stale when it was
    claimed at least that long ago with no commits since. Any other unfinished card is stale
    when nothing has happened to it.
  - `Board.autoWatch`. `card.assigned` and `comment.created` carry who started watching.
  - `ActivityQuery` and `ActivityPage`. JSON meta may carry `next`.
- **`@yuzie/server`**
  - Auto-watch: commenting on a card, or being assigned to it, starts watching it. On by
    default; turn it off with `PATCH /boards/:slug {autoWatch: false}`.
  - `GET /boards/:slug/cards`:
    - `search` narrows in SQL (ILIKE, with `%` and `_` taken literally), including comment
      bodies, labels and assignee handles.
    - New `mine`, `watching` and `stale=<duration>` filters. `stale` reads claim times from the
      event log.
  - `GET /boards/:slug/activity?before=&card=&actor=&from=&limit=`: the log read backwards a
    page at a time, in `seq` order within each page, with a `next` cursor.
  - Migration 0004 adds `boards.auto_watch` and an index on events by card.
- **`@yuzie/sdk`**
  - `board.boards.activity(query)`.
  - Card filters gain `mine`, `watching` and `stale`.
  - `listLocal` uses the core matcher and staleness.
- **`@yuzie/cli`**
  - `yuzie list`:
    - `--search` reaches comments, labels and assignees.
    - `--search` and `--stale` ask the server when it's reachable and fall back to the cache
      when it isn't.
  - `yuzie activity`:
    - Adds `--author` and `--before <seq>` paging.
    - Output is stable, oldest to newest within a page.
    - Prints an `Older:` hint, and `meta.next` in `--json`.
  - TUI:
    - `A` opens the board activity drawer.
    - `/` searches descriptions and comments too.
    - `f` adds Watching and Stale (2 or 7 days).
    - News about a card you watch shows as a ★ toast and is the last to be dropped from a full
      queue.
    - Optional OS notifications through node-notifier, off by default (`ui.notifications`).
