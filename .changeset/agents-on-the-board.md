---
"@yuzie/core": minor
"@yuzie/server": minor
"@yuzie/mcp": minor
"@yuzie/git": patch
"@yuzie/cli": minor
---

Session 15: agents on the board — scoped tokens and the MCP server.

- **`@yuzie/core`**
  - `ApiToken` gains `agent` and `allowDestructive`.
  - `TokenCreateRequest` gains `agent` (one board, never owner) and `allowDestructive` (agent
    tokens only).
  - `member.joined` carries `kind`.
  - New `ApiTokenList`, `TokenCreated` and `TokenRevoked` envelopes.
- **`@yuzie/server`**
  - A board owner can issue a token to an agent. The first time, this creates the agent user,
    and the agent joins the board with the token's role. The token belongs to the agent, so its
    actions are attributed to it.
  - You can list and revoke the tokens you issued.
  - Agents delete cards only with a token issued with `allowDestructive`.
  - Migration 0005 adds `api_tokens.created_by` and `api_tokens.allow_destructive`.
- **`@yuzie/mcp`**: an MCP stdio server built on `@yuzie/sdk` and the official MCP SDK.
  - Tools: `board_list_cards`, `board_get_card`, `board_create_card`, `board_move_card`,
    `board_comment`, `board_claim_card` and `board_update_checklist`, plus a guarded
    `board_delete_card`.
  - `--allow-git` and `--allow-destructive` guardrails. A call without the flag is refused
    readably.
  - An audit line for every call.
  - Presence while it works.
- **`@yuzie/git`**: `dirtyFiles` ignores Yuzie's own `.yuzie/cache/`.
- **`@yuzie/cli`**
  - `yuzie token create/list/revoke`. The plaintext is shown once, and `--agent`,
    `--allow-destructive`, `--expires` and `--all-boards` are available.
  - `yuzie mcp [--allow-git] [--allow-destructive] [--audit-log]`.
  - `yuzie claim --agent`, which never prompts.
  - Agents are marked `(agent)` in the feed, activity, card details, the TUI card view and
    toasts, and have their own colour on the board.
