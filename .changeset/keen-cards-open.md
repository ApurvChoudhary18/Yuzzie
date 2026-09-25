---
"@yuzie/cli": minor
"@yuzie/sdk": minor
---

Session 9: the TUI card view, overlays and editing (SPEC.md §8.3, §8.4).

- **`@yuzie/cli`**
  - `Enter` opens the card view: status, assignees (with presence), priority, watchers, labels,
    due date, description, code anchor, branch and git stats, checklist and activity. It scrolls
    with `j`/`k`, and `esc` goes back.
  - Every mutation is a key away, in both views: `m` column picker, `a` member picker
    (assign/unassign), `C` comment composer (multiline, Ctrl-D sends), `n` new card, `D`
    delete with confirmation, `x` checklist (toggle, `+` to add), `w` watch, `d` done, `/`
    search as you type, `f` filter (mine, an assignee, a label; `esc` clears).
  - `e` edits the card in `$EDITOR`: the TUI steps out of the alternate screen for the editor
    and comes back to a clean redraw, even when the editor exits non-zero.
  - Changes paint immediately with a `◌` marker until the server confirms them. A change the
    server refuses reverts on screen with a `⚠` marker and an explanation.
- **`@yuzie/sdk`**: `board.pendingCards` — the cards with an optimistic write not yet confirmed.
