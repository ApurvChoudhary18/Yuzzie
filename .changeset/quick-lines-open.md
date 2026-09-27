---
"@yuzie/git": minor
"@yuzie/cli": minor
"@yuzie/core": minor
---

Session 12: code anchors, open in the editor, open in the browser (SPEC.md §9.7, Journey F).

- **`@yuzie/git`**
  - Web URLs from any remote (GitHub, GitLab, Bitbucket, self-hosted; SSH or HTTPS, with ports
    kept where they belong): the branch, the compare view, and the pull request API.
  - Anchors are normalised to the repository root and checked against the file. Staleness is
    judged against the commit the anchor was made at.
- **`@yuzie/cli`**
  - `yuzie anchor <id> <file:line[-end]>`.
  - `yuzie open <id>` opens `$EDITOR` at the line. `--github` opens the PR or compare view,
    `--pr` the pull request, and `--browser` a link on the card. PRs are found through `gh`,
    then the GitHub API; if both fail, it falls back to the compare view without an error.
  - With no terminal, or under CI, `open` prints the target instead of opening it.
  - An unknown `$EDITOR` fails with a clear message and exit 1.
  - `yuzie card` shows `Code` before `Branch`, and `⚠ may be stale` when the file has changed.
  - In the TUI, `o` and `g` go through the same code as `yuzie open`, and `c` runs
    `yuzie claim`. The card view flags stale anchors.
- **`@yuzie/core`**: the `Open` output envelope.
