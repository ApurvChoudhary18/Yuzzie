# @yuzie/sdk

The typed client for a [Yuzie](https://github.com/ApurvChoudhary18/Yuzzie) board. The `yuzie`
CLI, its board and its MCP server are all built on it. So can a CI job, an editor extension or a
dashboard be.

```sh
npm install @yuzie/sdk
```

```ts
import { Yuzie } from '@yuzie/sdk/node'

const board = await Yuzie.connect('payments-api', {
  baseUrl: 'https://yuzie.example.com/v1', // default: http://localhost:8787/v1 (`yuzie serve`)
})
board.on('change', (state) => console.log(Object.keys(state.cards).length, 'cards'))

const card = await board.cards.create({ title: 'Fix GitHub OAuth' })
await board.cards.move(card.number, 'doing')
await board.close()
```

- **Live.** `board.state` stays current as anyone changes the board, and `on('change')`,
  `on('presence')` and the other events say when.
- **Typed.** Requests and responses are validated against the same schemas the server uses.
  Errors are classes with a stable `code` (`NotFoundError`, `ConflictError` and so on).
- **Safe to retry.** Every write carries an idempotency key.
- **Anywhere.** `@yuzie/sdk` runs wherever `fetch` and `WebSocket` exist, browsers included.
  `@yuzie/sdk/node` also finds the signed-in token: `YUZIE_TOKEN`, then the OS keychain, then
  `~/.yuzie/credentials`.
- **Both module systems.** ESM and CommonJS, with types for each.

The full reference is [docs/sdk.md](https://github.com/ApurvChoudhary18/Yuzzie/blob/main/docs/sdk.md).

MIT licensed.
