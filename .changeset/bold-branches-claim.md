---
"@yuzie/git": minor
"@yuzie/cli": minor
"@yuzie/core": minor
---

Session 11: Git integration and the claim flow (SPEC.md §9, Journey B).

- **`@yuzie/git`**
  - HEAD state (branch, detached or unborn), dirty files, and branch operations: check out,
    track a remote branch, or create from the base.
  - Commits between base and branch, diff stats, upstream state, and the §9.1 summary.
  - Commit→card resolution in §9.6 order: a `Board-Card:` trailer, then `#id`, then the
    branch template, then your one card in progress.
  - Editor resolution with a per-editor line-jump table (§9.7).
  - Fixture repositories for tests, under `@yuzie/git/testing`.
- **`@yuzie/cli`**
  - `yuzie claim`: assigns you, moves the card to Doing, and creates or checks out and links
    the branch, following §9.3. A dirty tree asks whether to stash, stay, or abort; a detached
    HEAD or `--yes` on a dirty tree exits 8. When the server is unreachable, the branch is
    still made and the writes queue.
  - `yuzie start`, `yuzie branch` (`--create`, `--link`) and `yuzie commits`.
  - `yuzie finish`: the six §9.4 checks, with `--push` and `--skip-checks`, then a move to
    Review with the refreshed git summary.
  - The Git hooks work: post-commit links the commit to its card
    (`[yuzie] linked commit a3f9c21 → #18`) within 300 ms, or queues it; pre-push refreshes
    the card's counts. Hooks never fail a Git command.
  - Queued writes are sent before `claim` or `finish` writes more.
  - A numbered question never takes an answer from end of input.
- **`@yuzie/core`**: `Claim`, `Branch`, `CommitList` and `Finish` output envelopes.
