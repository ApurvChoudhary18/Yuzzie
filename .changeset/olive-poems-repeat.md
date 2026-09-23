---
"@yuzie/core": minor
---

Session 1: implement the domain core — the single source of truth for Yuzie, with no I/O.

- `types.ts` — every entity from §11.1, with column keys and handles rather than uuids so a
  domain value and a parsed API body are the same shape.
- `schema.ts` — zod schemas for each entity and each request/response body in §12.1, plus the
  `{ apiVersion, kind, data, meta }` output envelope from §7.3 and the §12.1 error envelope.
  Each entity schema is pinned to its interface with `satisfies z.ZodType<T>`, so the two
  cannot drift.
- `events.ts` — the §12.3 catalogue as a discriminated union over `{ seq, type, actor, cardNo?,
  payload, ts }`, plus the transient presence frames and the `GET /events` replay bodies.
- `reducer.ts` — a pure, immutable, total `applyEvent`. Events at or below the current `seq`
  are ignored, and an event type this build does not know advances `seq` without throwing.
  `applyEvents` sorts by `seq`, so a shuffled replay window converges.
- `rank.ts` — base-62 fractional indexing (`rankBetween`, `rankFirst`, `rankLast`,
  `rebalance`) in an ASCII-ordered alphabet, so string comparison is card order.
- `slug.ts` — `slugify` and `branchFor` per §9.2, ASCII-only with a `card` fallback so an
  emoji or non-Latin title still yields a typeable branch.
- `errors.ts` — one table mapping each §12.1 error code to its HTTP status, its §7.4 exit
  code, and its Appendix C suggested fix, behind typed error classes.
