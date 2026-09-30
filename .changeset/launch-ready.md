---
"@yuzie/cli": minor
"@yuzie/core": minor
"@yuzie/sdk": minor
"@yuzie/store": minor
"@yuzie/git": minor
"@yuzie/mcp": minor
"@yuzie/server": minor
"yuzie": minor
---

Ready to publish (SPEC.md §18 Session 17).

- **`npx yuzie`.** A new unscoped `yuzie` package is the same program as `@yuzie/cli`.
- **Packaging.**
  - Every library ships ES modules and CommonJS, each with its own types.
  - Exports are checked with arethetypeswrong under node16 and bundler resolution.
  - Every package carries repository metadata, and is published with provenance.
- **Tab completion.** `yuzie completion bash|zsh|fish` completes commands, flags, card numbers
  (with titles) and column names. Cards and columns come from the local cache, so completion is
  instant and works offline.
- **Upgrades.**
  - `yuzie upgrade` installs the latest version with whichever package manager installed
    yuzie. `--dry-run` shows the command without running it.
  - Once a day, yuzie mentions a newer version on stderr. It stays quiet under CI, `--json`
    and `--quiet`. Silence it with `YUZIE_NO_UPDATE_CHECK=1` or `ui.updateCheck: false`.
- **Self-hosting.**
  - A server image (`packages/server/Dockerfile`) and a production compose file
    (`deploy/docker-compose.yml`).
  - A guide that CI follows verbatim.
- **Documentation.**
  - A command reference generated from the program; a test keeps it equal to `--help`.
  - Guides for the SDK, agents and MCP, keys, privacy and a FAQ.
  - An animated demo recorded from the real TUI.
- **`yuzie init` when the board name is taken.** On a server where another team already has
  the board name, init now says so and how to pick another, instead of "Check the command
  with `--help`".
- **Server.** A checklist item id that isn't a uuid now answers 404, instead of 500.
