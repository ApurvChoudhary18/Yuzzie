# The SDK: `@yuzie/sdk`

Everything the CLI and the board do goes through this typed client, so it can also drive
a CI job, a VS Code extension, a web dashboard or an agent.

```console
$ npm install @yuzie/sdk
```

It ships as ESM and CommonJS, with types for both, and runs on Node 22+ and in browsers.

| Import | Where | What |
| --- | --- | --- |
| `@yuzie/sdk` | anywhere with `fetch` and `WebSocket` | The client. Nothing Node-specific. |
| `@yuzie/sdk/node` | Node | Everything above. `Yuzie.connect` finds a token by itself: `YUZIE_TOKEN`, then the OS keychain, then `~/.yuzie/credentials`. |
| `@yuzie/sdk/websocket` | Node | `nodeWebSocket`, a WebSocket factory for Node versions without a global one. |

## Open a board

```ts
import { Yuzie } from '@yuzie/sdk/node'

const board = await Yuzie.connect('payments-api', {
  baseUrl: 'https://yuzie.example.com/v1', // default: https://api.yuzie.dev/v1
})

board.on('change', (state) => console.log(Object.keys(state.cards).length, 'cards'))
board.on('presence', (people) => console.log(people.map((p) => p.handle)))

const card = await board.cards.create({ title: 'Fix GitHub OAuth', column: 'todo' })
await board.cards.move(card.number, 'doing')
await board.cards.comment(card.number, 'Started on the callback handler')

await board.close()
```

`connect` loads cached state if you give it a cache, fetches the server's state and starts
streaming. Afterwards `board.state` always holds the current board: `board`, `columns`,
`labels`, `members`, `cards` (keyed by card number) and `seq`. It updates on every change
anyone makes. `on(...)` returns a function that unsubscribes.

## The client

`createClient(options)` (or `Yuzie.client(options)`) returns the account-level API:

| Call | What it does |
| --- | --- |
| `health()` | `{ version, latencyMs }`: is the server there, and how far away. |
| `me()` | The signed-in user. |
| `boards.list()`, `boards.create({ name, … })` | Your boards. |
| `tokens.list()`, `tokens.create({ … })`, `tokens.revoke(id)`, `tokens.revokeCurrent()` | API tokens. A token's plaintext is returned once, at creation. |
| `auth.start()`, `auth.poll(deviceCode)` | Device-code sign-in: show `userCode`, and poll until it is approved. |
| `connect(slug, options)` | Open a board (above). |
| `board(slug, options)` | A board that is not open yet. `open()` paints from cache before the network answers. |

Client options: `token`, `baseUrl`, `fetch` (any fetch-compatible function), `client` (names
the caller to the server, e.g. `ci/1.0`), and `retries` (default 3; covers 5xx, 429 and network
errors).

Board options add:
- `realtime` (default on);
- `webSocket` (a factory);
- `cache` (`openCache()` from `@yuzie/store` in Node);
- `offline`: `'queue'` keeps writes in an outbox while offline, `'fail'` throws;
- `connectTimeoutMs`;
- `reachabilityTimeoutMs`.

## Board resources

| Resource | Calls |
| --- | --- |
| `board.cards` | `list(filter)`, `listLocal(filter)`, `get(n)`, `create(input)`, `update(n, fields)`, `move(n, column, { before, after })`, `assign(n, …)`, `comment(n, body)`, `check(n, item, done)`, `addChecklistItem(n, text)`, `delete(n)`, `watch(n, on)`, `linkBranch(n, branch)`, `updateGit(n, summary)`, `attachCommits(n, commits)`, `setAnchor(n, anchor)` |
| `board.boards` | `get()`, `update(fields)`, `archive()`, `addColumn(column)`, `removeColumn(key)`, `events(since)`, `activity(query)`, `presence()` |
| `board.members` | `list()`, `invite({ handle, role })` |
| `board.comments` | `list(n)`, `create(n, body)` |

`CardFilter` takes any of:
- `column`
- `assignee`
- `label`
- `search`
- `mine`
- `watching`
- `stale` (a duration such as `3d`)
- `limit`

## Events

`board.on(type, handler)`:

| Event | Payload | When |
| --- | --- | --- |
| `change` | `BoardState` | After anything changes the board. |
| `*` | `EventEnvelope` | Every event from the server, as it arrives. |
| `presence` | `Presence[]` | Someone opens or leaves the board, or changes what they are looking at. |
| `status` | `'connecting' \| 'live' \| 'reconnecting' \| 'closed'` | The live connection changes. |
| `conflict` | `{ cardNo, error, current }` | A queued offline write lost to a newer change. |
| `rejected` | `{ op, error }` | The server refused a queued write. |
| `error` | `Error` | Anything else that went wrong in the background. |

## Errors

Every failure is a `BoardError` subclass with a stable `code`, an HTTP `status`, an `exitCode`
and `suggestedFix`:
- `AuthenticationError`
- `PermissionError`
- `NotFoundError`
- `ConflictError`
- `ValidationError`
- `RateLimitError`
- `WipLimitError`
- `OfflineError`
- `InternalError`

```ts
import { ConflictError } from '@yuzie/sdk'

try {
  await board.cards.update(18, { title: 'Rate limits' })
} catch (error) {
  if (error instanceof ConflictError) await board.refresh()
  else throw error
}
```

Writes are idempotent. Every mutation carries an idempotency key, so a retry after a timeout
never applies the same change twice.
