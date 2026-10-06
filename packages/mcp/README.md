# @yuzie/mcp

The [Model Context Protocol](https://modelcontextprotocol.io) server that puts an AI coding agent
on a [Yuzie](https://github.com/ApurvChoudhary18/Yuzzie) board, as a member of its own marked
`(agent)`.

You usually run it through the CLI:

```sh
yuzie token create claude-agent --agent claude     # a board owner issues the agent a token
claude mcp add yuzie -e YUZIE_TOKEN=yz_… -- yuzie mcp --board payments-api
```

The agent can list, show, create and move cards, comment on them, and tick checklists. Two
things are off unless you turn them on:
- `--allow-git` lets it claim a card, which creates and checks out the card's branch;
- `--allow-destructive` lets it delete cards. This also needs the token to allow it, and the
  server enforces that.

Every tool call is written as a JSON line to an audit log on stderr.

To embed it instead, `createYuzieMcpServer(options)` returns the server, and
`serveStdio(options)` runs it over stdio.

The guide is [docs/agents.md](https://github.com/ApurvChoudhary18/Yuzzie/blob/main/docs/agents.md).

MIT licensed.
