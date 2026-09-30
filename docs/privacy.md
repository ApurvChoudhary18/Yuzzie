# Privacy

## Your code stays on your machine

**No repository code is ever sent to the server.** Yuzie reads your repository locally, and sends
only:

- **Derived numbers**: how many commits a card's branch has, and how many files it changes.
- **Names**: the branch name, the file path and line of a card's anchor, and the repository's
  remote, e.g. `github.com/acme/payments-api`.
- **Commits you link**: the SHA and message of commits linked to a card. That happens when a
  commit message mentions the card (`#18`) and the post-commit hook is installed. Uninstalling the
  hooks (`yuzie hooks uninstall`) or setting `git.autoLinkCommits` to `false` stops it.

File contents, diffs and anything else from your working tree never leave your machine.

## What the server keeps

Your handle, the boards you belong to and everything on them (cards, comments, checklists and
activity), and hashes of your API tokens. Token plaintext is shown once, when the token is
created, and never stored.

## What stays on your computer

| Where | What |
| --- | --- |
| The OS keychain, or `~/.yuzie/credentials` (mode 0600) | Your sign-in token. |
| `.yuzie/cache/` in each repository (git-ignored) | A cache of the board, and writes made while offline. |
| `~/.yuzie/logs/yuzie.log` | One JSON line per command, rotated at 5 MB. Tokens, passwords and your home directory are redacted. `YUZIE_LOG=off` turns it off. |
| `~/.yuzie/update.json` | When yuzie last checked for a newer version, and what it found. |

## What yuzie sends besides the board

- **The version check.** At most once a day, yuzie asks the npm registry for the latest version
  of `@yuzie/cli`. The request carries no identifier and nothing about you or your board. Any of
  these turn it off:
  - `YUZIE_NO_UPDATE_CHECK=1`
  - `yuzie config set ui.updateCheck false`
  - `--json`, `--quiet`, or a CI environment
- **Telemetry.** There is none. Yuzie collects no usage data.

## Self-hosting

Run the server yourself and your board never leaves your infrastructure. It is one compose file;
see [self-hosting](self-hosting.md).
