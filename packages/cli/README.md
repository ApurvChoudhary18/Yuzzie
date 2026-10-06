# @yuzie/cli

**A real-time, Git-aware kanban board for your team, in your terminal.**

This is the `yuzie` program (`yz` for short). The unscoped [`yuzie`](https://www.npmjs.com/package/yuzie)
package is the same thing under a shorter name.

```sh
npm install -g @yuzie/cli     # or: npx yuzie@latest …
```

It needs Node 22 or later, git, and a Yuzie server. `yuzie serve` runs one on your machine, and
the CLI looks there by default. For a team, point everyone at a shared server with
`YUZIE_SERVER`; the [self-hosting guide](https://github.com/ApurvChoudhary18/Yuzzie/blob/main/docs/self-hosting.md)
takes two minutes.

```sh
yuzie init                    # in a git repository: sign in, create a board, install hooks
yuzie add "Fix GitHub OAuth"
yuzie claim 1                 # assign yourself, create and check out task/1-fix-github-oauth
yuzie                         # the live board; ? shows the keys
```

Every command takes `--json` and prints exactly one JSON document, and exit codes are stable, so
yuzie composes with scripts and pipes.

- [Command reference](https://github.com/ApurvChoudhary18/Yuzzie/blob/main/docs/commands.md)
- [Keys in the board](https://github.com/ApurvChoudhary18/Yuzzie/blob/main/docs/keybindings.md)
- [FAQ](https://github.com/ApurvChoudhary18/Yuzzie/blob/main/docs/faq.md)
- [Privacy](https://github.com/ApurvChoudhary18/Yuzzie/blob/main/docs/privacy.md): no repository
  code ever leaves your machine.

MIT licensed.
