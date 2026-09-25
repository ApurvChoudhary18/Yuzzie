---
"@yuzie/cli": minor
"@yuzie/core": minor
"@yuzie/server": patch
---

Session 7: the core CLI commands.

- **`@yuzie/cli`**: `add`, `list`, `card`, `move`, `assign`, `done`, `comment`, `edit`, `rm`,
  `watch`/`unwatch`, `check`, `label`, `due`, `priority`, `boards` (create, rename, archive),
  `columns` (add, rm), `members`, `invite`, `who`, `activity`, and `feed`.
  - `yuzie list` reproduces the §7.3 table byte for byte at 80 columns, widens the title on
    wider terminals, and sorts by most recent activity.
  - Card IDs resolve per §7.5: `18`, `#18`, or a title prefix/substring; an ambiguous match
    asks, or exits 4 under `--json`/`--yes`.
  - `--due` understands `friday`, `tomorrow`, `+3d`, `next monday` and ISO dates.
  - `yuzie edit` opens the card in `$EDITOR` as YAML front matter + markdown and sends only
    what changed, guarded by the card's version.
  - `yuzie feed` streams live events one per line (NDJSON under `--json`) until Ctrl-C.
- **`@yuzie/core`**: a schema for every `--json` document the CLI prints (`OUTPUT_ENVELOPES`,
  `parseOutput`).
- **`@yuzie/server`**: a board created with a custom column list now recognises the standard
  names — so the Done column of a board made by `yuzie init` is actually treated as done.
