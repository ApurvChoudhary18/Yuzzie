---
"@yuzie/server": minor
"@yuzie/core": patch
---

Session 3: implement the REST API and persistence.

- Fastify app serving every §12.1 route except the WebSocket stream, mounted under `/v1`,
  plus `/healthz` and `/metrics`.
- Hand-written SQL migrations for §11.2 targeting Postgres, with a SQLite variant for
  self-hosting. A test asserts both dialects produce the same tables and columns in the
  same order.
- Device-code auth with sha256-hashed bearer tokens, membership-scoped authorisation, and
  the §14.2 permission matrix asserted cell by cell.
- Every mutation is serialised on the board row with `SELECT ... FOR UPDATE`, appends its
  events in the same transaction, and validates each event against `@yuzie/core` before
  storing it.
- `Idempotency-Key` middleware with a 24h store, claimed by insert so concurrent retries
  cannot both execute.
- `If-Match` optimistic concurrency returning 409 with the current card state.
- Per-token rate limiting (600 reads/min, 120 writes/min) and the uniform §12.1 error
  envelope on every failure path.

`@yuzie/core`: request bodies now accept a column *reference* as the user typed it
(`REV`), which §7.2 matches case-insensitively by prefix, while entities keep the strict
lowercase column key.
