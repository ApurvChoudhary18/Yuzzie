---
"@yuzie/server": minor
"@yuzie/core": minor
---

Session 4: the realtime gateway (SPEC.md §12.2).

- **`@yuzie/core`**: the stream protocol, defined once for the gateway and the SDK:
  `hello`/`presence`/`ping` client frames, `welcome`/`snapshot`/`event`/`presence`/`pong`
  server frames, `BoardSnapshot`, the `yuzie.v1` sub-protocol with `bearer.<token>` auth,
  and the application close codes.
- **`@yuzie/server`**: `GET /v1/boards/:slug/stream`. Auth on upgrade (401/404 before any
  socket exists); resume by replay up to 500 missed events, snapshot beyond; presence with a
  60 s TTL, broadcast at most 5 Hz; a capped per-connection outbound queue that resets a slow
  client with a snapshot; heartbeat, hello and message-rate limits; at most 2 connections per
  user per board. Fan-out goes through a `PubSub` interface with in-process and Redis
  implementations (`REDIS_URL`). Every client gets every event once, in `seq` order, even
  when the broker drops, duplicates or reorders messages.
- Events now store their `idempotencyKey` (migration 0002), so an event replayed on resume
  can still be matched to the client's own write. `GET /events` returns it too.
- `GET /boards/:slug/presence` returns live presence instead of an empty list.
