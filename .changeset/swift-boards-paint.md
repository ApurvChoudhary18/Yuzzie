---
"@yuzie/cli": minor
"@yuzie/sdk": minor
---

Session 8: the TUI board view (SPEC.md §8).

- **`@yuzie/cli`**: `yuzie` with no arguments opens the board full screen.
  - Columns side by side at 100+ columns, a single grouped list below that (§8.6); horizontal
    and vertical scrolling keep the selection in view; a "too small" notice under 30×12.
  - Cards show assignee, presence, commits/files, idle age (⚠ after 3 days in an active
    column), priority and labels; live events appear as a 3-second toast.
  - Every board-view key in §8.4 (`h/j/k/l`, arrows, `gg`, `G`, `1`–`9`, `?`, `q` and the card
    actions). Screens still to come (card view, pickers, search) point to the CLI command.
  - Paints the cached board before loading Ink, so the first frame arrives in ~150 ms without
    touching the network. The TUI is loaded only when needed, so every other command starts
    in about half the time.
  - Colour tiers (truecolor/256/16/none) and an ASCII fallback; `NO_COLOR` and `--no-color`
    are honoured.
  - `q`, Ctrl-C and SIGTERM always restore the terminal and exit, even when the server never
    answers.
- **`@yuzie/sdk`**: `client.board()` returns an unopened board; `open()` fills state from the
  cache before its first network call. A request the caller aborted is no longer retried.
