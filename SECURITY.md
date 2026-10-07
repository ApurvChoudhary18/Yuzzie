# Security

## Reporting a vulnerability

Please don't report a security problem in a public issue.

- **Report it privately:** on this repository, Security → **Report a vulnerability**. Only the
  maintainer sees it.
- **If that button isn't there,** open an issue titled "Security contact request", with no
  details, and the maintainer will reach you privately.

Include what an attacker can do, the version (`yuzie --version`), and how to reproduce it. You'll
get an answer within a week. A fix is released before the details are made public.

## In scope

- the `yuzie` CLI, the board, and the MCP server (`yuzie mcp`);
- the server (`@yuzie/server` and its Docker image);
- the SDK and the other `@yuzie/*` packages.

For example:
- a token or other secret leaking (to logs, diagnostic bundles, the terminal or another user);
- someone reaching a board they aren't a member of;
- an agent acting beyond its token's role or flags;
- repository code being sent to the server (see [docs/privacy.md](docs/privacy.md)).

## Supported versions

Fixes go into the latest release. Upgrade with `yuzie upgrade`, or pull the newest server image.
