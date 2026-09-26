---
"@yuzie/cli": minor
"@yuzie/sdk": patch
---

Session 10: realtime in the TUI (SPEC.md §6.4, §8.5).

- **`@yuzie/cli`**
  - Live updates are coalesced into at most 20 renders a second, however fast events arrive;
    keys are never held up by them.
  - Presence (§8.5): the header counts who is online and working; the card view says who is
    viewing or working on the card; agents are marked `(agent)`; recently pushed commits
    show a `↑3` badge for ten minutes.
  - Your own presence: viewing the open card, working when the checked-out branch belongs to
    a card you claimed, re-sent after a reconnect, cleared on exit.
  - Toasts queue (at most three), and each waiting toast still gets a second on screen.
  - The header shows `synced`, `⚠ reconnecting…` or `⚠ offline · N queued`. Writes made
    while offline are sent automatically once the server is back.
  - Moved cards flash once. A change the server refused shows `⟳ updated by @x`, as does a
    card someone else just changed while you have it open.
- **`@yuzie/sdk`**: the realtime client now keeps reconnecting when a connection attempt
  fails with an error and no close event. Node's built-in WebSocket reports a refused
  connection that way, so before this a restarted server was never reconnected to.
