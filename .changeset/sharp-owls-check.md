---
"@yuzie/cli": patch
"@yuzie/core": minor
"@yuzie/server": patch
---

Fixes from an end-to-end audit of Sessions 0–10 against a real server and a real terminal.

- **`@yuzie/cli`**
  - Keys typed while the TUI was starting echoed over the first frame and were lost: raw mode
    is now set at the first paint, and keys that arrive together are each acted on (a real
    paste is told apart by bracketed paste, and is text only in an input).
  - `yuzie --offline` said `synced` in the header; it now says `⚠ offline`.
  - Your own changes no longer toast twice (once from the key, once from the event echo); a
    change saved offline says so.
  - `yuzie share` exists: the `init` receipt told people to run it. It prints how a
    teammate joins (`--json` too).
  - An unknown command says so, with a suggestion (`Did you mean yuzie list?`), instead of
    "too many arguments".
  - The help overlay lines up, and names the arrow keys with arrows.
- **`@yuzie/core`**: a `Share` output envelope.
- **`@yuzie/server`**: with `PORT` set and no `YUZIE_PUBLIC_URL`, the device page is
  advertised on that port, not 8787. `pnpm --filter @yuzie/server start` runs a built server.
