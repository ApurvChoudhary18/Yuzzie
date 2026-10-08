# FAQ

**What do I need?**
Node 22 or newer, and git. `npx yuzie@latest` runs it without installing anything. To install
it, use `npm install -g yuzie` (or `@yuzie/cli`, the same program), which puts `yuzie` and `yz`
on your PATH.

**How do I try it without a server?**
Run `yuzie serve`. It starts the server on this machine, on port 8787:
- With `DATABASE_URL` set, it uses that Postgres.
- Otherwise, if Docker is running, it starts a Postgres container for itself
  (`yuzie-serve-postgres`).

The CLI looks there by default, so nothing else needs setting. For a team, [self-host](self-hosting.md)
it properly, and point everyone at it with `YUZIE_SERVER`. `yuzie init` records the server in `.yuzie/config.json` for everyone who clones the
repository.

**How do I move cards in or out?**
`yuzie import <file>` creates cards from:
- a markdown checklist: `## Column` headings, then `- [ ] title` items;
- a CSV with a `title` column, plus any of `column`, `assignees`, `labels`, `priority`, `due`
  and `description`;
- JSON: a yuzie export, or a list of cards.

Run `--dry-run` first to see what it will do. Columns and people the board doesn't have are
reported, not guessed. `yuzie export` writes JSON (everything), markdown or CSV, and an export
imports straight back into another board.

**A repository should use a different board.**
`yuzie link <board>` points the repository at a board you are already on. `yuzie unlink`
detaches it, and the board stays on the server.

**Does it work offline?**
Yes. Writes made offline are queued in `.yuzie/cache/`, shown as pending, and sent when the
connection returns. `yuzie sync` sends them now and reports conflicts. `--offline` forces
offline mode for one command.

**Can scripts use it?**
Every command takes `--json` and prints exactly one JSON document to stdout. Exit codes are
stable:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Something else went wrong |
| 2 | Usage |
| 3 | Not signed in |
| 4 | Not found |
| 5 | Forbidden |
| 6 | Conflict |
| 7 | Offline |
| 8 | Git precondition |
| 130 | Interrupted |

See [the command reference](commands.md).

**Why didn't my commit link to the card?**
Commits are linked by the post-commit hook, which runs the `yuzie` on your PATH. With `npx` alone
there is no `yuzie` on the PATH, and the hooks quietly do nothing. Install yuzie globally, or run
`yuzie sync` to link commits by hand. `yuzie doctor` says whether the hooks are installed.

**How do I get Tab completion?**
Add one line to your shell's startup file:
- bash: `eval "$(yuzie completion bash)"` in `~/.bashrc`
- zsh: `eval "$(yuzie completion zsh)"` in `~/.zshrc`
- fish: `yuzie completion fish | source` in `~/.config/fish/config.fish`

It completes commands, flags, card numbers (with their titles) and column names, from the local
cache, so it is instant and works offline.

**How do I upgrade?**
Run `yuzie upgrade`. It uses whichever package manager installed yuzie. Under `npx`,
`npx yuzie@latest` always runs the newest version. Once a day yuzie mentions a newer version on
stderr. Turn that off with `YUZIE_NO_UPDATE_CHECK=1` or `yuzie config set ui.updateCheck false`.

**"Someone on this server already has a board named …"**
Board names are unique per server. Run `yuzie init` again and choose another name, or ask the
board's owner to `yuzie invite` you.

**Something is wrong. What do I send?**
- `yuzie doctor` checks node, git, sign-in, the server, the hooks and the cache, and gives the
  command that fixes each problem.
- `yuzie doctor --bundle` writes a redacted diagnostic file. Read it, then attach it to an
  issue.

**Can an AI agent use the board?**
Yes, as a member marked `(agent)`, through `yuzie mcp`. See [agents](agents.md).

**Where is my data?**
See [privacy](privacy.md).

**How do I remove yuzie?**
- **From a repository:**
  1. `yuzie hooks uninstall` takes out the git hooks.
  2. `yuzie unlink` detaches the board. The board stays on the server.
  3. Delete `.yuzie/` if you don't want its config or cache either.
- **From your machine:**
  1. `yuzie logout` revokes your token on the server and forgets it here.
  2. `npm uninstall -g yuzie` (or `@yuzie/cli`) removes the program.
  3. `rm -rf ~/.yuzie` removes your settings and logs.
- **The `yuzie serve` database:**
  `docker rm -f yuzie-serve-postgres && docker volume rm yuzie-serve-data`.
- **Your account on a server:** `yuzie account delete`. See [privacy](privacy.md).
