# Agents and MCP

An AI coding agent works on the board as a member in its own right. It is marked `(agent)`
everywhere a person would see its work: presence, the card view, activity and the live feed.

## 1. Issue the agent a token

Board owners only. The agent joins the board under the token's handle. The token can be at most
a member, and only works on this board. Its plaintext is printed once and never stored.

```console
$ yuzie token create claude-agent --agent claude    # add --allow-destructive to let it delete cards
$ yuzie token list                                  # yours, and the ones you issued to agents
$ yuzie token revoke claude-agent
```

## 2. Give it the MCP server

`yuzie mcp` is a stdio MCP server. For Claude Code:

```console
$ claude mcp add yuzie -e YUZIE_TOKEN=yz_… -- yuzie mcp --board payments-api
```

or, in any MCP host's configuration file:

```json
{
  "mcpServers": {
    "yuzie": {
      "command": "yuzie",
      "args": ["mcp", "--board", "payments-api"],
      "env": { "YUZIE_TOKEN": "yz_…" }
    }
  }
}
```

**Which server.** `yuzie mcp` finds its server the way every yuzie command does:
1. `YUZIE_SERVER`;
2. else `server` in the repository's `.yuzie/config.json`;
3. else `server` in your own `~/.yuzie/config.json`;
4. else this machine, where `yuzie serve` runs.

So an agent started in your repository uses your team's server with no extra setting. If its
working directory is elsewhere, add `"YUZIE_SERVER": "https://yuzie.example.com/v1"` to `env`, or
`-e YUZIE_SERVER=…` to `claude mcp add`.

## Tools

| Tool | What it does |
| --- | --- |
| `board_list_cards` | List cards, with filters |
| `board_get_card` | Show one card |
| `board_create_card` | Create a card |
| `board_move_card` | Move a card |
| `board_comment` | Comment on a card |
| `board_update_checklist` | Tick or add checklist items |
| `board_claim_card` | Claim a card: assign it, create and check out its branch (needs `--allow-git`) |
| `board_delete_card` | Delete a card (needs `--allow-destructive`) |

## Guardrails

- **`--allow-git`** lets the agent claim cards. Claiming creates and checks out a branch in the
  agent's checkout. If there is uncommitted work, it refuses rather than stash it.
- **`--allow-destructive`** lets the agent delete cards. It works only if the token was also
  issued with `--allow-destructive`. The server enforces this, not just the MCP process.
- Without these flags, the call is refused with an explanation, and nothing happens.
- Every tool call is written to an audit log on stderr, one JSON line per call.
  `--audit-log <file>` keeps a copy.

## Etiquette

The server's instructions ask the agent to:
- narrate its progress with `board_comment`: what it is about to do, what it did, and what is
  left;
- tick checklist items as it finishes them;
- move the card to review when it is done, rather than to done;
- never delete anything silently. If something should go, it says so in a comment and lets a
  person decide.

From a shell, `yuzie claim 27 --agent` claims a card without ever prompting.

## Without MCP

An agent that can run shell commands can also use the CLI directly. Every command takes `--json`
and prints exactly one JSON document, and every exit code has a meaning (see
[the command reference](commands.md)). The [SDK](sdk.md) is the other route, for programs.
