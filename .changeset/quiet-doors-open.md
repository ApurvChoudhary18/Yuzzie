---
"@yuzie/cli": minor
"@yuzie/git": minor
"@yuzie/sdk": minor
"@yuzie/server": minor
---

Session 6: the CLI skeleton — `yuzie init`, `login`, `logout`, `whoami`, `doctor`, `config`, `hooks`.

- **`@yuzie/cli`**: commander program with every global flag from §7.1. Layered, zod-validated
  config (defaults < `~/.yuzie/config.json` < `.yuzie/config.json` < env < flags) with
  `yuzie config get|set`. One output layer: symbols and colour for people (honouring
  `NO_COLOR`, `--no-color` and pipes), exactly one JSON document on stdout under `--json`,
  spinners only in a terminal, and every exit code from §7.4 decided in one place.
  `yuzie init` reproduces Journey A (§6.1) verbatim and is idempotent.
- **`@yuzie/git`**: repository detection, remote parsing, default-branch detection, and hook
  install/uninstall that preserves existing hooks, honours `core.hooksPath`, and can never
  fail a git command.
- **`@yuzie/sdk`**: `client.health()` and `client.tokens.revokeCurrent()`.
- **`@yuzie/server`**: **security fix** — `POST /auth/device/approve` let anyone approve a
  device code as any existing handle and receive that user's token. Approving for a handle
  with an active token now requires being signed in as that user. Adds `GET /device`, a
  self-contained approval page (strict CSP, no external resources), and
  `DELETE /tokens/current` for `yuzie logout`.
